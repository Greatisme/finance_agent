export const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
export const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, value))));
export const FEATURE_NAMES = ['return1', 'return5', 'return20', 'return60', 'volatility20', 'volumeRatio20', 'range', 'marketReturn1', 'marketReturn5', 'marketReturn20', 'relativeReturn20', 'report1', 'report5', 'report20', 'forecast1', 'forecast5', 'forecast20'];

export function eventFeatures(events, symbol, dates, index) {
  // Date-only disclosure records cannot justify same-day availability. Use the next market session.
  const relevant = events.filter(event => event.symbol === symbol && event.disclosureDate < dates[index]);
  return ['financial_report', 'forecast'].flatMap(kind => [1, 5, 20].map(window => {
    const lower = dates[index - window] ?? '';
    return relevant.filter(event => (kind === 'forecast' ? event.kind !== 'financial_report' : event.kind === kind) && event.disclosureDate >= lower).length;
  }));
}

export function buildSamples(dataset, horizon) {
  const config = dataset.config;
  const market = dataset.prices[config.benchmark].rows;
  const dates = market.map(row => row.date), samples = [];
  const exclusions = { unavailableLookback: 0, unavailableTarget: 0 };
  for (const stock of config.stocks) {
    const map = new Map(dataset.prices[stock.symbol].rows.map(row => [row.date, row]));
    for (let index = 60; index + horizon < dates.length; index++) {
      const history = dates.slice(index - 60, index + 1).map(date => map.get(date));
      if (history.some(row => !row || row.close <= 0 || row.open <= 0)) { exclusions.unavailableLookback++; continue; }
      // Missing exit/entry bars are reported as exclusions, not silently filled or executed.
      const future = dates.slice(index + 1, index + horizon + 1).map(date => map.get(date));
      if (future.some(row => !row || row.close <= 0 || row.open <= 0)) { exclusions.unavailableTarget++; continue; }
      const current = history.at(-1), ret = lag => current.close / history[60 - lag].close - 1;
      const returns = history.slice(-21).slice(1).map((row, i) => row.close / history[40 + i].close - 1);
      const avg = mean(returns), volatility = Math.sqrt(mean(returns.map(value => (value - avg) ** 2)));
      const marketRet = lag => market[index].close / market[index - lag].close - 1;
      const volumeAvg = mean(history.slice(-20).map(row => row.volume));
      const features = [ret(1), ret(5), ret(20), ret(60), volatility,
        volumeAvg > 0 ? current.volume / volumeAvg - 1 : 0, (current.high - current.low) / current.close,
        marketRet(1), marketRet(5), marketRet(20), ret(20) - marketRet(20),
        ...eventFeatures(dataset.events, stock.symbol, dates, index)];
      const priceReturn = future.at(-1).close / future[0].open - 1;
      if (!features.every(Number.isFinite)) throw new Error('Nonfinite feature');
      samples.push({ symbol: stock.symbol, date: current.date, entryDate: future[0].date,
        labelEnd: future.at(-1).date, priceReturn, y: +(priceReturn > config.threshold), features });
    }
  }
  return { samples: samples.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol)), exclusions };
}

// All scaling parameters and coefficients are fit using training rows only.
export function fitLogistic(samples, columns, config) {
  if (!samples.length) throw new Error('Empty training set');
  const centers = columns.map(column => mean(samples.map(row => row.features[column])));
  const scales = columns.map((column, i) => Math.max(1e-8, Math.sqrt(mean(samples.map(row => (row.features[column] - centers[i]) ** 2)))));
  const transform = row => columns.map((column, i) => Math.max(-8, Math.min(8, (row.features[column] - centers[i]) / scales[i])));
  const x = samples.map(transform), weights = Array(columns.length).fill(0);
  const rate = Math.max(1e-6, Math.min(1 - 1e-6, mean(samples.map(row => row.y))));
  let intercept = Math.log(rate / (1 - rate));
  for (let step = 0; step < config.iterations; step++) {
    const gradient = weights.map(() => 0); let biasGradient = 0;
    for (let i = 0; i < samples.length; i++) {
      const prediction = sigmoid(intercept + weights.reduce((sum, w, j) => sum + w * x[i][j], 0));
      const error = prediction - samples[i].y;
      biasGradient += error;
      for (let j = 0; j < weights.length; j++) gradient[j] += error * x[i][j];
    }
    intercept -= config.learningRate * biasGradient / samples.length;
    for (let j = 0; j < weights.length; j++) weights[j] -= config.learningRate * (gradient[j] / samples.length + config.ridge * weights[j]);
  }
  return { columns, centers, scales, weights, intercept,
    predict: row => sigmoid(intercept + weights.reduce((sum, w, j) => sum + w * transform(row)[j], 0)) };
}

export function fitCalibration(model, samples) {
  let slope = 1, intercept = 0;
  const logits = samples.map(row => { const p = Math.max(1e-6, Math.min(1 - 1e-6, model.predict(row))); return Math.log(p / (1 - p)); });
  for (let step = 0; step < 300; step++) {
    let da = 0, db = 0;
    for (let i = 0; i < samples.length; i++) { const error = sigmoid(slope * logits[i] + intercept) - samples[i].y; da += error * logits[i]; db += error; }
    slope = Math.max(0, slope - 0.1 * (da / samples.length + 0.01 * (slope - 1)));
    intercept -= 0.1 * db / samples.length;
  }
  return { slope, intercept, predict: row => {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, model.predict(row)));
    return sigmoid(slope * Math.log(p / (1 - p)) + intercept);
  } };
}

export function metrics(rows) {
  if (!rows.length) throw new Error('No evaluation rows');
  const clipped = rows.map(row => ({ ...row, p: Math.max(1e-9, Math.min(1 - 1e-9, row.p)) }));
  const bins = Array.from({ length: 10 }, (_, i) => {
    const subset = clipped.filter(row => Math.min(9, Math.floor(row.p * 10)) === i);
    return { lower: i / 10, upper: (i + 1) / 10, count: subset.length,
      meanPrediction: subset.length ? mean(subset.map(row => row.p)) : null, observedRate: subset.length ? mean(subset.map(row => row.y)) : null };
  });
  return { n: rows.length, positiveRate: mean(rows.map(row => row.y)),
    accuracy: mean(rows.map(row => +((row.p >= 0.5) === !!row.y))),
    brier: mean(rows.map(row => (row.p - row.y) ** 2)),
    logLoss: -mean(clipped.map(row => row.y * Math.log(row.p) + (1 - row.y) * Math.log(1 - row.p))),
    expectedCalibrationError: bins.reduce((sum, bin) => sum + bin.count * Math.abs((bin.meanPrediction ?? 0) - (bin.observedRate ?? 0)), 0) / rows.length,
    bins };
}

// Date-block bootstrap keeps all stocks on a date together and overlapping horizon labels in blocks.
export function pairedBlockInterval(rows, fieldA, fieldB, blockLength, replicates, seed) {
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.date)) grouped.set(row.date, []);
    grouped.get(row.date).push((row[fieldA] - row.y) ** 2 - (row[fieldB] - row.y) ** 2);
  }
  const dates = [...grouped.keys()].sort(), deltas = [];
  for (let repeat = 0; repeat < replicates; repeat++) {
    let count = 0, total = 0, sampledDates = 0;
    while (sampledDates < dates.length) {
      const start = Math.floor(random() * dates.length);
      for (let k = 0; k < blockLength && sampledDates < dates.length; k++, sampledDates++) {
        for (const value of grouped.get(dates[(start + k) % dates.length])) { total += value; count++; }
      }
    }
    deltas.push(total / count);
  }
  deltas.sort((a, b) => a - b);
  return { deltaBrier: mean(rows.map(row => (row[fieldA] - row.y) ** 2 - (row[fieldB] - row.y) ** 2)),
    lower95: deltas[Math.floor(replicates * 0.025)], upper95: deltas[Math.min(replicates - 1, Math.floor(replicates * 0.975))],
    blockLength, replicates, method: 'paired circular date-block bootstrap; descriptive, not adjusted for multiple testing' };
}
