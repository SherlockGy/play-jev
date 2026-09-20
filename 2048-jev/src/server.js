import { safeError } from './errors.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GameBrowser, ROOT } from './browser.js';
import { Jev } from './jev.js';
import { Runner } from './runner.js';

const logPrefix = '[server Jev演示面板][gameId=2048]';
const port = Number(process.env.PORT || 2048);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数');
const browser = new GameBrowser();
const runner = new Runner(browser, new Jev());
const clients = new Set();
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

runner.on('update', state => {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(data);
});

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// 本地控制接口仅接受同源请求；静态文件采用白名单，禁止读取配置与日志之外的任意文件。
const server = http.createServer(async (req, res) => {
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(res, 403, { error: '仅允许本机访问' });
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: '拒绝跨站请求' });
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (req.method === 'GET' && path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, runner.state);
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(runner.state)}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
      req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
      return;
    }
    if (req.method === 'GET' && path === '/api/export') {
      let content = '';
      try { content = await readFile(join(ROOT, 'artifacts', `${runner.state.sessionId}.jsonl`), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="2048-jev-${runner.state.sessionId}.jsonl"` });
      return res.end(content);
    }
    if (req.method === 'POST' && path === '/api/action') {
      if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) return json(res, 413, { error: '请求过大' });
      }
      const { action, steps, interval } = JSON.parse(body);
      if (action === 'connect') await runner.prepare();
      else if (action === 'restart') await runner.prepare(true);
      else if (action === 'start') runner.start({ steps, interval });
      else if (action === 'step') runner.start({ steps: 1 });
      else if (action === 'pause') runner.pause();
      else if (action === 'speed') runner.setInterval(interval);
      else if (action === 'show') await browser.show();
      else return json(res, 400, { error: '未知动作' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && files[path]) {
      const [file, type] = files[path];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(join(ROOT, 'public', file)));
    }
    return json(res, 404, { error: '未找到资源' });
  } catch (error) {
    json(res, 400, { error: safeError(error) });
  }
});

server.listen(port, '127.0.0.1', () => console.log(logPrefix, `面板已启动：http://127.0.0.1:${port}；全局密钥${runner.state.keyReady ? '已就绪' : '未配置'}`));
server.on('error', error => { console.error(logPrefix, error.code === 'EADDRINUSE' ? '端口已占用，请设置其他 PORT' : error.message); process.exitCode = 1; });

async function shutdown() {
  runner.pause();
  await runner.task;
  for (const client of clients) client.end();
  await browser.close();
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
