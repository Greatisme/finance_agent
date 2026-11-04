import { saveJson } from './data.js';
import { buildSamples, fitLogistic, fitCalibration, metrics, mean, pairedBlockInterval, FEATURE_NAMES } from './model.js';

export function chronologicalSplit(samples, testYear) {
  const calibrationStart = `${testYear - 1}-01-01`, testStart = `${testYear}-01-01`, testEnd = `${testYear}-12-31`;
  return {
    // Labels must be fully observed BEFORE the next partition starts; boundary overlaps are purged.
    train: samples.filter(row => row.date < calibrationStart && row.labelEnd < calibrationStart),
    calibration: samples.filter(row => row.date >= calibrationStart && row.date < testStart && row.labelEnd < testStart),
    test: samples.filter(row => row.date >= testStart && row.labelEnd <= testEnd)
  };
}

export async function experiment(dataset, audit) {
  if (!audit.gates.priceExperimentAllowed) throw new Error(`Audit gate failed: ${audit.gates.issues.join(', ')}. Inspect reports/data-audit.json; no silent override.`);
  const config = dataset.config, results = [], allPredictions = [];
  const definitions = { momentum: [0, 1, 2, 3], prices: Array.from({ length: 11 }, (_, i) => i), prices_events: FEATURE_NAMES.map((_, i) => i) };
  for (const horizon of config.horizons) {
    const { samples, exclusions } = buildSamples(dataset, horizon), predictions = [], folds = [];
    for (const year of config.testYears) {
      const { train, calibration, test } = chronologicalSplit(samples, year);
      if (train.length < 1000 || calibration.length < 500 || test.length < 100) throw new Error(`Insufficient data for horizon=${horizon}, year=${year}`);
      // Strong simple baseline: last completed calibration year's empirical positive rate.
      const base = mean(calibration.map(row => row.y));
      const models = {}, modelDetails = {};
      for (const [name, columns] of Object.entries(definitions)) {
        const model = fitLogistic(train, columns, config), calibrated = fitCalibration(model, calibration);
        models[name] = calibrated;
        modelDetails[name] = {
          columns: columns.map(column => FEATURE_NAMES[column]), centers: model.centers, scales: model.scales,
          weights: model.weights, intercept: model.intercept,
          calibration: { slope: calibrated.slope, intercept: calibrated.intercept }
        };
      }
      const rows = test.map(row => ({ symbol: row.symbol, date: row.date, entryDate: row.entryDate,
        labelEnd: row.labelEnd, y: row.y, priceReturn: row.priceReturn, base,
        ...Object.fromEntries(Object.entries(models).map(([name, model]) => [name, model.predict(row)])) }));
      predictions.push(...rows);
      folds.push({ year, counts: { train: train.length, calibration: calibration.length, test: test.length },
        boundaries: { trainLatestLabel: train.at(-1).labelEnd, calibrationFirstDate: calibration[0].date,
          calibrationLatestLabel: calibration.at(-1).labelEnd, testFirstDate: test[0].date, testLastLabel: test.at(-1).labelEnd },
        metrics: Object.fromEntries(['base', ...Object.keys(definitions)].map(name => [name, metrics(rows.map(row => ({ y: row.y, p: row[name] })))])),
        baseProbability: base, models: modelDetails });
      console.log(`experiment h=${horizon} year=${year}: train=${train.length}, calibration=${calibration.length}, test=${test.length}`);
    }
    const aggregate = Object.fromEntries(['base', ...Object.keys(definitions)].map(name => [name, metrics(predictions.map(row => ({ y: row.y, p: row[name] })))]));
    const pricesVsBase = pairedBlockInterval(predictions, 'prices', 'base', Math.max(20, horizon * 2), config.bootstrapReplicates, config.seed);
    const eventsVsPrices = pairedBlockInterval(predictions, 'prices_events', 'prices', Math.max(20, horizon * 2), config.bootstrapReplicates, config.seed);
    const bySymbol = Object.fromEntries(config.stocks.map(stock => {
      const rows = predictions.filter(row => row.symbol === stock.symbol);
      return [stock.symbol, Object.fromEntries(['base', 'prices', 'prices_events'].map(name => [name, metrics(rows.map(row => ({ y: row.y, p: row[name] })))]))];
    }));
    results.push({ horizon, exclusions, aggregate, folds, bySymbol, pricesVsBase, eventsVsPrices,
      eventIncrementSupportedOnThisSample: eventsVsPrices.upper95 < 0 && folds.every(fold => fold.metrics.prices_events.brier < fold.metrics.prices.brier) });
    allPredictions.push(...predictions.map(row => ({ horizon, ...row })));
  }
  const output = {
    generatedAt: new Date().toISOString(), datasetSha256: audit.datasetSha256,
    target: 'At after-close signal date t, raw price return from next market session open to close of session t+h; positive iff return > 0. No dividends reinvested.',
    method: 'Expanding annual folds, one prior year reserved for Platt calibration; labels purged at boundaries; fixed configuration; no test-set tuning.',
    results,
    conclusion: 'Retrospective convenience-sample feasibility experiment only; no claim of causal event attribution, executable alpha, complete evidence or live predictive ability.',
    investmentReady: false,
    limitations: audit.gates.blockers,
    prospectiveValidationRequired: true
  };
  await saveJson('reports/experiment.json', output);
  await saveJson('reports/predictions.json', allPredictions);
  return output;
}
