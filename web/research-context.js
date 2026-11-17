const root=document.getElementById('research-overview');
let request=0, current=null;
const price=value=>value==null?'—':value.toFixed(2);
const pct=value=>value==null?'—':(value>0?'+':'')+price(value)+'%';
const money=value=>value==null?'—':Math.abs(value)>=1e8?(value/1e8).toFixed(2)+' 亿':(value/1e4).toFixed(2)+' 万';

function el(tag,text,className) {
  const item=document.createElement(tag);
  if(text!=null)item.textContent=text;
  if(className)item.className=className;
  return item;
}
function link(text,url) {
  const a=el('a',text);
  a.href=url;a.target='_blank';a.rel='noopener noreferrer';
  return a;
}
function card(title,expanded=false) {
  const box=el('details',null,'overview-card');
  box.open=expanded;
  box.append(el('summary',title));
  return box;
}

async function get(endpoint,params) {
  const response=await fetch('/api/'+endpoint+'?'+new URLSearchParams(params));
  if(!response.ok)throw new Error('数据暂不可用。');
  return response.json();
}

export function displayTrades(target,data) {
  target.replaceChildren();
  for(const row of data.rows)target.append(el('p',row.reason+' · 买入 '+money(row.buy)+'元 · 卖出 '+money(row.sell)+'元 · 净额 '+money(row.net)+'元'));
  for(const row of data.seats){
    const p=el('p','机构专用 · 买入 '+money(row.buy)+'元 · 卖出 '+money(row.sell)+'元 · 净额 '+money(row.net)+'元 ');
    p.append(link('席位明细',row.url));
    target.append(p);
  }
  if(!data.rows.length)target.append(el('p','未查到该日上榜记录。'));
  else if(!data.seats.length)target.append(el('p','已取得的披露中未找到机构专用明细。'));
  if(data.incompleteSeats)target.append(el('p','部分席位明细暂未取得。'));
  target.append(link('交易公开数据出处',data.url));
}

function valueCard(data,stock) {
  const value=data.value;
  const box=el('section',null,'value-card');
  box.append(el('h2',stock.name+' · 公司价值'),el('p',stock.code+' · 长期研究 · 截至 '+data.asOf,'overview-meta'));
  if(!value){
    box.append(el('p',data.availability.value?'暂无已披露的可用财报。':'财报数据源暂不可用。'));
    return box;
  }
  box.append(el('p',value.kind+' · 报告期 '+value.period+' · 披露 '+value.disclosed));
  const grid=el('dl',null,'value-grid');
  const pb=value.bookPerShare>0&&data.technical ? data.technical.close/value.bookPerShare : null;
  const facts=[
    ['营业收入',money(value.revenue),value.revenueYoY==null?'':'同比 '+pct(value.revenueYoY)],
    ['归母净利润',money(value.netProfit),value.profitYoY==null?'':'同比 '+pct(value.profitYoY)],
    ['加权 ROE',value.roe==null?'—':price(value.roe)+'%',''],
    ['资产负债率',value.debtRatio==null?'—':price(value.debtRatio)+'%',''],
    ['每股经营现金流',price(value.operatingCashPerShare),'元'],
    ['市净率参考',pb==null?'—':price(pb)+' 倍',data.technical?data.technical.date+' 收盘价／每股净资产':'']
  ];
  for(const [label,amount,note] of facts){
    const metric=el('div');
    metric.append(el('dt',label),el('dd',amount));
    if(note)metric.append(el('small',note));
    grid.append(metric);
  }
  box.append(grid);
  if(value.revenueYoY!=null&&value.profitYoY!=null)box.append(el('p','营收同比 '+pct(value.revenueYoY)+'，归母净利润同比 '+pct(value.profitYoY)+'。'));
  if(value.eps!=null&&value.operatingCashPerShare!=null)box.append(el('p','每股经营现金流 '+price(value.operatingCashPerShare)+' 元，对照每股收益 '+price(value.eps)+' 元，关注利润与现金回收是否同步。'));
  box.append(link('财报指标出处',value.url));
  if(value.filing)box.append(' · ',link('公司财报原文',value.filing.url));
  else box.append(' · 未匹配到该期报告原文');
  if(data.comparable.length>1){
    const trend=card('历年同期财报对照 · '+data.comparable.length+' 期',true);
    const wrap=el('div',null,'table-scroll'), table=el('table');
    const head=table.createTHead().insertRow(), body=table.createTBody();
    for(const label of ['报告期','营收','归母净利润','每股经营现金流'])head.append(el('th',label));
    for(const item of data.comparable){
      const row=body.insertRow();
      for(const value of [item.period,money(item.revenue),money(item.netProfit),price(item.operatingCashPerShare)])row.insertCell().textContent=value;
    }
    wrap.append(table);
    trend.append(wrap);
    box.append(trend);
  }
  return box;
}

function tradeHistory(data,stock) {
  const box=card('公开买卖 · 龙虎榜历史',true);
  if(!data.list){
    box.append(el('p','交易公开数据暂不可用。'));
    return box;
  }
  box.append(el('p',data.list.since+' 至 '+data.list.asOf+' · 最近 '+data.list.days.length+' 个披露日（最多 12 个）。席位明细仅覆盖公开成交，重叠上榜原因可能覆盖相同成交。'));
  if(!data.list.days.length)box.append(el('p','本次未查到上榜记录，机构交易情况未知。'));
  for(const [index,item] of data.list.days.entries()){
    const day=card(item.date+' · '+item.reasons.join('；'),index===0);
    const target=el('div');
    day.append(target);
    let state='idle';
    async function load() {
      if(!day.open||state!=='idle')return;
      state='loading';
      target.textContent='正在查询席位明细…';
      try{
        const trades=index===0&&data.list.latest?data.list.latest:await get('disclosed-trades',{symbol:stock.symbol,date:item.date});
        displayTrades(target,trades);
        state='done';
      }catch{target.textContent='席位明细暂不可用，折叠后重试。';state='idle';}
    }
    day.addEventListener('toggle',load);
    void load();
    box.append(day);
  }
  box.append(link('历史披露数据出处',data.list.url));
  return box;
}

const forecastHorizons=[{sessions:1,label:'日'},{sessions:5,label:'周'},{sessions:20,label:'月'}];

function formatForecastNumber(value,digits) {
  return Number.isFinite(value)?value.toFixed(digits):'—';
}

function formatForecastProbability(value) {
  return Number.isFinite(value)?formatForecastNumber(value*100,1)+'%':'—';
}

function formatForecastPrice(value) {
  return Number.isFinite(value)?price(value)+' 元':'—';
}

function forecastOpinion(horizon) {
  if(!Number.isFinite(horizon?.upProbability))return ['insufficient','数据不足'];
  if(!horizon.validation?.signalSupported)return ['weak','观察 · 样本外信号弱'];
  if(horizon.conclusion==='bullish')return ['bullish','偏多'];
  if(horizon.conclusion==='bearish')return ['bearish','偏空'];
  return ['neutral','中性'];
}

function forecastEvidence(rows,forecast) {
  const details=el('details',null,'forecast-evaluation');
  details.append(el('summary','估计区间与样本外检验'));
  const modelId=[forecast.model?.id,forecast.model?.version].filter(Boolean).join(' · ');
  if(modelId)details.append(el('p','模型版本 '+modelId,'forecast-note'));
  if(forecast.inputFingerprint){
    const line=el('p','输入指纹 ','forecast-note');
    line.append(el('code',forecast.inputFingerprint));
    details.append(line);
  }
  if(forecast.history?.start)details.append(el('p','行情样本 '+forecast.history.sessions+' 个收盘 · '+forecast.history.start+' 至 '+forecast.asOf,'forecast-note'));
  if(forecast.model?.method)details.append(el('p',forecast.model.method));
  for(const {label,sessions,result} of rows){
    if(!result)continue;
    const section=el('section',null,'forecast-evaluation-row');
    section.append(el('h3',label+' · '+sessions+' 个交易日'));
    const range=result.range;
    const validation=result.validation;
    if(Number.isFinite(range?.low)&&Number.isFinite(range.high)){
      section.append(el('p','期末价格估计区间 '+price(range.low)+'–'+price(range.high)+' 元'+
        (Number.isFinite(range.coverage)?' · 名义覆盖率 '+formatForecastProbability(range.coverage):'')));
    }
    if(Number.isFinite(result.downProbability)){
      section.append(el('p','下跌概率 '+formatForecastProbability(result.downProbability)+'，持平 '+formatForecastProbability(Math.max(0,1-result.upProbability-result.downProbability))+'。'));
    }
    if(Number.isFinite(result.trainingSamples))section.append(el('p','训练样本 '+result.trainingSamples+' 条'));
    if(Number.isFinite(validation?.samples)&&validation.samples>0){
      const dateRange=validation.start&&validation.end?' · '+validation.start+' 至 '+validation.end:'';
      section.append(el('p','样本外 '+validation.samples+' 条'+dateRange));
      if(Number.isFinite(validation.brier)&&Number.isFinite(validation.baselineBrier)){
        section.append(el('p','Brier 评分 '+formatForecastNumber(validation.brier,3)+' · 基准 '+formatForecastNumber(validation.baselineBrier,3)+'（越低越好）'));
      }
      if(Number.isFinite(validation.maePct)&&Number.isFinite(validation.baselineMaePct)){
        section.append(el('p','涨跌幅平均绝对误差 '+formatForecastNumber(validation.maePct,2)+' · 基准 '+formatForecastNumber(validation.baselineMaePct,2)+' 个百分点'));
      }
      const outcomes=[];
      if(Number.isFinite(validation.directionalAccuracy))outcomes.push('方向命中率 '+formatForecastProbability(validation.directionalAccuracy));
      if(Number.isFinite(validation.rangeCoverage))outcomes.push('区间实际覆盖率 '+formatForecastProbability(validation.rangeCoverage));
      if(outcomes.length)section.append(el('p',outcomes.join(' · ')));
    }else section.append(el('p','样本外检验数据不足。'));
    const institutions=result.institutionValidation;
    if(institutions?.samples>0){
      section.append(el('p','机构席位增量检验 '+institutions.samples+' 条 · Brier '+formatForecastNumber(institutions.brier,3)+
        ' · 同期纯行情 '+formatForecastNumber(institutions.baselineBrier,3)+'。'));
    }
    details.append(section);
  }
  for(const line of forecast.model?.limitations??[])details.append(el('p',line,'forecast-note'));
  return details;
}

function isForecastSource(url) {
  return typeof url==='string'&&/^https?:\/\//i.test(url);
}

function forecastDrivers(drivers) {
  const section=el('section',null,'forecast-drivers');
  section.append(el('h3','模型输入与研究依据'));
  const uses={model:'模型输入',context:'研究参考',missing:'待核实'};
  for(const driver of drivers){
    const item=el('div',null,'forecast-driver');
    const heading=el('div',null,'forecast-driver-title');
    const label=el('span',uses[driver.use]??'待核实','forecast-driver-status');
    label.dataset.use=driver.use;
    heading.append(el('strong',driver.label),label);
    item.append(heading);
    if(driver.detail)item.append(el('p',driver.detail));
    const sources=(driver.sources??[]).filter(source=>isForecastSource(source.url));
    if(sources.length){
      const links=el('div',null,'forecast-driver-links');
      for(const source of sources)links.append(link(source.label??'查看数据出处',source.url));
      item.append(links);
    }
    section.append(item);
  }
  return section;
}

function forecastCard(forecast) {
  const box=card('走势预测与投资意见',true);
  box.classList.add('forecast-card');
  if(forecast?.asOf&&Number.isFinite(forecast.basePrice)){
    box.append(el('p',forecast.asOf+' 收盘 · 基准价 '+formatForecastPrice(forecast.basePrice),'overview-meta'));
  }
  const rows=forecastHorizons.map(horizon=>({...horizon,result:forecast?.horizons?.find(item=>item.sessions===horizon.sessions)}));
  const hasEstimates=rows.some(({result})=>Number.isFinite(result?.upProbability));
  if(!hasEstimates)box.append(el('p',forecast?.reason??'暂未取得可用的预测数据。'));
  const wrap=el('div',null,'table-scroll forecast-table');
  const table=el('table');
  table.setAttribute('aria-label','日、周、月走势预测');
  const head=table.createTHead().insertRow();
  for(const label of ['周期','上涨概率','预期涨跌','预期价格']){
    const header=el('th',label);
    header.scope='col';
    head.append(header);
  }
  const body=table.createTBody();
  for(const {label,sessions,result} of rows){
    const row=body.insertRow();
    const period=el('th',label);
    period.scope='row';
    period.append(el('small',sessions+' 日'));
    const change=result?.expectedReturnPct;
    row.append(period,el('td',formatForecastProbability(result?.upProbability)),
      el('td',Number.isFinite(change)?pct(change):'—',change>0?'up':change<0?'down':''),
      el('td',formatForecastPrice(result?.expectedPrice)));
  }
  wrap.append(table);
  box.append(wrap,el('p','日、周、月分别为未来 1、5、20 个交易日。上涨指期末收盘高于基准价。','forecast-note'));
  const opinion=el('div',null,'forecast-opinions');
  opinion.setAttribute('aria-label','分周期研究意见');
  for(const {label,result} of rows){
    const [tone,summary]=forecastOpinion(result);
    const item=el('span',label+' · '+summary);
    item.dataset.tone=tone;
    opinion.append(item);
  }
  box.append(opinion);
  if(hasEstimates||rows.some(({result})=>result?.validation?.samples)){
    if(forecast.model?.label)box.append(el('p',forecast.model.label+(forecast.model.priceBasis?' · '+forecast.model.priceBasis:''),'forecast-note'));
    box.append(forecastEvidence(rows,forecast));
  }
  if(isForecastSource(forecast?.source?.url))box.append(link('预测行情数据出处',forecast.source.url));
  if(forecast?.drivers?.length)box.append(forecastDrivers(forecast.drivers));
  return box;
}

function render(data,stock) {
  const timeline=card('多空证据时间线 · '+data.events.length+' 条',true);
  const events=data.events.slice().reverse();
  timeline.append(el('p','按股票积累已核对原文的公告和资讯。多空标签表示可能的方向，后续走势可在日 K 标记中核对。'));
  if(!events.length)timeline.append(el('p','暂未积累已核对原文的多空事件。'));
  for(const item of events){
    const event=card(item.date+' · '+item.side+' · '+item.title);
    event.dataset.side=item.side;
    event.append(el('p',item.kind+' · '+item.publisher),el('p',item.explanation),el('blockquote',item.quote),link('查看原文',item.quoteUrl));
    timeline.append(event);
  }
  const technical=data.technical;
  const chart=card('技术观察 · 最近收盘');
  if(technical)chart.append(el('p',technical.date+' 收盘 '+price(technical.close)+' 元 · 当日 '+pct(technical.daily)+' · 近 5 日 '+pct(technical.fiveDay)),
    el('p','距 MA20 '+pct(technical.aboveMA20)+' · 成交量／前 20 日均量 '+price(technical.volumeRatio)+' 倍'),link('日线数据出处',technical.url));
  else chart.append(el('p','日线数据暂不可用。'));
  const review=card('按交易日追查波动');
  review.append(document.getElementById('evidence'));
  root.replaceChildren(valueCard(data,stock),forecastCard(data.forecast),timeline,tradeHistory(data,stock),chart,review);
}

async function load(chart,refresh=false) {
  if(!refresh&&current?.stock.symbol===chart?.stock.symbol)return;
  current=chart;
  const id=++request;
  const evidence=document.getElementById('evidence');
  if(evidence&&root.contains(evidence))root.after(evidence);
  root.replaceChildren();
  if(!chart?.analysisEnabled)return;
  const {stock}=chart;
  root.append(el('h2',stock.name+' · 公司价值'),el('p','正在读取个股长期研究档案…'));
  try {
    const data=await get('research-context',{symbol:stock.symbol});
    if(id===request)render(data,stock);
  }catch(error){
    if(id===request)root.append(el('p',error.message));
  }
}

document.addEventListener('finance:stock',event=>void load(event.detail));
document.addEventListener('finance:report',event=>{
  if(event.detail.stock.symbol===current?.stock.symbol)void load(current,true);
});
