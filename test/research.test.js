import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBars, compareSources } from '../src/audit.js';
import { eventType } from '../src/data.js';
import { buildSamples, eventFeatures, fitLogistic, metrics, pairedBlockInterval } from '../src/model.js';
import { chronologicalSplit } from '../src/experiment.js';

test('audit detects corrupt OHLC, duplicates and nonfinite data', () => {
  const valid = { date: '2024-01-02', open: 10, close: 11, high: 12, low: 9, volume: 100 };
  const result = checkBars([valid, { ...valid, close: 13 }, { ...valid, date: '2024-01-03', open: NaN }]);
  assert.deepEqual(result.duplicates, ['2024-01-02']);
  assert.deepEqual(result.invalid, ['2024-01-02', '2024-01-03']);
});

test('cross-source comparison matches OHLC and verifies volume conversion separately', () => {
  const row = { date: '2024-01-02', open: 10, close: 11, high: 12, low: 9, volume: 100 };
  assert.equal(compareSources([row], [{ ...row, volume: 10000 }]).priceMismatchRows, 0);
  assert.equal(compareSources([row], [{ ...row, volume: 10000 }]).volumeMismatchRows, 0);
  assert.equal(compareSources([row], [{ ...row, close: 11.1 }]).priceMismatchRows, 1);
});

test('date-only disclosure cannot enter same-day features; future information ignored', () => {
  const dates = ['2024-01-04', '2024-01-05', '2024-01-08'];
  const event = { symbol: 's', disclosureDate: '2024-01-05', kind: 'financial_report' };
  assert.equal(eventFeatures([event], 's', dates, 1)[0], 0);
  assert.equal(eventFeatures([event], 's', dates, 2)[0], 1);
  assert.deepEqual(eventFeatures([event, { ...event, disclosureDate: '2025-01-01' }], 's', dates, 2), eventFeatures([event], 's', dates, 2));
});

test('split purges labels crossing calibration and test boundaries', () => {
  const rows = [
    { date: '2022-12-01', labelEnd: '2022-12-20' },
    { date: '2022-12-25', labelEnd: '2023-01-10' },
    { date: '2023-01-03', labelEnd: '2023-01-20' },
    { date: '2023-12-20', labelEnd: '2024-01-05' },
    { date: '2024-01-03', labelEnd: '2024-01-20' }
  ];
  const split = chronologicalSplit(rows, 2024);
  assert.equal(split.train.length, 1);
  assert.equal(split.calibration.length, 1);
  assert.equal(split.test.length, 1);
  assert.ok(split.train.every(row => row.labelEnd < split.calibration[0].date));
  assert.ok(split.calibration.every(row => row.labelEnd < split.test[0].date));
});

test('features use only signal-date history, labels use next open and h-th close', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i, volume: 100 + i
  }));
  const dataset = { config: { benchmark: 'm', stocks: [{ symbol: 's' }], threshold: 0 }, prices: { s: { rows }, m: { rows } }, events: [] };
  const first = buildSamples(dataset, 5).samples[0];
  assert.equal(first.entryDate, rows[61].date);
  assert.equal(first.labelEnd, rows[65].date);
  assert.equal(first.priceReturn, rows[65].close / rows[61].open - 1);
  const changed = structuredClone(dataset);
  for (const row of changed.prices.s.rows.slice(61)) row.close *= 2;
  assert.deepEqual(buildSamples(changed, 5).samples[0].features, first.features);
  assert.notEqual(buildSamples(changed, 5).samples[0].priceReturn, first.priceReturn);
});

test('logistic fitting learns a simple signal using training-only scaling', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ features: [i - 50], y: +(i >= 50) }));
  const model = fitLogistic(rows, [0], { iterations: 400, learningRate: 0.1, ridge: 0.001 });
  assert.equal(model.centers[0], -0.5);
  assert.ok(model.predict({ features: [-40] }) < 0.1);
  assert.ok(model.predict({ features: [40] }) > 0.9);
});

test('probability scores have known values; paired block intervals reproducible', () => {
  const result = metrics([{ y: 0, p: 0.5 }, { y: 1, p: 0.5 }]);
  assert.equal(result.brier, 0.25);
  assert.equal(result.logLoss, Math.log(2));
  const rows = Array.from({ length: 100 }, (_, i) => ({ date: String(i).padStart(3, '0'), y: i % 2, a: 0.5, b: i % 2 }));
  const interval = pairedBlockInterval(rows, 'a', 'b', 20, 100, 42);
  assert.equal(interval.deltaBrier, 0.25);
  assert.equal(interval.lower95, 0.25);
  assert.deepEqual(interval, pairedBlockInterval(rows, 'a', 'b', 20, 100, 42));
});

test('event categories do not treat report summaries or disclosure scheduling as financial reports', () => {
  assert.equal(eventType('2024年年度报告'), 'financial_report');
  assert.equal(eventType('2024年年度报告摘要'), null);
  assert.equal(eventType('关于延期披露年度报告的提示性公告'), null);
  assert.equal(eventType('关于披露平安银行2016年第一季度报告的公告'), null);
  assert.equal(eventType('关于2024年年度报告的更正公告'), null);
  assert.equal(eventType('2024年业绩预告'), 'earnings_forecast');
});
