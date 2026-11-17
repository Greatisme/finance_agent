import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeViewport, zoomViewport } from '../web/chart-viewport.js';

test('history windows clamp at the first and final candle', () => {
  assert.deepEqual(normalizeViewport(30, 8.7, 100), { start: 21, count: 9 });
  assert.deepEqual(normalizeViewport(30, 1, -5), { start: 0, count: 8 });
  assert.deepEqual(normalizeViewport(5, 3, 2), { start: 0, count: 5 });
  assert.deepEqual(normalizeViewport(0, 15, 2), { start: 0, count: 0 });
});

test('zoom keeps the candle under the anchor when the bounds allow it', () => {
  assert.deepEqual(zoomViewport(300, { start: 120, count: 60 }, 20, 0.25), { start: 130, count: 20 });
  assert.deepEqual(zoomViewport(300, { start: 120, count: 60 }, 20, 0), { start: 120, count: 20 });
  assert.deepEqual(zoomViewport(300, { start: 120, count: 60 }, 20, 1), { start: 160, count: 20 });
  assert.deepEqual(zoomViewport(300, { start: 280, count: 20 }, 50, 0.5), { start: 250, count: 50 });
  assert.deepEqual(zoomViewport(0, { start: 0, count: 0 }, 10, 0.5), { start: 0, count: 0 });
});
