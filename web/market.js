const $ = id => document.getElementById(id);
const canvas = $('candles');
const ctx = canvas.getContext('2d');
const ui = { rows: [], visible: [], selected: '', width:0, gap:0, left:0, chart:null, request:0, evidenceRequest:0 };
const red = '#c03a4a', green = '#16806a', muted = '#55645f', line = '#dce3de';
const pct = value => value === null || value === undefined ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%';
const price = value => value.toFixed(2);

async function get(route, params) {
  const res = await fetch('/api/'+route+'?'+new URLSearchParams(params));
  if (!res.ok) throw new Error(res.status===404 ? '没有找到对应的证券或交易日。' : '数据源暂不可用，请稍后重试。');
  return res.json();
}

function candleSummary(row) {
  $('candle-info').textContent = row ? `${row.date}  开 ${price(row.open)}  高 ${price(row.high)}  低 ${price(row.low)}  收 ${price(row.close)}  涨跌 ${pct(row.returnPct)}` : '';
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
  const left=12, right=57, top=17, bottom=height-94, volumeBottom=height-24;
  const high = Math.max(...rows.map(row=>row.high));
  const low = Math.min(...rows.map(row=>row.low));
  const pad = Math.max((high-low)*.08, high*.001);
  const maxVolume = Math.max(1,...rows.map(row=>row.volume));
  const gap = (width-left-right)/rows.length;
  ui.left=left;
  ui.gap=gap;
  const y = value => top+(high+pad-value)/(high-low+2*pad)*(bottom-top);
  ctx.font='11px system-ui';
  ctx.textBaseline='middle';
  for (let i=0;i<=4;i++) {
    const value=high+pad-(high-low+2*pad)*i/4, yy=y(value);
    ctx.strokeStyle=line;
    ctx.beginPath(); ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();
    ctx.fillStyle=muted;
    ctx.fillText(price(value),width-right+5,yy);
  }
  for (const [index, row] of rows.entries()) {
    const x=left+(index+.5)*gap, bar=Math.max(1,Math.min(12,gap*.68));
    const color=row.close>=row.open?red:green;
    if(row.date===ui.selected) {
      ctx.fillStyle='#e3efeb';
      ctx.fillRect(x-gap/2,top,gap,volumeBottom-top);
    }
    ctx.strokeStyle=color; ctx.fillStyle=color;
    ctx.beginPath();ctx.moveTo(x,y(row.high));ctx.lineTo(x,y(row.low));ctx.stroke();
    ctx.fillRect(x-bar/2,Math.min(y(row.open),y(row.close)),bar,Math.max(1.2,Math.abs(y(row.open)-y(row.close))));
    const v=row.volume/maxVolume*48;
    ctx.globalAlpha=.55;ctx.fillRect(x-bar/2,volumeBottom-v,bar,v);ctx.globalAlpha=1;
    if (Math.abs(row.returnPct ?? 0)>=3) {
      ctx.beginPath();ctx.arc(x,Math.max(top+3,y(row.high)-6),2.1,0,2*Math.PI);ctx.fill();
    }
  }
  const ticks = width<440?3:5;
  ctx.fillStyle=muted;
  for(let i=0;i<ticks;i++){
    const index=Math.round((rows.length-1)*i/(ticks-1));
    const label=rows[index].date.slice(5);
    const x=Math.min(width-right-ctx.measureText(label).width, Math.max(left,left+(index+.5)*gap-13));
    ctx.fillText(label,x,height-11);
  }
}

function setRange() {
  const count=Number($('range').value);
  ui.visible=ui.rows.slice(-count);
  $('day').replaceChildren(...ui.visible.slice().reverse().filter(row=>row.previousClose!==null).map(row=>{
    const option=document.createElement('option');
    option.value=row.date;
    option.textContent=row.date+'  '+pct(row.returnPct);
    return option;
  }));
  if (ui.visible.some(row=>row.date===ui.selected)) $('day').value=ui.selected;
  else ui.selected=$('day').value;
  const row=ui.visible.find(item=>item.date===ui.selected);
  candleSummary(row);
  $('explain').disabled=!row;
  draw();
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

async function analyze(date) {
  const row=ui.visible.find(item=>item.date===date);
  if(!row || row.previousClose===null || !ui.chart) return;
  ui.selected=date;
  $('day').value=date;
  candleSummary(row);
  draw();
  const symbol=ui.chart.stock.symbol, name=ui.chart.stock.name;
  const request=++ui.evidenceRequest;
  $('evidence').textContent='正在查找该日的行情和公告…';
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

async function loadStock(symbol) {
  const request=++ui.request;
  ui.evidenceRequest++;
  $('chart-status').textContent='正在加载真实日线…';
  $('evidence').textContent='点击 K 线或选择交易日，查看当日证据。';
  try {
    const chart=await get('chart',{symbol});
    if(request!==ui.request) return;
    ui.chart=chart;
    ui.rows=chart.rows;
    ui.selected=chart.rows.at(-1).date;
    const last=chart.rows.at(-1);
    $('stock-name').textContent=chart.stock.name;
    $('stock-code').textContent=chart.stock.symbol.toUpperCase();
    $('price').textContent=price(last.close);
    $('change').textContent=pct(last.returnPct);
    $('change').className=last.returnPct>=0?'up':'down';
    $('chart-status').textContent=`行情至 ${last.date} · 腾讯日线 · 最新一根可能仍在盘中`;
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

canvas.addEventListener('click',event=>{
  const x=event.clientX-canvas.getBoundingClientRect().left;
  const row=ui.visible[Math.floor((x-ui.left)/ui.gap)];
  if(row) void analyze(row.date);
});
canvas.addEventListener('pointermove',event=>{
  const x=event.clientX-canvas.getBoundingClientRect().left;
  const row=ui.visible[Math.floor((x-ui.left)/ui.gap)];
  if(row) candleSummary(row);
});
canvas.addEventListener('pointerleave',()=>candleSummary(ui.visible.find(row=>row.date===ui.selected)));
$('range').addEventListener('change',setRange);
$('day').addEventListener('change',()=>{ui.selected=$('day').value;candleSummary(ui.visible.find(row=>row.date===ui.selected));draw();});
$('explain').addEventListener('click',()=>void analyze($('day').value));
new ResizeObserver(draw).observe(canvas);
void loadStock('sh600519');
