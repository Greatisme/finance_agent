import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const root = process.cwd();
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function readJson(file) { return JSON.parse(await readFile(path.join(root, file), 'utf8')); }
export async function saveJson(file, value) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + '\n');
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Store the original response, request, retrieval time and content hash. No auth tokens.
export async function snapshot(source, url, options = {}) {
  const body = options.body?.toString() ?? '';
  const id = hash(`${options.method ?? 'GET'} ${url}\n${body}`);
  const file = `data/raw/${source}/${id}.json`;
  try {
    const cached = await readJson(file);
    if (cached.sha256 !== hash(cached.text) || cached.url !== url || cached.body !== body) throw new Error(`Cache integrity failed: ${file}`);
    return { ...cached, cacheHit: true };
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        ...options, headers: { 'User-Agent': 'finance-agent-research/0.1', ...options.headers },
        signal: AbortSignal.timeout(25000)
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 80)}`);
      const record = {
        source, url, method: options.method ?? 'GET', body, retrievedAt: new Date().toISOString(),
        status: response.status, contentType: response.headers.get('content-type'),
        sha256: hash(text), text
      };
      await saveJson(file, record);
      await sleep(80);
      return record;
    } catch (error) { last = error; await sleep(300 * (attempt + 1)); }
  }
  throw last;
}

export async function tencent(symbol, start, end, adjustment = '') {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${start},${end},640,${adjustment}`;
  const record = await snapshot('tencent', url);
  const json = JSON.parse(record.text);
  if (json.code !== 0) throw new Error(`Tencent ${symbol}: ${json.msg}`);
  const entity = json.data?.[symbol];
  const key = adjustment ? `${adjustment}day` : 'day';
  const values = entity?.[key] ?? (adjustment ? entity?.day : null);
  if (!Array.isArray(values)) throw new Error(`Tencent ${symbol}: no ${key} series`);
  return {
    rows: values.map(row => ({ date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4], volume: +row[5] })),
    source: { url, retrievedAt: record.retrievedAt, sha256: record.sha256, requestedKey: key, actualKey: entity?.[key] ? key : 'day' }
  };
}

export async function sina(symbol) {
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=1023`;
  const record = await snapshot('sina', url);
  const json = JSON.parse(record.text);
  if (!Array.isArray(json)) throw new Error('Sina did not return an array');
  return {
    rows: json.map(row => ({ date: row.day.slice(0, 10), open: +row.open, close: +row.close, high: +row.high, low: +row.low, volume: +row.volume })),
    source: { url, retrievedAt: record.retrievedAt, sha256: record.sha256 }
  };
}

const strip = text => String(text ?? '').replace(/<[^>]*>/g, '');
export function eventType(title) {
  if (/摘要|英文|取消|更正前/.test(title)) return null;
  if (/业绩预告/.test(title)) return 'earnings_forecast';
  if (/业绩快报/.test(title)) return 'earnings_flash';
  if (!/关于|议案|审计|提示|预约|编制|披露时间/.test(title) &&
    /(?:19|20)\d{2}年?(?:年度|半年度|第[一二三四1234]季度)报告(?:全文|正文)?(?:[（(](?:修订版|更新后|修订稿|更新版|更正版)[）)])?$/.test(title.replace(/\s/g, ''))) return 'financial_report';
  return null;
}

export async function announcements(stock, year, config) {
  if (!stock.orgId) throw new Error('Exact issuer identifier required');
  const column = stock.symbol.startsWith('sh') ? 'sse' : 'szse';
  let total = null, retrieved = 0, duplicateIds = 0, totalChanged = false;
  const seenIds = new Set();
  const events = [], sources = [];
  for (let page = 1; page <= config.maxAnnouncementPages; page++) {
    const params = new URLSearchParams({
      pageNum: String(page), pageSize: '30', tabName: 'fulltext', column,
      stock: `${stock.symbol.slice(2)},${stock.orgId}`, seDate: `${year}-01-01~${year}-12-31`, isHLtitle: 'true'
    });
    const record = await snapshot('cninfo', 'https://www.cninfo.com.cn/new/hisAnnouncement/query', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/' }, body: params
    });
    const json = JSON.parse(record.text);
    if (!Number.isFinite(json.totalAnnouncement)) throw new Error('CNINFO missing totalAnnouncement');
    total ??= json.totalAnnouncement;
    if (json.totalAnnouncement !== total) totalChanged = true;
    const rows = json.announcements ?? [];
    retrieved += rows.length;
    sources.push({ sha256: record.sha256, retrievedAt: record.retrievedAt, page });
    for (const row of rows) {
      const key = `${row.secCode}:${row.announcementId}`;
      if (seenIds.has(key)) duplicateIds++;
      seenIds.add(key);
      const title = strip(row.announcementTitle), kind = eventType(title);
      if (row.secCode !== stock.symbol.slice(2) || !kind) continue;
      const disclosureDate = new Date(row.announcementTime + 8 * 3600000).toISOString().slice(0, 10);
      events.push({
        id: row.announcementId, symbol: stock.symbol, title, kind, disclosureDate,
        providerTimestamp: row.announcementTime, timestampPrecision: 'date_only_conservative',
        url: `https://static.cninfo.com.cn/${row.adjunctUrl}`, retrievedAt: record.retrievedAt,
        historicalFirstSeenVerified: false, sourceSha256: record.sha256
      });
    }
    if (retrieved >= total || rows.length === 0) break;
  }
  return { events, total, retrieved, duplicateIds, totalChanged, truncated: retrieved < total, sources };
}

export async function collect(config) {
  const manifest = { startedAt: new Date().toISOString(), configSha256: hash(JSON.stringify(config)), requests: [], errors: [] };
  const prices = {}, independent = {}, events = [], announcementCoverage = [], adjustments = {};
  const symbols = [...config.stocks.map(stock => stock.symbol), config.benchmark];
  for (const symbol of symbols) {
    const rows = [], sources = [];
    for (let year = +config.start.slice(0, 4); year <= +config.asOf.slice(0, 4); year++) {
      try {
        const result = await tencent(symbol, `${year}-01-01`, `${year}-12-31`);
        rows.push(...result.rows.filter(row => row.date >= config.start && row.date <= config.asOf));
        sources.push(result.source);
      } catch (error) { manifest.errors.push({ symbol, year, source: 'tencent', error: error.message }); }
    }
    prices[symbol] = { rows: rows.sort((a, b) => a.date.localeCompare(b.date)), sources, adjustment: 'none', volumeUnit: 'provider_lots_unverified' };
    console.log(`prices ${symbol}: ${rows.length} rows`);
    try { independent[symbol] = await sina(symbol); }
    catch (error) { manifest.errors.push({ symbol, source: 'sina', error: error.message }); }
    if (symbol !== config.benchmark) {
      try { adjustments[symbol] = await tencent(symbol, '2016-01-01', '2016-12-31', 'qfq'); }
      catch (error) { manifest.errors.push({ symbol, source: 'qfq_probe', error: error.message }); }
    }
  }
  for (const stock of config.stocks) {
    let issuer;
    try {
      const discovery = await snapshot('cninfo', 'https://www.cninfo.com.cn/new/hisAnnouncement/query', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ pageNum: '1', pageSize: '30', tabName: 'fulltext', column: stock.symbol.startsWith('sh') ? 'sse' : 'szse', searchkey: stock.name, seDate: '2024-01-01~2024-12-31' })
      });
      issuer = JSON.parse(discovery.text).announcements?.find(row => row.secCode === stock.symbol.slice(2))?.orgId;
      if (!issuer) throw new Error('Issuer discovery failed');
    } catch (error) { manifest.errors.push({ symbol: stock.symbol, source: 'cninfo_issuer', error: error.message }); continue; }
    for (let year = +config.start.slice(0, 4); year <= +config.asOf.slice(0, 4); year++) {
      try {
        const result = await announcements({ ...stock, orgId: issuer }, year, config);
        events.push(...result.events.filter(event => event.disclosureDate <= config.asOf));
        announcementCoverage.push({ symbol: stock.symbol, orgId: issuer, year, total: result.total, retrieved: result.retrieved, duplicateIds: result.duplicateIds, totalChanged: result.totalChanged, kept: result.events.length, truncated: result.truncated, sources: result.sources });
      } catch (error) { manifest.errors.push({ symbol: stock.symbol, year, source: 'cninfo', error: error.message }); }
    }
    console.log(`announcements ${stock.symbol}: ${events.filter(event => event.symbol === stock.symbol).length}`);
  }
  const uniqueEvents = [...new Map(events.map(event => [`${event.symbol}:${event.id}`, event])).values()];
  let exitProbe;
  try { exitProbe = await tencent(config.historicalExitProbe, '2009-01-01', '2009-12-31'); }
  catch (error) { exitProbe = { error: error.message }; }
  // Verify that a few referenced documents are actual PDFs; no financial values are extracted.
  const pdfProbes = [];
  for (const event of uniqueEvents.filter(event => event.kind === 'financial_report').slice(0, 3)) {
    try {
      const response = await fetch(event.url, { signal: AbortSignal.timeout(25000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const file = `data/documents/${event.id}.pdf`;
      await mkdir(path.join(root, 'data/documents'), { recursive: true });
      await writeFile(path.join(root, file), bytes);
      pdfProbes.push({ id: event.id, url: event.url, status: response.status, bytes: bytes.length, pdfSignature: bytes.subarray(0, 5).toString() === '%PDF-', sha256: hash(bytes), retrievedAt: new Date().toISOString() });
    } catch (error) { pdfProbes.push({ id: event.id, error: error.message }); }
  }
  manifest.finishedAt = new Date().toISOString();
  await saveJson('data/normalized/dataset.json', { config, prices, independent, adjustments, events: uniqueEvents, announcementCoverage, exitProbe, pdfProbes, manifest });
  console.log(`collection complete: ${uniqueEvents.length} unique disclosure events, ${manifest.errors.length} request failures`);
}
