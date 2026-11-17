import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson } from './data.js';

const execute = promisify(execFile);
const operations = new Map([
  ['collect', '采集行情和公告，更新本地研究数据'],
  ['audit', '审计数据质量'],
  ['experiment', '运行日频预测基准实验'],
  ['all', '采集、审计并运行实验']
]);
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const dynamicTools = [
  {
    name: 'finance_run',
    description: [...operations].map(([op, description]) => `${op}：${description}`).join('；'),
    inputSchema: schema({ operation: { type: 'string', enum: [...operations.keys()] } }, ['operation'])
  },
  {
    name: 'finance_read',
    description: '读取研究配置、数据审计、实验摘要或指定股票的历史测试预测。历史预测仅用于研究。',
    inputSchema: schema({
      resource: { type: 'string', enum: ['config', 'audit', 'experiment', 'predictions'] },
      symbol: { type: 'string', description: '读取预测时必填，例如 sh600519' },
      horizon: { type: 'integer', enum: [5, 20] }
    }, ['resource'])
  }
];

let running = false;
export async function callFinanceTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数须为对象');
  if (name === 'finance_run') {
    if (!operations.has(args.operation)) throw new Error('未知研究操作');
    if (running) throw new Error('已有研究操作在运行，请等待完成');
    running = true;
    try {
      const { stdout } = await execute(process.execPath, ['src/cli.js', args.operation], {
        timeout: 15 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true
      });
      return { output: stdout.trim().slice(-12_000) };
    } catch (error) {
      throw new Error(`研究操作失败：${(error.stderr || error.message).trim().slice(-4000)}`);
    } finally { running = false; }
  }
  if (name !== 'finance_read') throw new Error('未知工具');
  switch (args.resource) {
    case 'config': return readJson('config/research.json');
    case 'audit': {
      const audit = await readJson('reports/data-audit.json');
      return { asOf: audit.asOf, gates: audit.gates, events: audit.events,
        symbols: Object.fromEntries(Object.entries(audit.symbols).map(([symbol, row]) => [symbol, {
          count: row.count, first: row.first, last: row.last, missingSessions: row.missingSessions.length,
          crossSource: row.crossSource
        }])) };
    }
    case 'experiment': {
      const experiment = await readJson('reports/experiment.json');
      return { target: experiment.target, method: experiment.method, limitations: experiment.limitations,
        investmentReady: experiment.investmentReady, results: experiment.results.map(result => ({
          horizon: result.horizon,
          metrics: Object.fromEntries(Object.entries(result.aggregate).map(([model, { n, accuracy, brier, logLoss }]) =>
            [model, { n, accuracy, brier, logLoss }])),
          pricesVsBase: result.pricesVsBase, eventsVsPrices: result.eventsVsPrices
        })) };
    }
    case 'predictions': {
      if (!/^(sh|sz)\d{6}$/.test(args.symbol ?? '') || ![5, 20].includes(args.horizon)) {
        throw new Error('预测查询需要 symbol 和 horizon');
      }
      const predictions = await readJson('reports/predictions.json');
      return predictions.filter(row => row.symbol === args.symbol && row.horizon === args.horizon).slice(-10);
    }
    default: throw new Error('未知研究资源');
  }
}
