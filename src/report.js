import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { hash } from './data.js';

const num = value => Number.isFinite(value) ? value.toFixed(6) : 'n/a';
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
export async function report(dataset, audit, experiment) {
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const lines = [
    '# 真实数据审计与首轮基准实验', '',
    `生成时间（UTC）：${new Date().toISOString()}`, '',
    `数据截至：${dataset.config.asOf}；配置 SHA256：${hash(JSON.stringify(dataset.config))}；数据 SHA256：${audit.datasetSha256}。`, '',
    `运行时：${process.version}；运行前仓库 HEAD：${revision}（本次代码可能尚未提交，以随报告提交的源码为准）。`, '',
    '## 结论边界', '',
    '**本轮尚不能证明具备可投资的预测能力。** 本轮检查有限样本的行情、披露记录和日频概率模型。没有训练大模型，没有生成公司基本面数值，没有完成新闻全量采集、因果识别、收益回测或前瞻验证。', '',
    '样本是预先固定的 8 只当前存续公司，属于方便样本，含行业和幸存者偏差。历史退出证券仅做接口探测，未构成无偏股票池。', '',
    '## 行情可得性及交叉核对', '',
    '|证券|记录数|首日|末日|非法/重复|相对指数缺日|跨源重叠|OHLC不一致|成交量不一致|',
    '|---|---:|---|---|---:|---:|---:|---:|---:|'
  ];
  for (const [symbol, row] of Object.entries(audit.symbols)) lines.push(`|${symbol}|${row.count}|${row.first}|${row.last}|${row.invalid.length}/${row.duplicates.length}|${row.missingSessions.length}|${row.crossSource.overlap}|${row.crossSource.priceMismatchRows}|${row.crossSource.volumeMismatchRows}|`);
  lines.push('', '行情来源为腾讯公开网页数据接口，使用未复权 OHLC；新浪公开网页日线作为第二提供方交叉核对。两家提供方可能共享上游数据，数值一致不等于已获得交易所级认证。新浪历史条数有限，交叉核对仅覆盖重叠日期。', '',
    '成交量另行检验腾讯值 ×100 与新浪股数的关系；指数成交量口径可能不同，不能套用个股单位。相对指数缺失交易日不自动视为错误，可能是停牌或数据缺失；未经停复牌表核实。', '',
    '### 复权探测', '', '|证券|2016年前复权条数|非正价格条数|最低收盘价|', '|---|---:|---:|---:|');
  for (const [symbol, row] of Object.entries(audit.adjustmentProbes)) lines.push(`|${symbol}|${row.rows}|${row.nonPositivePrices}|${num(row.minimumClose)}|`);
  lines.push('', '前复权仅用于审计，不进入模型。未复权预测的目标是价格变化，不是含分红的总收益；除权除息等机械价格变化尚未分离，不能据此宣称可执行投资收益。', '',
    '## 公告与原文可得性', '',
    `取得 ${audit.events.count} 条去重后财报/业绩披露事件；完成 ${audit.events.coverageQueries}/${audit.events.expectedCoverageQueries} 个公司年度查询；分页未取完：${audit.events.truncatedQueries.length}；返回零条：${audit.events.zeroResultQueries.length}。`, '',
    `分类计数：${JSON.stringify(audit.events.byKind)}。原始接口记录 SHA256 与采集时间保存在本地 data/；PDF 抽查：${JSON.stringify(audit.pdfProbes.map(row => ({ id: row.id, status: row.status, bytes: row.bytes, pdfSignature: row.pdfSignature, error: row.error })))}。`, '',
    '公告先按现用名发现机构标识，再按证券代码与机构标识精确查询并逐页核对。零记录可能是真无记录，也可能是改名、检索或分类覆盖问题；不视为完整。日期是提供方披露日期，不证明盘中精确发布时间或首次可见时间。所有事件严格到披露日之后的下一指数交易日才可进入特征。历史修订与第一版本尚未独立核实。', '',
    'PDF 抽查只验证可下载及文件签名，不代表已审阅财务内容。当前模型使用“近期有无财报/业绩披露”的计数，不使用财报利好利空、超预期、机构真实身份等无法从本轮数据直接确定的内容。', '',
    `历史退出证券探测：${JSON.stringify(audit.historicalExitProbe)}。`, '',
    '## 数据源访问与限制', '',
    '- 腾讯/新浪：本机实际请求并保存原始响应；未验证商业再分发授权、服务 SLA 或历史版本完整性。',
    '- 巨潮：实际取得分类公告元数据并抽查原文链接；未证明全部相关事件已收集。',
    '- Tushare：已核查官方日线与财务字段文档；本轮未提供 token，未调用授权 API，未声称取得其数据。',
    '- 政策、国际事件、行业新闻、分钟线、机构/散户身份：未纳入本轮模型，覆盖尚未验证。', '',
    `价格实验自动门禁：${audit.gates.priceExperimentAllowed ? '通过本轮有限行情检查' : '未通过'}；问题：${JSON.stringify(audit.gates.issues)}。`, '',
    '## 验证设计', '',
    '每个预测于 t 日收盘后产生，目标为 t+1 日开盘到第 h 个指数交易日收盘的未复权价格收益是否大于 0（h=5、20）。交易日以本次取得的沪深300日期为代理，缺少必要行情的窗口明确排除。不假设按 t 日收盘价成交。', '',
    '2024、2025、2026 三个年度依次测试：更早年份训练，测试前一年单独校准概率；训练标签不能跨入校准区，校准标签不能跨入测试区。标准化仅拟合训练集。超参数在运行前固定，没有根据测试指标搜索模型。后续如利用这些结果调参，它们就成为开发集，不能继续当独立最终测试集。', '',
    '模型：上一校准年上涨频率（base）、动量逻辑回归、行情逻辑回归、行情+披露事件逻辑回归。事件增益用同一样本的 Brier 差值比较。置信区间采用同日股票整体成组、40/20交易日块自助法，考虑部分时间/横截面依赖，仍不是多重试验校正后的显著性承诺。', '',
    '无大模型参与历史特征生成，避免本轮引入大模型预训练记忆污染；未来引入语义模型需要额外控制并进行冻结版本后的前瞻验证。', '');
  if (experiment) {
    lines.push('## 本轮发现', '',
      '本轮两个期限的行情模型相对基础概率、披露事件模型相对行情模型的 Brier 改善区间均包含零，尚未形成稳定预测增益的证据。该结论只针对当前简单模型与方便样本，不代表已检验完整事件语义方案。', '',
      '另一个无需训练的参考是始终输出50%：二分类 Brier 恒为0.25。本轮所有模型的合并测试 Brier 均高于0.25，因此不能用相对上一年度基础概率的小幅改善宣称模型已有优势。该参考为结果解释，不用于选择或重新调参。', '');
    lines.push('## 实验结果', '', '|期限|模型|测试样本|准确率|Brier↓|Log loss↓|校准误差↓|', '|---|---|---:|---:|---:|---:|---:|');
    for (const result of experiment.results) {
      for (const [name, row] of Object.entries(result.aggregate)) lines.push(`|${result.horizon}交易日|${name}|${row.n}|${percent(row.accuracy)}|${num(row.brier)}|${num(row.logLoss)}|${num(row.expectedCalibrationError)}|`);
    }
    lines.push('', '准确率针对正收益二分类；不代表选股胜率、可实现收益或所有投资意见的准确度。Brier 是概率误差，越低越好。各预测标签存在重叠，不把每行当作独立证据。', '',
      '|期限|行情相对base的Brier差|95%块区间|事件相对行情的Brier差|95%块区间|各年一致改善且区间小于0|', '|---|---:|---|---:|---|---|');
    for (const row of experiment.results) lines.push(`|${row.horizon}|${num(row.pricesVsBase.deltaBrier)}|[${num(row.pricesVsBase.lower95)}, ${num(row.pricesVsBase.upper95)}]|${num(row.eventsVsPrices.deltaBrier)}|[${num(row.eventsVsPrices.lower95)}, ${num(row.eventsVsPrices.upper95)}]|${row.eventIncrementSupportedOnThisSample ? '是（限此样本）' : '否'}|`);
    lines.push('', '### 各年度结果', '', '|期限|年份|训练/校准/测试|base Brier|行情 Brier|行情+事件 Brier|', '|---|---|---|---:|---:|---:|');
    for (const row of experiment.results) for (const fold of row.folds) lines.push(`|${row.horizon}|${fold.year}|${fold.counts.train}/${fold.counts.calibration}/${fold.counts.test}|${num(fold.metrics.base.brier)}|${num(fold.metrics.prices.brier)}|${num(fold.metrics.prices_events.brier)}|`);
    lines.push('', '### 窗口排除', '', ...experiment.results.map(row => `- ${row.horizon}日：${JSON.stringify(row.exclusions)}。无法获得目标窗口时的排除可能造成选择偏差，不等于已证明可成交。`));
  } else lines.push('## 实验状态', '', '行情数据门禁未通过，未输出预测指标；应先处理审计发现。');
  lines.push('', '## 下一步通过条件', '',
    '1. 建立历史时点股票池、退市与停复牌覆盖，并验证交易日历、复权/分红和交易约束。',
    '2. 对更大样本的独立数据源检查异常，补齐公告改名和历史版本，抽样核对财报内容。',
    '3. 在冻结的新测试区间检验事件语义特征是否带来稳定增益，保留失败实验，不反复使用同一测试集调参。',
    '4. 固定模型、保存每次真实未来的预测，再验证概率校准和可执行策略的成本后效果。', '',
    '## 参考来源', '',
    '- [Tushare 日线官方文档](https://tushare.pro/document/2?doc_id=27)',
    '- [Tushare 财务指标官方文档](https://tushare.pro/document/2?doc_id=79)',
    '- [巨潮资讯](https://www.cninfo.com.cn/)',
    '- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)',
    '- [The Memorization Problem: Can We Trust LLMs’ Economic Forecasts?](https://arxiv.org/abs/2504.14765)', '');
  await mkdir('reports', { recursive: true });
  await writeFile('reports/research-report.md', lines.join('\n'));
}
