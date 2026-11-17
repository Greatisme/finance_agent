const element = id => document.getElementById(id);
const messages = element('messages');
const status = element('status');
const send = element('send');
const input = element('message');

async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法连接本机后端。');
  return response.json();
}

function table(id, rows) {
  element(id).replaceChildren(...rows.map(values => {
    const row = document.createElement('tr');
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));
}

async function refreshResearch() {
  try {
    const { config, audit, experiment } = await get('/api/research');
    element('cutoff').textContent = audit.data ? '已审计数据截至 ' + audit.data.asOf : '等待本地数据审计';
    const stocks = config.data?.stocks ?? [];
    element('stats').replaceChildren(...[['股票样本', config.data ? stocks.length : '—'],
      ['披露事件', audit.data?.events.count ?? '—'], ['预测周期', experiment.data?.results.length ?? '—']].map(([label, value]) => {
      const card = document.createElement('div');
      card.className = 'stat';
      card.append(label);
      const count = document.createElement('strong');
      count.textContent = value;
      card.append(count);
      return card;
    }));
    element('experiment-status').textContent = experiment.error ?? '样本外结果 · Brier 越低越好';
    table('results', (experiment.data?.results ?? []).map(({ horizon, metrics }) => [
      horizon + ' 日', metrics.prices.n, metrics.prices.brier.toFixed(6), metrics.prices_events.brier.toFixed(6)
    ]));
    element('audit-status').textContent = audit.error ?? (audit.data.gates.priceExperimentAllowed ? '已通过本轮实验数据检查' : '数据检查存在问题');
    table('symbols', Object.entries(audit.data?.symbols ?? {}).map(([symbol, row]) => [
      stocks.find(stock => stock.symbol === symbol)?.name ?? (symbol === config.data?.benchmark ? '沪深 300' : symbol),
      row.count, row.missingSessions, row.crossSource.priceMismatchRows
    ]));
  } catch (error) { element('cutoff').textContent = error.message; }
}

function bubble(kind, text) {
  const paragraph = document.createElement('p');
  paragraph.className = 'bubble ' + kind;
  paragraph.textContent = text;
  messages.append(paragraph);
  messages.scrollTop = messages.scrollHeight;
  return paragraph;
}

element('refresh').addEventListener('click', refreshResearch);
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  input.value = button.dataset.prompt;
  input.focus();
}));
element('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  void sendMessage(input.value.trim());
});
document.addEventListener('finance:analysis', event => {
  void sendMessage(event.detail.message, event.detail.analysis);
});

async function sendMessage(message, analysis) {
  if (!message) return;
  if (send.disabled) {
    status.textContent = '助手正在处理上一条消息。完成后可再次点击分析。';
    return;
  }
  send.disabled = true;
  if (!analysis) input.value = '';
  bubble('user', message);
  const answer = bubble('assistant', '');
  status.textContent = '正在连接助手…';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, analysis })
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '', complete = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === 'delta') {
          answer.textContent += event.value;
          messages.scrollTop = messages.scrollHeight;
        }
        if (event.type === 'tool') status.textContent = event.value === 'finance_run' ? '正在运行研究任务…' : '正在读取研究数据…';
        if (event.type === 'error') throw new Error(event.value);
        if (event.type === 'done') complete = true;
      }
    }
    if (!complete) throw new Error('连接中断。请刷新后检查会话记录。');
    status.textContent = '已保存到本机';
    void refreshResearch();
  } catch (error) {
    if (!answer.textContent) answer.remove();
    if (!analysis && !input.value) input.value = message;
    status.textContent = error.message;
  } finally { send.disabled = false; }
}

send.disabled = true;
void refreshResearch();
try {
  const history = await get('/api/history');
  if (!history.length) bubble('assistant', '可以询问数据质量、解读实验，或让我运行研究任务。');
  for (const turn of history) {
    bubble('user', turn.message);
    bubble('assistant', turn.answer);
  }
} catch (error) { status.textContent = error.message; }
finally { send.disabled = false; }
