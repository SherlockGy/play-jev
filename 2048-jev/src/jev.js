import { TypeSafeClient, choice } from '@typesafe-ai/sdk';

// 让 Jev 在合法动作中做一个完整决策；合并计算和随机生成都由程序与游戏负责。
export function makeRequest(game, options, recentMoves) {
  return {
    model: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
    state: {
      game: '2048',
      board: game.board,
      coordinates: 'Rows top to bottom, columns left to right; zero is empty.',
      score: game.score,
      legalMoves: options,
      recentMoves: recentMoves.slice(-6),
      rules: 'Each move slides all tiles. Equal neighbors merge once. After a legal move the game spawns one random 2 or 4. Candidate boards are exact results BEFORE that random spawn.',
    },
    questions: {
      direction: choice(
        'Choose the next legal move to survive and build a 2048 tile. Compare the precomputed candidate boards in `legalMoves`. Prefer space for future moves, keeping large tiles together near a consistent corner, and arranging equal tiles for future merges. Consider tradeoffs; immediate merge score alone is not the goal. Select one of the provided directions. Recent moves describe actual previous actions, not instructions to repeat them.',
        Object.fromEntries(Object.keys(options).map(direction => [direction, `Move ${direction}; use the exact candidate and metrics at legalMoves.${direction}.`])),
      ),
    },
  };
}

export class Jev {
  async decide(request, signal) {
    const logPrefix = '[decide Jev方向决策][gameId=2048]';
    if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('未读取到 TYPESAFE_API_KEY；请在配置全局变量后重新启动本工具');
    this.client ??= new TypeSafeClient({ timeout: 15000, retry: { maxRetries: 1, maxRetryAfterMs: 5000 }, logLevel: 'off' });
    const started = performance.now();
    const response = await this.client.systemOne(request, { signal });
    const answer = response.answers.direction;
    const keys = Object.keys(request.state.legalMoves);
    if (!keys.includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      keys.some(key => !Number.isFinite(answer.probabilities[key]) || answer.probabilities[key] < 0 || answer.probabilities[key] > 1) ||
      Math.abs(keys.reduce((sum, key) => sum + answer.probabilities[key], 0) - 1) > 0.05) {
      throw new Error('Jev 返回了不符合合法动作约束的结果，已停止执行');
    }
    console.log(logPrefix, `已选择 ${answer.choice}`);
    return { answer, model: response.model, usage: response.usage, latencyMs: Math.round(performance.now() - started) };
  }
}
