import { setIndicatorHistory, drawIndicators, describeIndicators } from './indicators.js';
import { chartPeriodRows } from './chart-periods.js';
import { eventTrackHeight, layoutEventMarkers, loadEventMarkers, paintEventRange } from './events.js';

const $ = id => document.getElementById(id);
const canvas = $('candles');
const ctx = canvas.getContext('2d');
const emptyAnalysis = document.querySelector('.empty-analysis');
const ui = { rows: [], visible: [], selected: '', period:'day', range:0, windowEnd:0, reviewPinned:false, hover:-1, gap:0, left:0, averages:new Map(), chart:null, request:0, evidenceRequest:0 };
const red = '#c33551', green = '#098260', muted = '#54657b', line = '#e6ebf2';
const movingAverages = [[5,'#b78336'],[10,'#7861cf'],[20,'#2d8ac0']];
const pct = value => value === null || value === undefined ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%';
const price = value => value.toFixed(2);

async function get(route, params) {
  const res = await fetch('/api/'+route+'?'+new URLSearchParams(params));
  if (!res.ok) throw new Error(res.status===404 ? '没有找到对应的证券或交易日。' : '数据源暂不可用，请稍后重试。');
  return res.json();
}

const chartRequests = new Map();
function getChart(symbol, scope='full') {
  const key=symbol+':'+scope;
  if (chartRequests.has(key)) return chartRequests.get(key);
  const request=get('chart',{symbol,scope}).finally(()=>chartRequests.delete(key));
  chartRequests.set(key,request);
  return request;
}

function updateWatch(chart) {
  const button=document.querySelector('[data-stock="'+chart.stock.symbol+'"]');
  if(!button) return;
  const row=chart.rows.at(-1);
  button.querySelector('[data-last]').textContent=price(row.close);
  const move=button.querySelector('[data-move]');
  move.textContent=pct(row.returnPct);
  move.className=row.returnPct>0?'up':row.returnPct<0?'down':'';
}

function setAverages(rows) {
  ui.averages.clear();
  const totals=movingAverages.map(()=>0);
  rows.forEach((row,index)=>{
    const values=movingAverages.map(([period],i)=>{
      totals[i]+=row.close-(index>=period?rows[index-period].close:0);
      return index+1>=period?totals[i]/period:null;
    });
    ui.averages.set(row.date,values);
  });
}

function candleSummary(row) {
  describeIndicators(row);
  const date = row?.startDate ? row.startDate+' 至 '+row.date : row?.date;
  for(const [index,[period]] of movingAverages.entries()){
    const value=ui.averages.get(row?.date)?.[index];
    $('ma'+period).textContent=value==null?'—':price(value);
  }
  $('candle-info').textContent = row ? `${date}  开 ${price(row.open)}  高 ${price(row.high)}  低 ${price(row.low)}  收 ${price(row.close)}  涨跌 ${pct(row.returnPct)}` : '';
}

function draw() {
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width, height = bounds.height, ratio = devicePixelRatio || 1;
  if (!width || !height) return;
  canvas.width = Math.round(width*ratio);
  canvas.height = Math.round(height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const rows = ui.visible;
  if (!rows.length) return;
  const left=12, right=57, top=17+eventTrackHeight(rows), bottom=height-31;
  const averages=rows.flatMap(row=>ui.averages.get(row.date)??[]).filter(value=>value!==null);
  const high=Math.max(...rows.map(row=>row.high),...averages);
  const low=Math.min(...rows.map(row=>row.low),...averages);
  const pad = Math.max((high-low)*.08, high*.001);
  const axisHigh=high+pad, axisLow=Math.max(0,low-pad);
  const gap = (width-left-right)/rows.length;
  ui.left=left;
  ui.gap=gap;
  const y = value => top+(axisHigh-value)/(axisHigh-axisLow)*(bottom-top);
  paintEventRange(ctx,rows,left,gap,top,bottom);
  layoutEventMarkers(rows,left,gap);
  ctx.font='11px system-ui';
  ctx.textBaseline='middle';
  for (let i=0;i<=4;i++) {
    const value=axisHigh-(axisHigh-axisLow)*i/4, yy=y(value);
    ctx.strokeStyle=line;
    ctx.beginPath(); ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();
    ctx.fillStyle=muted;
    ctx.fillText(price(value),width-right+5,yy);
  }
  const sessionsPerColumn=Math.max(1,Math.ceil(1.7/gap));
  const selectedIndex=rows.findIndex(row=>row.date===ui.selected);
  if(selectedIndex>=0){
    const x=left+(selectedIndex+.5)*gap;
    ctx.fillStyle='#eaf1ff';
    ctx.fillRect(x-Math.max(1,gap)/2,top,Math.max(1,gap),bottom-top);
  }
  for(let index=0;index<rows.length;index+=sessionsPerColumn){
    const column=rows.slice(index,index+sessionsPerColumn);
    const open=column[0].open, close=column.at(-1).close;
    const upper=Math.max(...column.map(row=>row.high)), lower=Math.min(...column.map(row=>row.low));
    const columnWidth=column.length*gap;
    const x=left+index*gap+columnWidth/2, bar=Math.max(1,Math.min(12,columnWidth*.68));
    ctx.strokeStyle=ctx.fillStyle=close>=open?red:green;
    ctx.beginPath();ctx.moveTo(x,y(upper));ctx.lineTo(x,y(lower));ctx.stroke();
    ctx.fillRect(x-bar/2,Math.min(y(open),y(close)),bar,Math.max(1.2,Math.abs(y(open)-y(close))));
    if(sessionsPerColumn===1 && gap>=4 && Math.abs(column[0].returnPct??0)>=3){
      ctx.beginPath();ctx.arc(x,Math.max(top+3,y(upper)-6),2.1,0,2*Math.PI);ctx.fill();
    }
  }
  for (const [series,[,color]] of movingAverages.entries()) {
    ctx.strokeStyle=color;
    ctx.beginPath();
    let started=false;
    for (const [index,row] of rows.entries()) {
      const value=ui.averages.get(row.date)?.[series];
      if(value==null) continue;
      const x=left+(index+.5)*gap;
      if(started) ctx.lineTo(x,y(value));
      else ctx.moveTo(x,y(value));
      started=true;
    }
    ctx.stroke();
  }
  if(ui.hover>=0&&ui.hover<rows.length){
    const x=left+(ui.hover+.5)*gap;
    ctx.setLineDash([4,4]); ctx.strokeStyle='#8193aa';
    ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke();
    ctx.setLineDash([]);
  }
  const spansYears=rows[0].date.slice(0,4)!==rows.at(-1).date.slice(0,4);
  const ticks = Math.min(rows.length,width<440?3:5);
  $('movement-legend').hidden=sessionsPerColumn!==1||gap<4;
  ctx.fillStyle=muted;
  for(let i=0;i<ticks;i++){
    const index=ticks===1?0:Math.round((rows.length-1)*i/(ticks-1));
    const label=spansYears?rows[index].date.slice(0,7):rows[index].date.slice(5);
    const x=Math.min(width-right-ctx.measureText(label).width, Math.max(left,left+(index+.5)*gap-13));
    ctx.fillText(label,x,height-11);
  }
}

function updatePeriodHistory() {
  ui.rows=chartPeriodRows(ui.chart.rows,ui.period);
  setAverages(ui.rows);
  setIndicatorHistory(ui.rows);
}

function setRange(end=ui.rows.length) {
  if(!ui.rows.length)return;
  const count=ui.range||ui.rows.length;
  ui.windowEnd=Math.min(ui.rows.length,Math.max(count,end));
  ui.hover=-1;
  ui.visible=ui.rows.slice(Math.max(0,ui.windowEnd-count),ui.windowEnd);
  if(!ui.visible.some(row=>row.date===ui.selected))ui.selected=ui.visible.at(-1).date;
  const first=ui.visible[0], last=ui.visible.at(-1);
  $('history-window').hidden=!ui.range;
  $('history-range').textContent=(first.startDate??first.date)+' 至 '+last.date;
  $('history-older').disabled=ui.windowEnd<=count;
  $('history-newer').disabled=ui.windowEnd>=ui.rows.length;
  $('history-latest').disabled=ui.windowEnd>=ui.rows.length;
  for(const button of document.querySelectorAll('[data-range]')){
    button.setAttribute('aria-pressed',String(Number(button.dataset.range)===ui.range));
    if(button.dataset.range!=='0')button.textContent=button.dataset.range+(ui.period==='day'?' 日':' 根');
  }
  updateCandleSelection();
  drawIndicators(ui.visible);
}

function updateCandleSelection() {
  const row=ui.visible.find(item=>item.date===ui.selected);
  candleSummary(row);
  $('explain').disabled=!row||!ui.chart?.analysisEnabled;
  $('explain').textContent=ui.period==='day'?'分析波动':'分析期末日';
  if(row) $('explain').setAttribute('aria-label',$('explain').textContent+' '+row.date);
  draw();
  updateSelectedEvidence();
}

function selectCandle(row) {
  if(!row)return;
  if(ui.selected!==row.date)ui.evidenceRequest++;
  ui.selected=row.date;
  ui.reviewPinned=true;
  updateCandleSelection();
}

function setRangeAroundSelection() {
  const index=ui.rows.findIndex(row=>row.date===ui.selected);
  const end=index<0?ui.rows.length:index+1+Math.floor(ui.range/2);
  setRange(end);
}

function shiftWindow(amount) {
  if(!ui.rows.length)return;
  const end=ui.windowEnd;
  if(!ui.range){
    if(amount>=0)return;
    const preferred={day:120,week:60,month:30}[ui.period];
    ui.range=ui.rows.length>preferred?preferred:30;
    amount=-Math.round(ui.range/2);
  }
  setRange(end+amount);
}

function link(label,url) {
  const anchor=document.createElement('a');
  anchor.textContent=label;
  anchor.href=url;
  anchor.target='_blank';
  anchor.rel='noopener noreferrer';
  return anchor;
}

function showEvidence(evidence) {
  const {row,benchmark,disclosures}=evidence;
  const box=$('evidence');
  box.replaceChildren();
  const header=document.createElement('h3');
  header.textContent=`${evidence.stock.name} · ${row.date}`;
  const stats=document.createElement('p');
  stats.textContent=`股价 ${pct(row.returnPct)} · 沪深 300 ${pct(benchmark?.returnPct)} · 成交量 ${row.volumeMultiple===null?'暂无20日基准':row.volumeMultiple.toFixed(2)+' 倍（对比前20日均量）'}`;
  box.append(header,stats,link('个股日线原始数据',evidence.source.url));
  if(benchmark) box.append(' · ',link('沪深 300 原始数据',benchmark.url));
  const note=document.createElement('p');
  note.textContent=!disclosures ? '巨潮公告暂不可用。' : disclosures.items.length
    ? `巨潮公告 · ${disclosures.start} 至 ${disclosures.end}，展示 ${disclosures.items.length} 条。同日披露时间与行情先后未核实。`
    : '巨潮资讯在所查日期范围内未返回可链接的公告。';
  box.append(note);
  if (!disclosures?.items.length) return;
  const list=document.createElement('ul');
  for(const item of disclosures.items){
    const entry=document.createElement('li');
    entry.append(item.date+' ',link(item.title,item.url));
    list.append(entry);
  }
  box.append(list);
}

const reports = new Map();
const reportKey = (symbol,date) => symbol+':'+date;

function addSources(target, refs, available) {
  for (const id of refs) {
    const source=available.find(item=>item.id===id);
    if (source) target.append(' ',link('['+id+'] '+source.label,source.url));
  }
}

function renderReport(report) {
  const box=$('evidence');
  box.replaceChildren();
  const title=document.createElement('h3');
  title.textContent=report.stock.name+' · '+report.date;
  const selected=document.createElement('p');
  selected.className='selected-bar';
  selected.textContent='所选日 K · 开 '+price(report.row.open)+' · 高 '+price(report.row.high)+' · 低 '+price(report.row.low)+' · 收 '+price(report.row.close);
  box.append(title,selected);
  const results=document.createElement('div');
  results.className='table-scroll research-comparison';
  const table=document.createElement('table');
  const returns=[['时段','个股','行业','沪深 300'],
    ...[['当日','returnPct'],['近 5 日','fiveDayReturnPct'],['近 20 日','twentyDayReturnPct']].map(([label,key])=>
      [label,report.row[key],report.industry?.[key],report.benchmark?.[key]])];
  for(const [rowIndex,values] of returns.entries()){
    const tr=document.createElement('tr');
    values.forEach((value,index)=>{
      const cell=document.createElement(rowIndex===0 || index===0?'th':'td');
      if(rowIndex===0 || index===0) cell.scope=rowIndex===0?'col':'row';
      cell.textContent=rowIndex===0||index===0?value:pct(value);
      if(rowIndex>0&&index>0&&value!=null)cell.className=value>0?'up':value<0?'down':'';
      tr.append(cell);
    });
    table.append(tr);
  }
  results.append(table);
  box.append(results);
  const basis=document.createElement('p');
  basis.className='chart-basis';
  basis.textContent='20 日量比 '+(report.row.volumeMultiple?.toFixed(2)??'—')+' · ';
  addSources(basis,['P','I','M'],report.sources);
  box.append(basis);
  if(report.industry) {
    const note=document.createElement('p');
    note.textContent=report.industry.classification;
    note.append(' ',link('公司行业资料',report.industry.profileUrl));
    box.append(note);
  }
  const forces=document.createElement('div');
  forces.className='market-forces';
  const hasSides=report.movements.some(item=>item.side);
  for(const side of ['多方','空方']){
    const section=document.createElement('section');
    section.className='force-group';
    section.dataset.side=side;
    const heading=document.createElement('h3');
    heading.textContent=side+'证据';
    section.append(heading);
    const findings=report.movements.filter(item=>item.side===side);
    if(!findings.length){
      const empty=document.createElement('p');
      empty.textContent=hasSides?'本次证据不足。':'当前报告未分组，重新分析可查看。';
      section.append(empty);
    }
    for(const finding of findings){
      const row=document.createElement('p');
      const horizon=document.createElement('b');
      horizon.textContent=finding.horizon??'';
      row.append(horizon, finding.text);
      addSources(row,finding.refs,report.sources);
      section.append(row);
    }
    forces.append(section);
  }
  box.append(forces);
  if(!hasSides) {
    const findings=document.createElement('ul');
    for(const finding of report.movements){
      const row=document.createElement('li');
      row.textContent=finding.text;
      addSources(row,finding.refs,report.sources);
      findings.append(row);
    }
    box.append(findings);
  }
  for(const text of report.limitations) {
    const note=document.createElement('p'); note.textContent=text; box.append(note);
  }
  const heading=document.createElement('h3');
  heading.textContent='公告与资讯时间线';
  const range=document.createElement('p');
  range.textContent=`${report.window.start} 至 ${report.window.end} · 新到旧 · 巨潮公告最多 8 条，东方财富资讯最多 6 条。资讯只覆盖本次搜索返回范围。`;
  box.append(heading,range);
  if (report.window.disclosureTotal===null || report.window.newsScanned===null) {
    const availability = document.createElement('p');
    availability.textContent=[report.window.disclosureTotal===null?'公告源暂不可用':'',report.window.newsScanned===null?'资讯源暂不可用':''].filter(Boolean).join(' · ');
    box.append(availability);
  }
  if(!report.entries.length) {
    const empty=document.createElement('p'); empty.textContent='所查范围内没有取得可列出的公告或资讯。'; box.append(empty); return;
  }
  const filters=document.createElement('div');
  filters.className='timeline-filters';
  const kindFilter=document.createElement('select'), impactFilter=document.createElement('select');
  function fillFilter(select,label,values) {
    select.setAttribute('aria-label',label);
    for(const value of ['',...values]){
      const option=document.createElement('option'); option.value=value; option.textContent=value||label; select.append(option);
    }
  }
  fillFilter(kindFilter,'全部来源',['公告','资讯']);
  fillFilter(impactFilter,'全部影响',['利多','利空','中性','多空并存','证据不足']);
  filters.append(kindFilter,impactFilter);
  const list=document.createElement('div');
  list.className='timeline';
  function fillRows() {
    list.replaceChildren();
    for(const entry of report.entries){
      if(kindFilter.value && entry.kind!==kindFilter.value || impactFilter.value && entry.impact!==impactFilter.value) continue;
      const item=document.createElement('details');
      const summary=document.createElement('summary');
      const badge=document.createElement('span');
      badge.className='impact';
      badge.dataset.impact=entry.impact;
      badge.textContent=entry.impact;
      summary.append(badge,entry.title);
      const meta=document.createElement('p');
      meta.textContent=`${entry.published ?? entry.date} · ${entry.kind} · ${entry.publisher} · ${entry.category}${entry.afterClose ? ' · 收盘后' : ''}`;
      const explanation=document.createElement('p');
      explanation.textContent=entry.explanation;
      item.append(summary,meta,explanation);
      if(entry.quote){
        const quote=document.createElement('blockquote');
        quote.textContent=entry.quote;
        item.append(quote,link(entry.kind==='公告'?'查看原文第 '+entry.part+' 页':'查看资讯原文',entry.quoteUrl));
      } else item.append(link('查看原文',entry.url));
      if(entry.coverage?.partial){
        const coverage=document.createElement('p');
        coverage.textContent='分析基于已提取的部分正文。';
        item.append(coverage);
      }
      list.append(item);
    }
    if(!list.children.length) list.textContent='没有符合当前筛选条件的条目。';
  }
  kindFilter.addEventListener('change',fillRows);
  impactFilter.addEventListener('change',fillRows);
  box.append(filters,list);
  fillRows();
}

document.addEventListener('finance:report',event=>{
  const report=event.detail;
  reports.set(reportKey(report.stock.symbol,report.date),report);
  if(report.stock.symbol===ui.chart?.stock.symbol) updateSelectedEvidence();
});

function updateSelectedEvidence() {
  const symbol=ui.chart?.stock.symbol;
  const recent=[...reports.values()].filter(report=>report.stock.symbol===symbol &&
    ui.visible.some(row=>row.date===report.date)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,3);
  const saved=reports.get(reportKey(symbol,ui.selected)) ?? (!ui.reviewPinned ? recent[0] : null);
  if(saved) renderReport(saved);
  else if (ui.chart?.analysisEnabled) {
    const box=$('evidence');
    box.replaceChildren(emptyAnalysis.cloneNode(true));
    if (recent.length) {
      const group=document.createElement('section');
      group.className='recent-analysis';
      const heading=document.createElement('h3');
      heading.textContent='已保存的分析';
      group.append(heading);
      for (const report of recent) {
        const button=document.createElement('button');
        button.type='button';
        button.className='secondary';
        button.textContent=report.date+'  '+pct(report.row.returnPct);
        button.addEventListener('click',()=>selectCandle(ui.visible.find(row=>row.date===report.date)));
        group.append(button);
      }
      box.append(group);
    }
  } else $('evidence').textContent='当前分析范围为瑞芯微、立讯精密和天奇股份。';
}

async function analyze(date) {
  const row=ui.visible.find(item=>item.date===date);
  if(!row || !ui.chart?.analysisEnabled) return;
  candleSummary(row);
  draw();
  const symbol=ui.chart.stock.symbol, name=ui.chart.stock.name;
  const request=++ui.evidenceRequest;
  document.dispatchEvent(new Event('finance:show-evidence'));
  const evidenceBox=$('evidence');
  const reviewSection=evidenceBox.closest('details');
  if(reviewSection)reviewSection.open=true;
  evidenceBox.textContent='正在查找该日的行情和公告…';
  evidenceBox.scrollIntoView({block:'nearest'});
  try {
    const evidence=await get('evidence',{symbol,date});
    if(request!==ui.evidenceRequest) return;
    showEvidence(evidence);
    document.dispatchEvent(new CustomEvent('finance:analysis',{detail:{
      message:`分析 ${name}（${symbol}）${date} 的股价波动，说明可能原因和证据。`,analysis:{symbol,date}
    }}));
  } catch(error) {
    if(request===ui.evidenceRequest) $('evidence').textContent=error.message;
  }
}

async function loadStock(symbol, openMarket = true) {
  const request=++ui.request;
  ui.evidenceRequest++;
  $('chart-status').textContent='正在加载真实日线…';
  $('evidence').textContent='点击 K 线查看所选交易日的证据。';
  try {
    const chart=await getChart(symbol);
    if(request!==ui.request) return;
    ui.chart=chart;
    void loadEventMarkers(symbol,chart.analysisEnabled);
    document.dispatchEvent(new CustomEvent('finance:stock',{detail:chart}));
    if (openMarket) document.dispatchEvent(new Event('finance:show-market'));
    ui.range=0;
    ui.reviewPinned=false;
    updatePeriodHistory();
    updateWatch(chart);
    document.querySelectorAll('[data-stock]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.stock===symbol)));
    ui.selected=chart.rows.at(-1).date;
    const last=chart.rows.at(-1);
    $('stock-name').textContent=chart.stock.name;
    $('stock-code').textContent=chart.stock.symbol.toUpperCase();
    $('price').textContent=price(last.close);
    $('change').textContent=pct(last.returnPct);
    $('change').className=last.returnPct>0?'up':last.returnPct<0?'down':'';
    $('price').className=$('change').className;
    $('quote-open').textContent=price(last.open);
    $('quote-high').textContent=price(last.high);
    $('quote-low').textContent=price(last.low);
    $('quote-prev').textContent=last.previousClose==null?'—':price(last.previousClose);
    const coverage=chart.coverage;
    $('chart-status').textContent=coverage?.fromListing
      ? '上市 '+coverage.listingDate+' 至 '+last.date
      : '可用日线 '+chart.rows[0].date+' 至 '+last.date+(coverage?.listingDate?' · 上市 '+coverage.listingDate:' · 上市首日待核实');
    $('chart-status').title='最新日线可能仍在盘中';
    $('results-list').replaceChildren();
    setRange();
  } catch(error) {
    if(request===ui.request) $('chart-status').textContent=error.message;
  }
}

let searchRequest=0;
$('stock-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const q=$('stock-query').value.trim();
  if(!q) return;
  const request=++searchRequest;
  $('search-status').textContent='正在搜索沪深 A 股…';
  $('results-list').replaceChildren();
  try {
    const matches=await get('stocks',{q});
    if(request!==searchRequest) return;
    $('search-status').textContent=matches.length?'':'未找到匹配的沪深 A 股。';
    if(matches.length===1 || matches[0]?.code===q || matches[0]?.name===q || matches[0]?.symbol===q.toLowerCase()) {
      void loadStock(matches[0].symbol);
      return;
    }
    for(const stock of matches){
      const button=document.createElement('button');
      button.type='button';button.className='secondary';
      button.textContent=stock.name+' '+stock.code;
      button.addEventListener('click',()=>void loadStock(stock.symbol));
      $('results-list').append(button);
    }
  } catch(error){if(request===searchRequest) $('search-status').textContent=error.message;}
});

let gesture, clickBlockedUntil=0;
function barIndex(event) {
  return Math.floor((event.clientX-canvas.getBoundingClientRect().left-ui.left)/ui.gap);
}
canvas.addEventListener('pointerdown',event=>{
  if(!event.isPrimary||event.button!==0)return;
  gesture={id:event.pointerId,x:event.clientX,y:event.clientY};
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointercancel',()=>{gesture=null;});
canvas.addEventListener('pointerup',event=>{
  if(gesture?.id!==event.pointerId)return;
  const dx=event.clientX-gesture.x, dy=event.clientY-gesture.y;
  gesture=null;
  if(Math.abs(dx)<18||Math.abs(dx)<=Math.abs(dy)*1.25)return;
  clickBlockedUntil=performance.now()+350;
  const amount=Math.max(1,Math.round(Math.abs(dx)/Math.max(1,canvas.clientWidth)*ui.visible.length));
  shiftWindow(Math.sign(dx)*amount);
});
canvas.addEventListener('click',event=>{
  if(performance.now()<clickBlockedUntil)return;
  selectCandle(ui.visible[barIndex(event)]);
});
canvas.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!ui.visible.length)return;
  event.preventDefault();
  const index=ui.visible.findIndex(row=>row.date===ui.selected);
  const target={ArrowLeft:index-1,ArrowRight:index+1,Home:0,End:ui.visible.length-1}[event.key];
  selectCandle(ui.visible[Math.min(ui.visible.length-1,Math.max(0,target))]);
});
canvas.addEventListener('pointermove',event=>{
  if(gesture||event.pointerType==='touch')return;
  const index=barIndex(event);
  const row=ui.visible[index];
  if(row&&ui.hover!==index){ui.hover=index;candleSummary(row);draw();}
});
canvas.addEventListener('pointerleave',()=>{
  ui.hover=-1;
  candleSummary(ui.visible.find(row=>row.date===ui.selected));
  draw();
});
for(const button of document.querySelectorAll('[data-period]')){
  button.addEventListener('click',()=>{
    if(ui.period===button.dataset.period)return;
    const oldDate=ui.selected;
    ui.period=button.dataset.period;
    if(!ui.chart)return;
    updatePeriodHistory();
    ui.selected=ui.rows.find(row=>row.date>=oldDate)?.date??ui.rows.at(-1).date;
    setRangeAroundSelection();
  });
}
for(const button of document.querySelectorAll('[data-range]')){
  button.addEventListener('click',()=>{
    ui.range=Number(button.dataset.range);
    setRangeAroundSelection();
  });
}
$('history-older').addEventListener('click',()=>shiftWindow(-ui.range));
$('history-newer').addEventListener('click',()=>shiftWindow(ui.range));
$('history-latest').addEventListener('click',()=>{ui.selected=ui.rows.at(-1).date;setRange();});
$('explain').addEventListener('click',()=>void analyze(ui.selected));
new ResizeObserver(()=>{draw();drawIndicators(ui.visible);}).observe(canvas);
document.addEventListener('finance:update-annotations',draw);
document.addEventListener('finance:report',event=>{
  if(event.detail.stock.symbol===ui.chart?.stock.symbol) void loadEventMarkers(ui.chart.stock.symbol,ui.chart.analysisEnabled);
});
document.querySelectorAll('[data-stock]').forEach(button=>button.addEventListener('click',()=>{
  document.dispatchEvent(new Event('finance:show-market'));
  void loadStock(button.dataset.stock);
}));
void loadStock('sh603893', false);
document.querySelectorAll('[data-stock]').forEach(button=>{
  if(button.dataset.stock!=='sh603893') void getChart(button.dataset.stock,'recent').then(updateWatch).catch(()=>{});
});
