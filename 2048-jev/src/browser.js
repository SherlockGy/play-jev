import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { validateBoard, KEYS } from './game.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const GAME_URL = 'https://2048.io/';
const require = createRequire(import.meta.url);

// 读取当前标签页的可见棋盘，避免同源其他标签页的共享存档干扰。
export function readGamePage() {
  if (location.origin !== 'https://2048.io') throw new Error('当前页面不是 2048.io');
  const container = document.querySelector('.tile-container');
  const scoreElement = document.querySelector('.score-container');
  if (!container || !scoreElement) throw new Error('未找到 2048 棋盘，网站结构可能已变化');
  const message = document.querySelector('.game-message');
  const over = message?.classList.contains('game-over') ?? false;
  const won = message?.classList.contains('game-won') ?? false;
  const board = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (const tile of container.querySelectorAll(':scope > .tile')) {
    const position = tile.className.match(/tile-position-(\d)-(\d)/);
    const value = Number(tile.querySelector('.tile-inner')?.textContent);
    if (!position || !Number.isFinite(value)) throw new Error('无法解析方块位置');
    const x = Number(position[1]) - 1, y = Number(position[2]) - 1;
    if (x < 0 || x > 3 || y < 0 || y > 3) throw new Error('方块坐标超出棋盘');
    // 合并动画可能保留旧方块，取该位置实际合并后的最大值。
    board[y][x] = Math.max(board[y][x], value);
  }
  const score = Number([...scoreElement.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim());
  return { board, score, over, won, source: '2048.io 实时页面', observedAt: new Date().toISOString() };
}

export function decodeResult(result) {
  if (result.isError) throw new Error(result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || 'MCP 调用失败');
  const text = result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') ?? '';
  const match = text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
  const raw = (match?.[1] ?? text).trim().replace(/^```(?:json)?\s*\n|\n```$/g, '');
  try { return JSON.parse(raw); } catch { throw new Error('MCP 返回格式无法解析，请确认 Playwright MCP 版本与文档一致'); }
}

export class GameBrowser {
  constructor() { this.client = null; this.transport = null; this.toolNames = new Set(); }

  async connect() {
    if (this.client) return;
    const logPrefix = '[connect 连接游戏浏览器][gameId=2048]';
    await mkdir(join(ROOT, 'artifacts', 'mcp'), { recursive: true });
    const url = process.env.PLAYWRIGHT_MCP_URL;
    if (url) {
      this.transport = new StreamableHTTPClientTransport(new URL(url));
    } else {
      const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
      // 使用当前 Node 可执行文件启动 MCP，避开 Windows 的 .cmd 和 shell 引号差异。
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !name.startsWith('TYPESAFE_')));
      this.transport = new StdioClientTransport({
        command: process.execPath,
        args: [cli, '--config', join(ROOT, 'mcp.config.json'), '--output-dir', join(ROOT, 'artifacts', 'mcp')],
        cwd: ROOT, env, stderr: 'pipe',
      });
    }
    const client = new Client({ name: '2048-jev', version: '1.0.0' });
    try {
      await client.connect(this.transport);
      let cursor;
      do {
        const list = await client.listTools({ cursor });
        list.tools.forEach(tool => this.toolNames.add(tool.name));
        cursor = list.nextCursor;
      } while (cursor);
      for (const name of ['browser_tabs', 'browser_evaluate', 'browser_press_key']) {
        if (!this.toolNames.has(name)) throw new Error(`MCP 缺少必要工具：${name}`);
      }
      this.client = client;
      console.log(logPrefix, url ? '已连接现有 HTTP MCP 服务' : '已启动本地 stdio MCP 服务');
    } catch (error) {
      await client.close().catch(() => {});
      await this.transport.close().catch(() => {});
      throw error;
    }
  }

  async call(name, args = {}) {
    if (!this.client) throw new Error('请先连接游戏');
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 40000 });
    if (result.isError) decodeResult(result);
    return result;
  }

  async open() {
    await this.connect();
    // 首次连接在日常 Chrome 中新开专用标签，后续连接保留当前这一局。
    if (!this.opened) {
      await this.call('browser_tabs', { action: 'new', url: GAME_URL });
      this.opened = true;
    }
    const game = await this.read();
    await this.show();
    return game;
  }

  async show() {
    const name = ['browser_run_code', 'browser_run_code_unsafe'].find(tool => this.toolNames.has(tool));
    if (!name) throw new Error('当前 MCP 不支持显示已有标签页，请使用项目锁定的 Playwright MCP 版本');
    await this.call(name, { code: "async (page) => { if (!page.url().startsWith('https://2048.io/')) throw new Error('请选择 Chrome 中已有的 2048.io 标签页'); await page.bringToFront(); return { url: page.url() }; }" });
  }

  async read() {
    const state = decodeResult(await this.call('browser_evaluate', { function: readGamePage.toString() }));
    validateBoard(state.board);
    if (!Number.isSafeInteger(state.score) || state.score < 0 || !state.board.flat().some(Boolean)) throw new Error('游戏状态尚未就绪');
    return state;
  }

  async move(direction) {
    if (!KEYS[direction]) throw new Error('禁止执行未知动作');
    await this.call('browser_press_key', { key: KEYS[direction] });
  }

  async restart() {
    // 按钮由网站自身处理，禁止修改存档或直接替换游戏状态。
    await this.call('browser_evaluate', { function: "async () => { if (location.origin !== 'https://2048.io') throw new Error('页面不匹配'); const button = document.querySelector('.restart-button'); if (!button) throw new Error('未找到重新开始按钮'); button.click(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; }" });
    return this.read();
  }

  async close() {
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
    this.client = null;
    this.transport = null;
    this.opened = false;
    this.toolNames.clear();
  }
}
