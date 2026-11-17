const MIN_CANDLES = 8;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeViewport(total, count, start) {
  total = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const visibleCount = clamp(Math.round(count) || 0, Math.min(MIN_CANDLES, total), total);
  return { start: clamp(Math.round(start) || 0, 0, total - visibleCount), count: visibleCount };
}

export function zoomViewport(total, viewport, nextCount, anchor = 0.5) {
  const current = normalizeViewport(total, viewport.count, viewport.start);
  const next = normalizeViewport(total, nextCount, 0);
  if (!current.count) return next;

  const fraction = clamp(Number.isFinite(anchor) ? anchor : 0.5, 0, 1);
  const currentSlot = Math.min(current.count - 1, Math.floor(fraction * current.count));
  const nextSlot = Math.min(next.count - 1, Math.floor(fraction * next.count));
  return normalizeViewport(total, next.count, current.start + currentSlot - nextSlot);
}
