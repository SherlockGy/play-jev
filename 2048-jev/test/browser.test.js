import test from 'node:test';
import assert from 'node:assert/strict';
import { GameBrowser } from '../src/browser.js';

test('首次连接新开 Chrome 游戏标签，重连不刷新或另开一局', async () => {
  const browser = new GameBrowser();
  const calls = [];
  const game = { score: 512 };
  browser.connect = async () => {};
  browser.read = async () => game;
  browser.show = async () => {};
  browser.call = async (name, args) => calls.push({name, ...args});
  assert.equal(await browser.open(), game);
  assert.equal(await browser.open(), game);
  assert.deepEqual(calls, [{name:'browser_tabs', action:'new', url:'https://2048.io/'}]);
});

test('显示游戏只置前已有页面，不打开网址；不支持时明确报错', async () => {
  const browser = new GameBrowser();
  browser.toolNames.add('browser_run_code');
  let sent;
  browser.call = async (name, args) => { sent = {name, ...args}; };
  await browser.show();
  assert.equal(sent.name, 'browser_run_code');
  assert.match(sent.code, /page.bringToFront/);
  assert.doesNotMatch(sent.code, /goto|newPage/);
  browser.toolNames.clear();
  await assert.rejects(browser.show(), /不支持显示已有标签页/);
});

test('读取当前标签页，忽略其他标签页的共享存档和分数动画', async () => {
  const { runInNewContext } = await import('node:vm');
  const { readGamePage } = await import('../src/browser.js');
  const tile = value => ({ className: 'tile tile-position-1-1', querySelector: () => ({ textContent: String(value) }) });
  const state = runInNewContext(`(${readGamePage.toString()})()`, {
    location: { origin: 'https://2048.io' },
    localStorage: { getItem: () => { throw new Error('不应读取共享存档'); } },
    document: { querySelector: selector => ({
      '.tile-container': { querySelectorAll: () => [tile(2), tile(4)] },
      '.score-container': { childNodes: [{ nodeType: 3, textContent: '16' }, { nodeType: 1, textContent: '+4' }] },
      '.game-message': { classList: { contains: () => false } },
    })[selector] },
  });
  assert.equal(state.board[0][0], 4);
  assert.equal(state.score, 16);
  assert.equal(state.over, false);
});

test('关闭连接后清除标签和工具状态，允许重新建立连接', async () => {
  const browser = new GameBrowser();
  browser.opened = true;
  browser.toolNames.add('browser_tabs');
  browser.client = { close: async () => {} };
  browser.transport = { close: async () => {} };
  await browser.close();
  assert.equal(browser.opened, false);
  assert.equal(browser.transport, null);
  assert.equal(browser.toolNames.size, 0);
});
