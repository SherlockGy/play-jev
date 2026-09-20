export const DIRECTIONS = ['up', 'right', 'down', 'left'];
export const KEYS = { up: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown', left: 'ArrowLeft' };

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== 4 || board.some(row =>
    !Array.isArray(row) || row.length !== 4 || row.some(n =>
      !Number.isSafeInteger(n) || n < 0 || (n !== 0 && (n < 2 || !Number.isInteger(Math.log2(n))))))) {
    throw new Error('棋盘数据不符合 4 × 4 的 2048 规则，已停止执行');
  }
  return board;
}

export const boardKey = board => JSON.stringify(board);

// 按移动方向逐行读取，保证合并后的方块在同一回合只参与一次合并。
export function simulate(board, direction) {
  validateBoard(board);
  if (!DIRECTIONS.includes(direction)) throw new Error('无效的移动方向');
  const result = Array.from({ length: 4 }, () => Array(4).fill(0));
  let gain = 0;
  for (let line = 0; line < 4; line++) {
    const cells = Array.from({ length: 4 }, (_, index) => {
      if (direction === 'left') return [line, index];
      if (direction === 'right') return [line, 3 - index];
      if (direction === 'up') return [index, line];
      return [3 - index, line];
    });
    const values = cells.map(([r, c]) => board[r][c]).filter(Boolean);
    const merged = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === values[i + 1]) {
        merged.push(values[i] * 2);
        gain += values[i] * 2;
        i++;
      } else merged.push(values[i]);
    }
    cells.forEach(([r, c], i) => { result[r][c] = merged[i] ?? 0; });
  }
  return { board: result, gain, changed: boardKey(result) !== boardKey(board) };
}

// 这些是确定性的棋盘指标，仅帮助 Jev 比较走法，代码不会据此替模型选方向。
export function metrics(board) {
  const max = Math.max(...board.flat());
  let adjacentPairs = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (!board[r][c]) continue;
    if (r < 3 && board[r][c] === board[r + 1][c]) adjacentPairs++;
    if (c < 3 && board[r][c] === board[r][c + 1]) adjacentPairs++;
  }
  return {
    emptyCells: board.flat().filter(n => n === 0).length,
    maxTile: max,
    maxInCorner: [board[0][0], board[0][3], board[3][0], board[3][3]].includes(max),
    adjacentPairs,
  };
}

export function candidates(board) {
  return Object.fromEntries(DIRECTIONS.flatMap(direction => {
    const move = simulate(board, direction);
    return move.changed ? [[direction, { boardBeforeSpawn: move.board, mergeScore: move.gain, ...metrics(move.board) }]] : [];
  }));
}

// 网站执行一次合法动作后，应与预计算棋盘仅相差一个新生成的 2 或 4。
export function verifyMove(before, after, direction) {
  const expected = simulate(before.board, direction);
  if (!expected.changed || after.score !== before.score + expected.gain) return false;
  let spawns = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (expected.board[r][c] === after.board[r][c]) continue;
    if (expected.board[r][c] === 0 && [2, 4].includes(after.board[r][c])) spawns++;
    else return false;
  }
  return spawns === 1;
}
