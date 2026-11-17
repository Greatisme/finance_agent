import test from 'node:test';
import assert from 'node:assert/strict';
import { chartPeriodRows, chartEventIndex, eventWindowSpan } from '../web/chart-periods.js';

test('daily candles aggregate into Monday-start weeks and calendar months', () => {
  const rows = [
    { date: '2025-12-29', open: 10, high: 13, low: 9, close: 12, volume: 100 },
    { date: '2025-12-31', open: 12, high: 16, low: 11, close: 15, volume: 200 },
    { date: '2026-01-02', open: 15, high: 15, low: 7, close: 9, volume: 300 },
    { date: '2026-01-05', open: 9, high: 12, low: 9, close: 10, volume: 400 }
  ];
  assert.equal(chartPeriodRows(rows, 'day'), rows);
  const weeks = chartPeriodRows(rows, 'week');
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks[0], {
    startDate: '2025-12-29', periodStart: '2025-12-29', periodEnd: '2026-01-04', date: '2026-01-02',
    open: 10, high: 16, low: 7, close: 9, volume: 600, previousClose: null, returnPct: null, volumeMultiple: null
  });
  assert.equal(weeks[1].previousClose, 9);
  const months = chartPeriodRows(rows, 'month');
  assert.deepEqual(months.map(row => [row.startDate, row.date, row.close, row.volume]), [
    ['2025-12-29', '2025-12-31', 15, 300], ['2026-01-02', '2026-01-05', 10, 700]
  ]);
});

test('period bars preserve event timing and shade windows overlapping a partly covered bar', () => {
  const rows = ['2026-06-05', '2026-06-08', '2026-06-12', '2026-06-15'].map(date =>
    ({ date, open: 10, high: 11, low: 9, close: 10, volume: 100 }));
  const weeks = chartPeriodRows(rows, 'week');
  assert.equal(chartEventIndex(rows, '2026-06-06'), 1);
  assert.equal(chartEventIndex(weeks, '2026-06-06'), 0);
  assert.equal(chartEventIndex(weeks.slice(1), '2026-06-06'), -1);
  assert.equal(chartEventIndex(weeks, '2026-06-16'), -1);
  assert.deepEqual(eventWindowSpan(weeks, '2026-06-05', '2026-06-08'), { first: 0, count: 2 });
  assert.deepEqual(eventWindowSpan(weeks, '2026-06-08', '2026-06-10'), { first: 1, count: 1 });
  assert.equal(eventWindowSpan(weeks, '2026-06-06', '2026-06-07'), null);
});
