import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { GameBrowser, readGamePage } from '../src/browser.js';

// 手动推进浏览器帧，复现后台暂停及方块位置晚一帧更新的行为。
function pageFixture() {
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  const state = { position: 'tile tile-position-3-4', reads: 0 };
  const document = {
    visibilityState: 'visible',
    querySelector(selector) {
      state.reads++;
      if (selector === '.tile-container') return {
        querySelectorAll: () => [{ className: state.position, querySelector: () => ({ textContent: '2' }) }],
      };
      if (selector === '.score-container') return { childNodes: [{ nodeType: 3, textContent: '0' }] };
      return null;
    },
  };
  const context = {
    location: { origin: 'https://2048.io' }, document,
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, ms) { const id = ++nextId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  return {
    state, context, frames, timers,
    read: () => runInNewContext(`(${readGamePage.toString()})()`, context),
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => callback());
    },
    timeout() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach(({ callback }) => callback());
    },
  };
}

test('等到第二帧位置更新后才读取棋盘，不返回原位置', async () => {
  const page = pageFixture();
  const pending = page.read();
  assert.equal(page.state.reads, 0);
  page.frame();
  assert.equal(page.state.reads, 0);

  page.state.position = 'tile tile-position-3-1';
  page.frame();
  const game = await pending;
  assert.equal(game.board[0][2], 2);
  assert.equal(game.board[3][2], 0);
  assert.equal(page.frames.size, 0);
  assert.equal(page.timers.size, 0);
});

test('后台不渲染或只渲染一帧时，超时拒绝旧棋盘并清理等待', async t => {
  for (const renderedFrames of [0, 1]) {
    await t.test(`已渲染 ${renderedFrames} 帧`, async () => {
      const page = pageFixture();
      const pending = page.read();
      const rejected = assert.rejects(pending, /游戏页面渲染超时/);
      if (renderedFrames) page.frame();
      page.context.document.visibilityState = 'hidden';
      assert.equal([...page.timers.values()][0].ms, 2000);
      page.timeout();
      await rejected;
      assert.equal(page.state.reads, 0);
      assert.equal(page.frames.size, 0);
      assert.equal(page.timers.size, 0);
    });
  }
});

test('读取前再次切入后台时拒绝返回棋盘', async () => {
  const page = pageFixture();
  const pending = page.read();
  page.frame();
  page.context.document.visibilityState = 'hidden';
  page.frame();
  await assert.rejects(pending, /游戏页面已进入后台/);
  assert.equal(page.state.reads, 0);
  assert.equal(page.timers.size, 0);
});

test('错误来源在等待渲染前拒绝', async () => {
  const page = pageFixture();
  page.context.location.origin = 'https://example.com';
  await assert.rejects(page.read(), /当前页面不是 2048.io/);
  assert.equal(page.frames.size, 0);
  assert.equal(page.timers.size, 0);
});

test('从后台读取时先置前再读取完成渲染的棋盘，兼容两种 MCP 工具名', async t => {
  for (const tool of ['browser_run_code', 'browser_run_code_unsafe']) {
    await t.test(tool, async () => {
      const page = pageFixture();
      page.context.document.visibilityState = 'hidden';
      const browser = new GameBrowser();
      browser.toolNames.add(tool);
      let shown = 0;
      browser.call = async (name, args) => {
        if (name === tool) return runInNewContext(`(${args.code})`, {} )({
          url: () => 'https://2048.io/',
          bringToFront: async () => { shown++; page.context.document.visibilityState = 'visible'; },
        });
        assert.equal(name, 'browser_evaluate');
        assert.equal(page.context.document.visibilityState, 'visible');
        const pending = runInNewContext(`(${args.function})()`, page.context);
        page.frame();
        page.state.position = 'tile tile-position-3-1';
        page.frame();
        return { content: [{ type: 'text', text: JSON.stringify(await pending) }] };
      };
      const game = await browser.read();
      assert.equal(shown, 1);
      assert.equal(game.board[0][2], 2);
      assert.equal(game.board[3][2], 0);
    });
  }
});

test('按键和重新开始前置前游戏，重开后的读取复用有超时的等待', async () => {
  const browser = new GameBrowser();
  const calls = [];
  browser.show = async () => { calls.push('show'); };
  browser.call = async (name, args) => {
    if (name === 'browser_press_key') {
      assert.equal(args.key, 'ArrowLeft');
      calls.push('key');
      return;
    }
    assert.equal(name, 'browser_evaluate');
    // 重开按钮只负责触发操作，不再在隐藏页面中无超时地等待动画帧。
    await runInNewContext(`(${args.function})()`, {
      location: { origin: 'https://2048.io' },
      document: { querySelector: () => ({ click: () => calls.push('restart') }) },
    });
  };
  browser.read = async () => { calls.push('read'); return { score: 0 }; };
  await browser.move('left');
  assert.deepEqual(calls, ['show', 'key']);
  calls.length = 0;
  assert.equal((await browser.restart()).score, 0);
  assert.deepEqual(calls, ['show', 'restart', 'read']);

  calls.length = 0;
  await assert.rejects(browser.move('invalid'), /禁止执行未知动作/);
  assert.deepEqual(calls, []);
  browser.show = async () => { throw new Error('页面不匹配'); };
  await assert.rejects(browser.move('left'), /页面不匹配/);
  assert.deepEqual(calls, []);
});
