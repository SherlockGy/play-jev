import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/runner.js';

const game = { board: [[2,2,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], score:0, over:false, won:false };
const moved = { ...game, board:[[4,0,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], score:4 };
const decision = { answer:{ choice:'left',confidence:0.7,probabilities:{left:0.8,right:0.1,down:0.1} }, usage:{input_tokens:100,output_tokens:20}, model:'test-double',latencyMs:1 };

// 此文件只使用测试替身验证流程控制，结果不作为 Jev 的实际能力展示。
async function fixture(t, decide = async () => decision) {
  const dir = await mkdtemp(join(tmpdir(), '2048-jev-test-'));
  t.after(() => rm(dir, { recursive:true,force:true }));
  let count = 0;
  const browser = { read:async () => structuredClone(count ? moved : game), move:async () => { count++; } };
  const runner = new Runner(browser, { decide }, dir);
  runner.state.connected = true;
  return { runner, browser, count: () => count };
}

test('连续运行达到步数上限后停止，保存真实执行校验和用量', async t => {
  const { runner, count } = await fixture(t);
  runner.start({steps:1,interval:0});
  await runner.task;
  assert.equal(count(),1);
  assert.equal(runner.state.steps,1);
  assert.equal(runner.state.latest.verified,true);
  assert.equal(runner.state.inputTokens,100);
  assert.equal(runner.state.phase,'paused');
});

test('推理期间暂停，迟到的模型返回不会触发按键', async t => {
  let release;
  const returned = new Promise(resolve => { release = resolve; });
  const { runner, count } = await fixture(t, () => returned);
  const waiting = new Promise(resolve => runner.on('update', state => { if (state.phase === 'decide') resolve(); }));
  runner.start({steps:5,interval:0});
  await waiting;
  runner.pause();
  release(decision);
  await runner.task;
  assert.equal(count(),0);
  assert.equal(runner.state.running,false);
});

test('推理期间棋盘变化，丢弃旧决策并停止', async t => {
  const { runner, browser, count } = await fixture(t);
  let reads=0;
  browser.read=async()=> structuredClone(++reads === 1 ? game : moved);
  runner.start({steps:1,interval:0});
  await runner.task;
  assert.equal(count(),0);
  assert.equal(runner.state.phase,'error');
  assert.match(runner.state.message,/棋盘发生变化/);
});

test('API 失败不使用规则或随机方向兜底，执行重入被拒绝', async t => {
  const { runner, count } = await fixture(t, async()=>{throw new Error('服务不可用');});
  runner.start({steps:3,interval:0});
  assert.throws(()=>runner.start(),/已有操作/);
  await runner.task;
  assert.equal(count(),0);
  assert.equal(runner.state.phase,'error');
});

test('默认上限为 2000 步且不添加额外等待', async t => {
  const {runner} = await fixture(t);
  runner.start();
  assert.equal(runner.state.runLimit, 2000);
  assert.equal(runner.state.interval, 0);
  runner.pause();
  await runner.task;
});

test('运行中调到最快立即结束额外等待', async t => {
  const {runner} = await fixture(t);
  runner.abort = new AbortController();
  runner.state.running = true;
  runner.setInterval(10000);
  const wait = runner.waitInterval();
  assert.equal(typeof runner.wakeDelay, 'function');
  runner.setInterval(0);
  await wait;
  assert.equal(runner.wakeDelay, null);
  assert.throws(() => runner.setInterval(-1), /额外等待/);
  assert.throws(() => runner.setInterval(1.5), /额外等待/);
});

test('单步保留已配置的速度，完成后不等待额外间隔', async t => {
  const { runner } = await fixture(t);
  runner.setInterval(10000);
  runner.start({ steps: 1 });
  await runner.task;
  assert.equal(runner.state.interval, 10000);
  assert.equal(runner.state.steps, 1);
});
