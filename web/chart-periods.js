function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function periodStart(date, period) {
  if (period === 'month') return date.slice(0, 7) + '-01';
  const monday = new Date(date + 'T00:00:00Z');
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return isoDate(monday);
}

function periodEnd(start, period) {
  const end = new Date(start + 'T00:00:00Z');
  if (period === 'week') end.setUTCDate(end.getUTCDate() + 6);
  else end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return isoDate(end);
}

export function chartPeriodRows(dailyRows, period) {
  if (period === 'day') return dailyRows;

  const candles = [];
  for (const row of dailyRows) {
    const start = periodStart(row.date, period);
    const candle = candles.at(-1);
    if (candle?.periodStart === start) {
      candle.date = row.date;
      candle.close = row.close;
      candle.high = Math.max(candle.high, row.high);
      candle.low = Math.min(candle.low, row.low);
      candle.volume += row.volume;
      continue;
    }
    candles.push({
      date: row.date, startDate: row.date, periodStart: start, periodEnd: periodEnd(start, period),
      open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume
    });
  }

  let previousVolume = 0;
  for (const [index, candle] of candles.entries()) {
    candle.previousClose = candles[index - 1]?.close ?? null;
    candle.returnPct = candle.previousClose === null ? null : (candle.close / candle.previousClose - 1) * 100;
    candle.volumeMultiple = index >= 20 && previousVolume > 0 ? candle.volume * 20 / previousVolume : null;
    previousVolume += candle.volume - (candles[index - 20]?.volume ?? 0);
  }
  return candles;
}

export function chartEventIndex(rows, date) {
  const first = rows[0];
  if (!first || date < (first.periodStart ?? first.date) || date > rows.at(-1).date) return -1;
  return rows.findIndex(row => date <= (row.periodEnd ?? row.date));
}

export function eventWindowSpan(rows, start, end) {
  const first = rows.findIndex(row => row.date >= start);
  if (first < 0) return null;
  let after = first;
  while (after < rows.length && (rows[after].startDate ?? rows[after].date) <= end) after++;
  return after > first ? { first, count: after - first } : null;
}
