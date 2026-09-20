const $ = id => document.getElementById(id);
const arrows = { up: '↑', right: '→', down: '↓', left: '←' };
const labels = { up: '向上', right: '向右', down: '向下', left: '向左' };
const phases = { idle: '等待连接', connecting: '连接中', ready: '已就绪', observe: '01 / 读取', compute: '02 / 计算', decide: '03 / 判断', execute: '04 / 行动', verify: '05 / 核验', paused: '已暂停', finished: '本局结束', error: '需要检查' };
let latestState, selectedTab = 'request', pending = false;
const empty = Array.from({ length: 4 }, () => Array(4).fill(0));

function drawBoard(target, board) {
  target.replaceChildren(...board.flat().map(value => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.level = value ? Math.min(11, Math.log2(value)) : 0;
    tile.textContent = value || '';
    return tile;
  }));
}

function inspector() {
  const latest = latestState?.latest;
  if (!latest) return;
  let data;
  if (selectedTab === 'request') data = latest.request;
  if (selectedTab === 'answer') data = latest.answer ? { model: latest.model, direction: latest.answer, usage: latest.usage, latencyMs: latest.latencyMs } : '等待 Jev 返回';
  if (selectedTab === 'result') data = latest.after ? { before: latest.before, after: latest.after, direction: latest.direction, verified: latest.verified, totalMs: latest.totalMs } : '尚未执行';
  $('inspector').textContent = JSON.stringify(data, null, 2);
}

function render(state) {
  latestState = state;
  const busy = state.running || ['connecting', 'observe', 'compute', 'decide', 'execute', 'verify'].includes(state.phase);
  $('connect').disabled = busy || pending;
  $('connect').firstChild.textContent = state.connected ? '重新连接 ' : '连接游戏 ';
  for (const id of ['start', 'step', 'restart']) $(id).disabled = pending || busy || !state.connected || (id !== 'restart' && !state.keyReady);
  $('pause').disabled = !state.running;
  $('show').disabled = !state.connected;
  if (document.activeElement !== $('interval')) $('interval').value = state.interval;
  $('key-status').textContent = state.keyReady ? '密钥已就绪' : '未读取到全局密钥';
  $('mcp-mode').textContent = `PLAYWRIGHT · ${state.mcpMode}`;
  $('status').textContent = state.message;
  $('status-dot').className = `status-dot ${state.phase === 'error' ? 'error' : busy ? 'active' : ''}`;
  $('phase-label').textContent = phases[state.phase] || state.phase;
  $('move-count').textContent = state.steps;
  $('calls').textContent = `${state.apiCalls} 次模型调用`;
  $('tokens').textContent = `${state.inputTokens.toLocaleString()} 输入 / ${state.outputTokens.toLocaleString()} 输出 tokens`;
  for (const node of document.querySelectorAll('[data-phase]')) node.classList.toggle('active', node.dataset.phase === state.phase);
  if (state.game) {
    drawBoard($('board'), state.game.board);
    $('score').textContent = state.game.score.toLocaleString();
    $('max-tile').textContent = Math.max(...state.game.board.flat());
    $('empty-cells').textContent = `${state.game.board.flat().filter(n => n === 0).length} 个空格`;
    $('board-source').textContent = `页面同步 · ${new Date(state.game.observedAt).toLocaleTimeString()}`;
  }
  const latest = state.latest, answer = latest?.answer;
  $('direction').textContent = answer ? arrows[answer.choice] : '?';
  $('decision-title').textContent = answer ? `Jev 选择${labels[answer.choice]}` : '四个方向，一次判断';
  $('decision-subtitle').textContent = answer ? 'Choice · 结构化方向选择' : '只把能改变棋盘的方向交给 Jev';
  $('confidence').textContent = answer ? `${(answer.confidence * 100).toFixed(1)}%` : '—';
  $('step-label').textContent = latest ? `第 ${latest.step ?? state.steps + 1} 步` : '等待第一步';
  $('latency').textContent = latest?.latencyMs ? `${latest.latencyMs} ms` : '—';
  $('total-time').textContent = latest?.totalMs ? `${(latest.totalMs / 1000).toFixed(2)} s` : '—';
  $('verification').textContent = latest?.verified === true ? '已通过 ✓' : latest?.verified === false ? '未通过' : '等待执行';
  $('model').textContent = latest?.model || 'Jev · System One';
  $('candidates').replaceChildren(...Object.keys(arrows).map(direction => {
    const option = latest?.options?.[direction], probability = answer?.probabilities?.[direction];
    const card = document.createElement('div');
    card.className = `candidate ${answer?.choice === direction ? 'chosen' : ''} ${latest && !option ? 'invalid' : ''}`;
    // 这里的模板只包含内部常量和数值，远端文本统一使用 textContent 显示。
    card.innerHTML = `<div class="candidate-top"><span>${labels[direction]}</span><b>${arrows[direction]}</b></div><div class="mini-board"></div><div class="probability"></div><div class="bar"><i></i></div><div class="candidate-facts"></div>`;
    drawBoard(card.querySelector('.mini-board'), option?.boardBeforeSpawn || empty);
    card.querySelector('.probability').textContent = probability !== undefined ? `${(probability * 100).toFixed(1)}%` : '—';
    card.querySelector('.bar i').style.width = `${(probability ?? 0) * 100}%`;
    card.querySelector('.candidate-facts').textContent = option ? `合并 +${option.mergeScore} · 空格 ${option.emptyCells}` : latest ? '无效走法' : '等待棋盘';
    return card;
  }));
  $('history-empty').hidden = state.history.length > 0;
  $('history').replaceChildren(...[...state.history].reverse().map(entry => {
    const row = document.createElement('tr');
    for (const value of [entry.step, `${arrows[entry.direction]} ${labels[entry.direction]}`, entry.score, `${(entry.confidence * 100).toFixed(1)}%`, `${entry.latencyMs} ms`]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    return row;
  }));
  if (!latest) $('inspector').textContent = '等待读取棋盘。这里将展示实际发送给 Jev 的结构化数据。';
  else inspector();
}

async function act(action) {
  const payload = { action, steps: Number($('steps').value), interval: Number($('interval').value) };
  pending = true;
  if (latestState) render(latestState);
  try {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
  } catch (error) { $('status').textContent = error.message; $('status-dot').className = 'status-dot error'; }
  finally {
    pending = false;
    // 仅更新按钮，避免请求失败提示被旧状态覆盖。
    if (latestState) {
      const message = $('status').textContent;
      render(latestState);
      $('status').textContent = message;
    }
  }
}

for (const action of ['connect', 'start', 'step', 'pause', 'restart', 'show']) $(action).addEventListener('click', () => act(action));
$('interval').addEventListener('change', () => act('speed'));
$('speed-zero').addEventListener('click', () => { $('interval').value = 0; act('speed'); });
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
  selectedTab = button.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('selected', tab === button));
  inspector();
});
drawBoard($('board'), empty);
const events = new EventSource('/api/events');
events.onmessage = event => { $('connection-status').textContent = '● 实时连接'; render(JSON.parse(event.data)); };
events.onerror = () => { $('connection-status').textContent = '连接中断 · 正在重连'; $('status').textContent = '本地服务连接中断，请检查终端是否仍在运行。'; };
