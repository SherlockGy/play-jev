import { safeError } from './errors.js';
import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { boardKey, candidates, verifyMove } from './game.js';
import { makeRequest } from './jev.js';
import { ROOT } from './browser.js';

export class Runner extends EventEmitter {
  constructor(browser, jev, traceRoot = join(ROOT, 'artifacts')) {
    super();
    this.browser = browser;
    this.jev = jev;
    this.traceRoot = traceRoot;
    this.busy = false;
    this.state = {
      sessionId: randomUUID(), connected: false, running: false, phase: 'idle', message: '连接游戏，观察 Jev 的第一步判断。',
      game: null, steps: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, history: [], latest: null,
      interval: 0, runLimit: 2000,
      keyReady: Boolean(process.env.TYPESAFE_API_KEY?.trim()), mcpMode: process.env.PLAYWRIGHT_MCP_URL ? 'HTTP MCP' : 'stdio MCP',
    };
  }

  update(patch) { Object.assign(this.state, patch); this.emit('update', this.state); }

  async prepare(restart = false) {
    if (this.busy) throw new Error('当前正在执行，请先暂停并等待当前步骤结束');
    this.busy = true;
    this.update({ phase: 'connecting', message: restart ? '正在重新开始游戏…' : '正在连接 Chrome MCP 并打开游戏标签；如出现扩展授权页，请允许连接…' });
    try {
      const game = restart ? await this.browser.restart() : await this.browser.open();
      if (restart) this.update({ sessionId: randomUUID(), steps: 0, apiCalls: 0, inputTokens: 0, outputTokens: 0, history: [], latest: null });
      this.update({ connected: true, game, phase: 'ready', message: '真实棋盘已同步，可以单步观察或连续运行。' });
    } catch (error) { this.fail(error); throw error; }
    finally { this.busy = false; }
  }

  pause() {
    this.update({ running: false, message: this.busy ? '正在暂停：取消模型请求，已发出的按键会完成校验。' : '已暂停，可查看最近一步的完整记录。' });
    this.abort?.abort();
  }

  setInterval(interval) {
    if (!Number.isInteger(interval) || interval < 0 || interval > 10000) throw new Error('额外等待应为 0–10000 毫秒的整数');
    this.update({ interval });
    this.wakeDelay?.();
  }

  start({ steps = 2000, interval = this.state.interval } = {}) {
    if (this.busy) throw new Error('已有操作进行中，请等待完成');
    if (!this.state.connected) throw new Error('请先连接游戏');
    if (!Number.isInteger(steps) || steps < 1 || steps > 2000 || !Number.isInteger(interval) || interval < 0 || interval > 10000) throw new Error('步数应为 1–2000，步间隔应为 0–10000 毫秒');
    this.abort = new AbortController();
    this.busy = true;
    this.update({ running: true, interval, runLimit: steps });
    this.task = this.loop(steps, interval).finally(() => { this.busy = false; });
  }

  async record(record) {
    await mkdir(this.traceRoot, { recursive: true });
    await appendFile(join(this.traceRoot, `${this.state.sessionId}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
  }

  async tick() {
    const logPrefix = `[tick 自动玩2048][gameId=${this.state.sessionId}]`;
    const started = performance.now();
    this.update({ phase: 'observe', message: 'MCP 正在读取真实棋盘…' });
    const before = await this.browser.read();
    this.update({ game: before });
    this.update({ phase: 'compute', message: '代码正在计算合法方向及移动后的棋盘…' });
    const options = candidates(before.board);
    if (before.over || before.won || !Object.keys(options).length) {
      this.update({ running: false, phase: 'finished', message: before.won ? '本局已达到 2048。' : '本局结束，没有可执行的走法。' });
      return;
    }
    if (!this.state.running) return;
    const request = makeRequest(before, options, this.state.history.map(h => h.direction));
    this.update({ phase: 'decide', latest: { before, options, request }, message: 'Jev 正在比较合法走法…', apiCalls: this.state.apiCalls + 1 });
    let decision;
    try { decision = await this.jev.decide(request, this.abort.signal); }
    catch (error) {
      await this.record({ at: new Date().toISOString(), step: this.state.steps + 1, request, executed: false, outcome: this.abort.signal.aborted ? '请求已取消' : '模型请求失败', errorType: error.name });
      throw error;
    }
    const record = { at: new Date().toISOString(), step: this.state.steps + 1, before, options, request, ...decision, direction: decision.answer.choice, executed: false };
    this.update({ latest: record, inputTokens: this.state.inputTokens + (decision.usage?.input_tokens ?? 0), outputTokens: this.state.outputTokens + (decision.usage?.output_tokens ?? 0) });
    if (!this.state.running) { await this.record({ ...record, discarded: '用户已暂停' }); return; }

    // 推理期间可能有人手动玩游戏；旧棋盘的判断不可用于新棋盘。
    const fresh = await this.browser.read();
    if (boardKey(fresh.board) !== boardKey(before.board) || fresh.score !== before.score || fresh.over || fresh.won) {
      await this.record({ ...record, discarded: '推理期间棋盘发生变化' });
      throw new Error('推理期间棋盘发生变化，旧决策已丢弃。请停止手动操作后继续。');
    }
    if (!this.state.running) { await this.record({ ...record, discarded: '用户已暂停' }); return; }
    this.update({ phase: 'execute', message: `MCP 正在按下 ${decision.answer.choice} 对应的方向键…` });
    await this.browser.move(decision.answer.choice);
    this.update({ phase: 'verify', message: '正在校验移动、合并得分和随机新方块…' });
    let after;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await delay(50);
      after = await this.browser.read();
      if (verifyMove(before, after, decision.answer.choice)) break;
    }
    const verified = verifyMove(before, after, decision.answer.choice);
    Object.assign(record, { after, verified, executed: true, totalMs: Math.round(performance.now() - started) });
    await this.record(record);
    this.update({ game: after, latest: record });
    if (!verified) throw new Error('实际棋盘与移动规则不一致，已停止。请检查是否手动操作、切换了 MCP 标签页或网站规则变化。');
    const steps = this.state.steps + 1;
    this.update({ steps, history: [...this.state.history, { step: steps, direction: record.direction, score: after.score, confidence: record.answer.confidence, latencyMs: record.latencyMs, maxTile: Math.max(...after.board.flat()) }].slice(-100) });
    console.log(logPrefix, `第 ${steps} 步已校验，得分 ${after.score}`);
    if (after.over || after.won) this.update({ running: false, phase: 'finished', message: after.won ? '本局已达到 2048。' : '游戏结束，可重新开始观察下一局。' });
  }

  // 调速可立即唤醒额外等待；不会取消模型请求或跳过棋盘校验。
  async waitInterval() {
    const started = performance.now();
    while (this.state.running) {
      const remaining = this.state.interval - (performance.now() - started);
      if (remaining <= 0) return;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); this.wakeDelay = null; resolve(); };
        const timer = setTimeout(finish, remaining);
        this.wakeDelay = finish;
        this.abort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }

  async loop(steps) {
    try {
      for (let i = 0; i < steps && this.state.running; i++) {
        await this.tick();
        if (this.state.running && i < steps - 1) await this.waitInterval();
      }
      if (this.state.phase !== 'finished') this.update({ phase: 'paused', message: this.state.running ? '已完成设定步数，自动暂停。' : '已暂停，可查看决策或继续运行。' });
    } catch (error) {
      if (this.abort.signal.aborted && ['AbortError', 'APIUserAbortError'].includes(error.name)) this.update({ phase: 'paused', message: '已暂停，未执行的决策已取消。' });
      else this.fail(error);
    } finally { this.update({ running: false }); }
  }

  fail(error) {
    const logPrefix = `[fail 游戏流程异常][gameId=${this.state.sessionId}]`;
    // 返回诊断信息前移除可能由外部服务带回的密钥。
    const message = safeError(error);
    console.error(logPrefix, message);
    this.update({ running: false, phase: 'error', message });
  }
}
