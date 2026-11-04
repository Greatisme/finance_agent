import { collect, readJson } from './data.js';
import { audit } from './audit.js';
import { experiment } from './experiment.js';
import { report } from './report.js';

const command = process.argv[2];
if (!['collect', 'audit', 'experiment', 'all'].includes(command)) {
  console.error('Usage: node src/cli.js collect|audit|experiment|all');
  process.exitCode = 1;
} else {
  try {
    const config = await readJson('config/research.json');
    if (command === 'collect' || command === 'all') await collect(config);
    if (command !== 'collect') {
      const dataset = await readJson('data/normalized/dataset.json');
      // Refuse accidental config/data mismatch rather than silently changing the experiment.
      if (JSON.stringify(config) !== JSON.stringify(dataset.config)) throw new Error('Configuration changed: rerun collect first (raw requests are cached).');
      const audited = await audit(dataset);
      let result;
      if ((command === 'experiment' || command === 'all') && audited.gates.priceExperimentAllowed) result = await experiment(dataset, audited);
      await report(dataset, audited, result);
      console.log(`Audit allowed=${audited.gates.priceExperimentAllowed}; report: reports/research-report.md`);
      if (!audited.gates.priceExperimentAllowed) { console.error(audited.gates.issues); process.exitCode = 2; }
    }
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
