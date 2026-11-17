import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openAssistant, savedThread, saveThread } from './assistant-runtime.js';
import { callFinanceTool } from './assistant-tools.js';
import { intradaySnapshot, startIntraday } from './intraday.js';
import { bars, searchStocks, stockChart, stockEvidence } from './market.js';
import { analyzedStocks, industryHistory, readEvidenceWindow } from './market-sources.js';
import { analysisSchema, makeAnalysisPrompt, assembleAnalysis, analysisText } from './market-analysis.js';

import { researchContext, stockDossier, listedDays, publicTrades } from './research-context.js';
import { reviewedEvents, followThrough, closedThrough } from './market-events.js';

const port = Number(process.env.FINANCE_PORT ?? 4317);
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const historyFile = 'data/assistant/web-history.json';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/intraday.js', ['intraday.js', 'text/javascript; charset=utf-8']],
  ['/research-context.js', ['research-context.js', 'text/javascript; charset=utf-8']],
  ['/indicators.js', ['indicators.js', 'text/javascript; charset=utf-8']],
  ['/chart-periods.js', ['chart-periods.js', 'text/javascript; charset=utf-8']],
  ['/events.js', ['events.js', 'text/javascript; charset=utf-8']],
  ['/market.js', ['market.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
let busy = false;

async function history(threadId) {
  if (!threadId) return [];
  try {
    const saved = JSON.parse(await readFile(historyFile, 'utf8'));
    return saved.threadId === threadId ? saved.rows : [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

const archivePath = symbol => 'data/assistant/research/' + symbol + '.ndjson';

async function archiveRows(symbol) {
  try {
    const text=await readFile(archivePath(symbol),'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line=>({report:JSON.parse(line)}));
  } catch(error) { if(error.code==='ENOENT')return []; throw error; }
}

async function stockEvents(symbol) {
  return reviewedEvents([...(await history(await savedThread())),...(await archiveRows(symbol))],symbol);
}

function dayOffset(date, days) {
  return new Date(Date.parse(date)+days*86400_000).toISOString().slice(0,10);
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function chat(request, response) {
  if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    return json(response, 403, { error: '请从本机工作台发送消息。' });
  }
  if (busy) return json(response, 409, { error: '助手正在处理上一条消息。' });
  busy = true;
  let assistant;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 32_768) { json(response, 413, { error: '消息过长。' }); return; }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const message = body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 8000) {
      return json(response, 400, { error: '请输入 1—8000 字的消息。' });
    }
    let evidence;
    if (body.analysis) {
      const symbol = String(body.analysis.symbol ?? '');
      if (!analyzedStocks.has(symbol)) return json(response, 400, { error: '当前仅分析瑞芯微、立讯精密和天奇股份。' });
      const base = await stockEvidence(symbol, String(body.analysis.date ?? ''));
      if (!base) return json(response, 400, { error: '选中的交易日缺少可分析的行情。' });
      const [window, context] = await Promise.allSettled([
        readEvidenceWindow(base), bars(symbol, {end:base.row.date}).then(prices=>researchContext(symbol,base.row.date,prices))
      ]);
      if(window.status==='rejected')throw window.reason;
      evidence = {...window.value,context:context.value??null};
    }
    const emit = (type, value) => {
      if (!response.destroyed) response.write(JSON.stringify({ type, value }) + '\n');
    };
    assistant = await openAssistant({ onTool: name => emit('tool', name) });
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    response.flushHeaders();
    let answer = '';
    let report;
    if (evidence) {
      emit('phase', '已取得原文，正在逐条核对和分析…');
      let deltas = '';
      const final = await assistant.session.turn(assistant.thread.id, makeAnalysisPrompt(evidence), delta => { deltas += delta; }, analysisSchema);
      report = assembleAnalysis(evidence, final || deltas);
      answer = analysisText(report);
      await mkdir('data/assistant/research',{recursive:true});
      await appendFile(archivePath(report.stock.symbol), JSON.stringify(report)+'\n');
    } else {
      await assistant.session.turn(assistant.thread.id, message.trim(), delta => {
        answer += delta;
        emit('delta', delta);
      });
    }
    await saveThread(assistant.thread.id, assistant.storage);
    const rows = await history(assistant.thread.id);
    rows.push({ message: message.trim(), answer, report });
    const tmp = historyFile + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify({ threadId: assistant.thread.id, rows }));
    await rename(tmp, historyFile);
    await assistant.session.close();
    assistant = undefined;
    busy = false;
    if (report) emit('analysis-report', report);
    emit('done', null);
    response.end();
  } catch (error) {
    if (!response.headersSent) json(response, error.code === 'LOGIN_REQUIRED' ? 401 : 500, { error: error.message });
    else if (!response.destroyed) response.end(JSON.stringify({ type: 'error', value: error.message }) + '\n');
  } finally {
    try { await assistant?.session.close(); }
    finally { busy = false; }
  }
}

createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (request.headers.host !== `${host}:${port}`) return json(response, 403, { error: '仅支持本机地址。' });
  const url = new URL(request.url, origin);
  try {
    if (request.method === 'POST' && url.pathname === '/api/chat') return await chat(request, response);
    if (request.method === 'GET') {
      if (url.pathname === '/api/intraday') {
        const data=intradaySnapshot(url.searchParams.get('symbol') ?? '');
        return json(response,data?200:404,data??{error:'本股不在分时采集范围内。'});
      }
      if (url.pathname === '/api/research-context') {
        const symbol=url.searchParams.get('symbol') ?? '';
        if (!analyzedStocks.has(symbol)) return json(response,404,{error:'该证券未开启长期研究。'});
        const [result,events]=await Promise.all([
          bars(symbol).catch(()=>null).then(prices=>stockDossier(symbol,closedThrough(),prices)),stockEvents(symbol)
        ]);
        return json(response,200,{...result,events});
      }
      if (url.pathname === '/api/events') {
        const symbol=url.searchParams.get('symbol') ?? '';
        if (!analyzedStocks.has(symbol)) return json(response,404,{error:'该证券未开启事件标注。'});
        const [events,list]=await Promise.all([stockEvents(symbol),listedDays(symbol.slice(2),closedThrough()).catch(()=>null)]);
        return json(response,200,[...events,...(list?.days??[]).map(item=>({...item,side:'交易',title:'龙虎榜 · '+item.reasons.join('；')}))]
          .sort((a,b)=>a.date.localeCompare(b.date)));
      }
      if (url.pathname === '/api/disclosed-trades') {
        const symbol=url.searchParams.get('symbol') ?? '', date=url.searchParams.get('date') ?? '';
        if (!analyzedStocks.has(symbol)||!/^\d{4}-\d{2}-\d{2}$/.test(date))return json(response,400,{error:'证券或日期无效。'});
        return json(response,200,await publicTrades(symbol.slice(2),date));
      }
      if (url.pathname === '/api/event-performance') {
        const symbol=url.searchParams.get('symbol') ?? '';
        const date=url.searchParams.get('date') ?? '';
        if (!analyzedStocks.has(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(response,400,{error:'证券或日期无效。'});
        const cutoff=closedThrough();
        if (!Number.isFinite(Date.parse(date))) return json(response,400,{error:'交易日无效。'});
        const windowEnd=dayOffset(date,70);
        const end=windowEnd<cutoff ? windowEnd : cutoff;
        const range={start:dayOffset(date,-30),end};
        const [stock,market,industry]=await Promise.allSettled([
          bars(symbol,range),bars('sh000001',range),industryHistory(symbol,end,120)
        ]);
        const performance=followThrough(date,market.value?.rows??[],stock.value?.rows??[],industry.value?.rows??[],cutoff);
        return json(response,200,{...performance,sector:industry.value?.name??null,
          sources:{stock:stock.value?.url??null,industry:industry.value?.url??null,calendar:market.value?.url??null},
          availability:{calendar:!!market.value,stock:!!stock.value,industry:!!industry.value}});
      }
      if (url.pathname === '/api/stocks') return json(response, 200, await searchStocks(url.searchParams.get('q') ?? ''));
      if (url.pathname === '/api/chart' || url.pathname === '/api/evidence') {
        const symbol = url.searchParams.get('symbol') ?? '';
        const result = url.pathname === '/api/chart'
          ? await stockChart(symbol,{recentOnly:url.searchParams.get('scope')==='recent'})
          : await stockEvidence(symbol, url.searchParams.get('date') ?? '');
        if (url.pathname === '/api/chart' && result) result.analysisEnabled = analyzedStocks.has(symbol);
        return json(response, result ? 200 : 404, result ?? { error: '未找到该证券或交易日的有效数据。' });
      }
      if (url.pathname === '/api/history') return json(response, 200, (await history(await savedThread())).slice(-50));
      if (url.pathname === '/api/research') {
        const [config, audit, experiment] = await Promise.allSettled(['config', 'audit', 'experiment'].map(resource => callFinanceTool('finance_read', { resource })));
        return json(response, 200, Object.fromEntries(Object.entries({ config, audit, experiment }).map(([key, result]) =>
          [key, result.status === 'fulfilled' ? { data: result.value } : { error: result.reason.code === 'ENOENT' ? '暂无本地结果' : '无法读取研究结果' }])));
      }
      const asset = assets.get(url.pathname);
      if (asset) {
        response.writeHead(200, { 'Content-Type': asset[1] });
        response.end(await readFile(new URL('../web/' + asset[0], import.meta.url)));
        return;
      }
    }
    json(response, 404, { error: '接口不存在。' });
  } catch {
    if (!response.headersSent) json(response, 500, { error: '本地工作台无法读取请求的数据。' });
    else response.end();
  }
}).listen(port, host, () => { console.log('Finance Agent: ' + origin); startIntraday(); });
