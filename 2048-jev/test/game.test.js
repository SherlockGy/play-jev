import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, candidates, verifyMove, validateBoard } from '../src/game.js';
import { decodeResult } from '../src/browser.js';

const boardWithRow = row => [row, [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

test('连续相同方块只合并一次，跳过空格后才判定相邻', () => {
  assert.deepEqual(simulate(boardWithRow([2, 2, 2, 2]), 'left').board[0], [4, 4, 0, 0]);
  assert.deepEqual(simulate(boardWithRow([2, 2, 4, 0]), 'left').board[0], [4, 4, 0, 0]);
  assert.deepEqual(simulate(boardWithRow([2, 0, 2, 2]), 'right').board[0], [0, 0, 2, 4]);
  assert.equal(simulate(boardWithRow([4, 4, 8, 8]), 'left').gain, 24);
});

test('上下方向和行列坐标一致', () => {
  const board = [[2, 0, 0, 0], [2, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]];
  assert.deepEqual(simulate(board, 'up').board.map(row => row[0]), [4, 8, 0, 0]);
  assert.deepEqual(simulate(board, 'down').board.map(row => row[0]), [0, 0, 4, 8]);
});

test('合法动作排除无变化方向，满盘仍可能有合并', () => {
  assert.deepEqual(Object.keys(candidates(boardWithRow([2, 0, 0, 0]))), ['right', 'down']);
  const terminal = [[2,4,2,4],[4,2,4,2],[2,4,2,4],[4,2,4,2]];
  assert.equal(Object.keys(candidates(terminal)).length, 0);
  terminal[0][0] = 4;
  assert.ok(Object.keys(candidates(terminal)).length > 0);
});

test('验证动作必须包含准确得分和恰好一个随机新方块', () => {
  const before = { board: boardWithRow([2,2,0,0]), score: 8 };
  const after = { board: boardWithRow([4,0,2,0]), score: 12 };
  assert.equal(verifyMove(before, after, 'left'), true);
  assert.equal(verifyMove(before, { ...after, score: 16 }, 'left'), false);
  assert.equal(verifyMove(before, { ...after, board: boardWithRow([4,0,0,0]) }, 'left'), false);
  assert.equal(verifyMove(before, { ...after, board: boardWithRow([4,2,2,0]) }, 'left'), false);
});

test('随机棋盘移动守恒、结果不变时排除，并且不修改输入', () => {
  let seed = 2048;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 200; i++) {
    const board = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => [0,2,4,8,16][Math.floor(random()*5)]));
    const original = JSON.stringify(board);
    for (const direction of ['up','right','down','left']) {
      const result = simulate(board, direction);
      assert.equal(result.board.flat().reduce((a,b)=>a+b,0), board.flat().reduce((a,b)=>a+b,0));
      assert.equal(result.changed, JSON.stringify(result.board) !== original);
    }
    assert.equal(JSON.stringify(board), original);
  }
});

test('拒绝损坏的棋盘和 MCP 错误返回', () => {
  assert.throws(() => validateBoard([[3]]));
  assert.throws(() => validateBoard(boardWithRow([1,0,0,0])));
  assert.throws(() => decodeResult({ isError: true, content: [{ type: 'text', text: '页面不存在' }] }), /页面不存在/);
  assert.deepEqual(decodeResult({ content: [{ type:'text', text:'### Result\n{"score":4}\n### Ran Playwright code\ncode' }] }), { score:4 });
});
