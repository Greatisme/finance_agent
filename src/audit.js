import { saveJson, hash } from './data.js';

export function checkBars(rows) {
  const seen = new Set(), duplicates = [], invalid = [], largeMoves = [];
  let previous;
  for (const row of rows) {
    if (seen.has(row.date)) duplicates.push(row.date);
    seen.add(row.date);
    const values = [row.open, row.close, row.high, row.low, row.volume];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || values.some(value => !Number.isFinite(value)) ||
      Math.min(row.open, row.close, row.high, row.low) <= 0 || row.volume < 0 ||
      row.low > Math.min(row.open, row.close) + 0.011 || row.high < Math.max(row.open, row.close) - 0.011 ||
      row.high < row.low || (previous && row.date < previous.date)) invalid.push(row.date);
    if (previous && Math.abs(row.close / previous.close - 1) > 0.15) largeMoves.push({ date: row.date, priceReturn: row.close / previous.close - 1 });
    previous = row;
  }
  return { duplicates, invalid, largeMoves };
}

export function compareSources(primary, secondary) {
  const map = new Map(primary.map(row => [row.date, row]));
  let overlap = 0, priceMismatchRows = 0, volumeMismatchRows = 0, maxPriceDifference = 0;
  const examples = [];
  for (const other of secondary) {
    const row = map.get(other.date);
    if (!row) continue;
    overlap++;
    const difference = Math.max(...['open', 'close', 'high', 'low'].map(key => Math.abs(row[key] - other[key])));
    maxPriceDifference = Math.max(maxPriceDifference, difference);
    if (difference > 0.011) { priceMismatchRows++; if (examples.length < 5) examples.push({ date: row.date, primaryClose: row.close, secondaryClose: other.close, difference }); }
    // Tencent historical equity volume convention: lots; Sina: shares. This tests, rather than assumes, 100x.
    if (Math.abs(row.volume * 100 - other.volume) > Math.max(100, other.volume * 0.001)) volumeMismatchRows++;
  }
  return { overlap, priceMismatchRows, volumeMismatchRows, maxPriceDifference, volumeComparison: 'Tencent * 100 vs Sina; tolerance=max(100 shares,0.1%)', examples };
}

export async function audit(dataset) {
  const { config } = dataset;
  const benchmark = dataset.prices[config.benchmark]?.rows ?? [];
  const calendar = new Set(benchmark.map(row => row.date));
  const symbols = {};
  for (const [symbol, data] of Object.entries(dataset.prices)) {
    const rows = data.rows, available = new Set(rows.map(row => row.date));
    const missingSessions = [...calendar].filter(date => date >= (rows[0]?.date ?? config.start) && !available.has(date));
    const unexpectedSessions = rows.filter(row => !calendar.has(row.date)).map(row => row.date);
    symbols[symbol] = {
      count: rows.length, first: rows[0]?.date ?? null, last: rows.at(-1)?.date ?? null,
      ...checkBars(rows), missingSessions, unexpectedSessions,
      missingInterpretation: 'relative to CSI300 observed dates; suspension vs missing feed unresolved',
      crossSource: compareSources(rows, dataset.independent[symbol]?.rows ?? []),
      yearCounts: Object.fromEntries([...new Set(rows.map(row => row.date.slice(0, 4)))].map(year => [year, rows.filter(row => row.date.startsWith(year)).length]))
    };
  }
  const events = dataset.events;
  const adjustmentProbes = Object.fromEntries(Object.entries(dataset.adjustments).map(([symbol, data]) => [symbol, {
    rows: data.rows.length, nonPositivePrices: data.rows.filter(row => Math.min(row.open, row.close, row.high, row.low) <= 0).length,
    minimumClose: Math.min(...data.rows.map(row => row.close)), adjustment: data.source.actualKey
  }]));
  const issues = [];
  if (!benchmark.length) issues.push('benchmark_missing');
  for (const [symbol, result] of Object.entries(symbols)) {
    if (!result.count || result.invalid.length || result.duplicates.length || result.unexpectedSessions.length) issues.push(`invalid_price_series:${symbol}`);
    if (result.last !== config.asOf) issues.push(`stale_or_unavailable_asof:${symbol}`);
    if (result.crossSource.overlap < 100 || result.crossSource.priceMismatchRows > 0) issues.push(`cross_source_not_passed:${symbol}`);
  }
  if (dataset.manifest.errors.length) issues.push('collection_errors_present');
  if (dataset.announcementCoverage.length !== config.stocks.length * (+config.asOf.slice(0, 4) - +config.start.slice(0, 4) + 1)) issues.push('announcement_queries_missing');
  if (events.some(event => !event.id || !event.url || !event.title || !event.disclosureDate)) issues.push('event_fields_missing');
  if (dataset.announcementCoverage.some(item => item.truncated)) issues.push('announcement_pagination_truncated');
  if (dataset.announcementCoverage.some(item => item.duplicateIds || item.totalChanged)) issues.push('announcement_pagination_inconsistent');
  const result = {
    generatedAt: new Date().toISOString(), asOf: config.asOf, datasetSha256: hash(JSON.stringify(dataset)),
    symbols, adjustmentProbes, collectionErrors: dataset.manifest.errors,
    events: {
      count: events.length, coverageQueries: dataset.announcementCoverage.length,
      sourceRecordsScanned: dataset.announcementCoverage.reduce((sum, item) => sum + item.retrieved, 0),
      expectedCoverageQueries: config.stocks.length * (+config.asOf.slice(0, 4) - +config.start.slice(0, 4) + 1),
      truncatedQueries: dataset.announcementCoverage.filter(item => item.truncated),
      zeroResultQueries: dataset.announcementCoverage.filter(item => item.total === 0).map(({ symbol, year }) => ({ symbol, year })),
      missingRequiredFields: events.filter(event => !event.id || !event.url || !event.title || !event.disclosureDate).length,
      byKind: Object.fromEntries([...new Set(events.map(event => event.kind))].map(kind => [kind, events.filter(event => event.kind === kind).length])),
      historicalFirstSeenVerified: false,
      completeness: 'issuer-ID query coverage, code-filtered and title-classified; cannot establish a complete event universe or point-in-time revisions'
    },
    pdfProbes: dataset.pdfProbes,
    historicalExitProbe: { symbol: config.historicalExitProbe, count: dataset.exitProbe.rows?.length ?? 0, error: dataset.exitProbe.error ?? null },
    gates: { priceExperimentAllowed: issues.length === 0, issues, investmentReadiness: false,
      blockers: ['current surviving convenience sample', 'no point-in-time universe including delistings', 'unadjusted price returns are not total returns', 'historical original disclosure availability not independently verified', 'no semantic financial extraction or complete news coverage', 'no execution feasibility or prospective validation'] }
  };
  await saveJson('reports/data-audit.json', result);
  return result;
}
