import { displayTrades } from './research-context.js';
import { chartEventIndex, eventWindowSpan } from './chart-periods.js';

const $ = id => document.getElementById(id);
const layer = $('event-markers');
const detail = $('event-detail');
let symbol, active=false, events=[], selection=null, performance=null, marksKey='', listRequest=0, detailRequest=0;
const chartChanged = () => document.dispatchEvent(new Event('finance:update-annotations'));

async function get(resource,params) {
  const response=await fetch('/api/'+resource+'?'+new URLSearchParams(params));
  if(!response.ok) throw new Error('数据暂不可用');
  return response.json();
}
function node(tag,text,className) {
  const element=document.createElement(tag);
  if(text!==null) element.textContent=text;
  if(className)element.className=className;
  return element;
}
function sourceLink(text,url) {
  const anchor=node('a',text);
  anchor.href=url; anchor.target='_blank'; anchor.rel='noopener noreferrer';
  return anchor;
}

export async function loadEventMarkers(nextSymbol,enabled) {
  const request=++listRequest;
  active=enabled;
  if(symbol!==nextSymbol){
    symbol=nextSymbol;
    events=[];
    selection=null;
    performance=null;
    detailRequest++;
    detail.hidden=true;
    chartChanged();
  }
  if(!enabled){
    $('event-legend').textContent='';
    return;
  }
  $('event-legend').textContent='正在载入多空事件…';
  try {
    const items=await get('events',{symbol:nextSymbol});
    if(request!==listRequest)return;
    events=items;
    chartChanged();
  } catch {
    if(request===listRequest) $('event-legend').textContent='事件标记暂不可用';
  }
}

function visibleMarks(rows) {
  if(!active)return [];
  const result=[];
  for(const event of events){
    const index=chartEventIndex(rows,event.date);
    if(index>=0)result.push({event,index});
  }
  return result;
}

export function paintEventRange(ctx,rows,left,gap,top,bottom) {
  if(!performance?.start || !performance?.end || !selection)return;
  const span=eventWindowSpan(rows,performance.start,performance.end);
  if(!span)return;
  const {first,count}=span;
  ctx.fillStyle=selection.side==='多方'?'#c3355116':selection.side==='空方'?'#09826018':'#2976ad1e';
  ctx.fillRect(left+first*gap,top,count*gap,bottom-top);
}

export function eventTrackHeight(rows) {
  const marks=visibleMarks(rows);
  return marks.some(item=>item.event.side==='交易') ? 78 : marks.length ? 52 : 0;
}

export function layoutEventMarkers(rows,left,gap) {
  const marks=visibleMarks(rows);
  if(!active){marksKey='';layer.replaceChildren();$('event-legend').textContent='';return;}
  const key=JSON.stringify([symbol,selection?.url,left,gap,...marks.map(({event,index})=>[event.url,event.side,index])]);
  if(key===marksKey)return;
  marksKey=key;
  layer.replaceChildren();
  const mapping=rows[0]?.periodStart?'按自然周期标注':'非交易日靠后标注';
  $('event-legend').textContent=marks.length
    ? '红「多」绿「空」蓝「榜」 · 点标记查看依据和后续表现 · '+mapping
    : events.length ? '当前显示范围内无多空事件' : '暂无已核对原文的多空标记 · 点 K 线发起分析';
  for(const side of ['多方','空方','交易']){
    const groups=[];
    for(const mark of marks.filter(item=>item.event.side===side)){
      const x=left+(mark.index+.5)*gap;
      const group=groups.at(-1);
      if(group&&x-group.x<30)group.events.push(mark.event);
      else groups.push({x,events:[mark.event]});
    }
    for(const {x,events:items} of groups){
      const marker=node('button',(side==='多方'?'多':side==='空方'?'空':'榜')+(items.length>1?items.length:''),'event-marker');
      marker.type='button';
      marker.dataset.side=side;
      marker.style.left=x+'px';
      marker.setAttribute('aria-pressed',String(items.some(item=>item.url===selection?.url)));
      marker.setAttribute('aria-label',side+'事件 '+items.map(item=>item.date+' '+item.title).join('；'));
      marker.title=items.map(item=>item.date+' '+item.title).join('\n');
      marker.addEventListener('click',()=>{
        const chosen=items.find(item=>item.url===selection?.url)??items[0];
        void openEvent(chosen,items);
      });
      layer.append(marker);
    }
  }
}

function metric(value) {
  if(!value)return node('span','—');
  const pct=value.returnPct;
  return node('span',pct===0?'0.00%':(pct>0?'+':'')+pct.toFixed(2)+'%',pct>0?'up':pct<0?'down':'');
}
function renderPerformance(target,data) {
  target.replaceChildren();
  const title=node('h3','事件后的行情观察');
  const note=node('p',data.baseline
    ? '基准为 '+data.baseline+' 收盘。披露日不计入，从其后首个已收盘交易日起算。个股按未复权价格计算。'
    : '缺少披露日附近的交易日历或基准收盘，无法计算后续表现。');
  target.append(title,note);
  if (data.start) target.append(node('p','观察区间为 '+data.start+' 至 '+data.end+'（已完成 '+data.completed+'／20 个交易日）。图中标色为与这段日期相交的 K 线。'));
  else target.append(node('p','暂无可绘制的后续观察区间。'));
  const wrap=node('div',null,'table-scroll');
  const table=document.createElement('table');
  const head=table.createTHead().insertRow();
  for(const text of ['窗口','截至日期','个股','板块'+(data.sector?' · '+data.sector:'')]){
    const cell=node('th',text);
    cell.scope='col';head.append(cell);
  }
  for(const observation of data.results){
    const row=table.createTBody().insertRow();
    row.insertCell().textContent=observation.days+' 日';
    row.insertCell().textContent=observation.date??'尚无完整窗口';
    for(const value of [observation.stock,observation.industry]){
      const cell=row.insertCell();
      cell.append(metric(value));
      if(value)cell.append(node('small',value.baselineClose.toFixed(2)+' → '+value.close.toFixed(2),'event-close-values'));
    }
  }
  wrap.append(table);
  target.append(wrap);
  if(!data.availability.industry)target.append(node('p','板块数据暂不可用。'));
  else if(data.results.some(item=>item.date&&!item.industry))target.append(node('p','部分窗口缺少板块收盘数据。'));
  if(!data.availability.stock||data.results.some(item=>item.date&&!item.stock))target.append(node('p','部分窗口缺少个股收盘数据，可能停牌或数据缺失。'));
  const sources=node('p',null,'event-sources');
  for(const [key,label] of [['stock','个股日线'],['industry','行业日线'],['calendar','交易日对照']]){
    if(data.sources[key])sources.append(sourceLink(label,data.sources[key]),' ');
  }
  target.append(sources);
}

async function openEvent(event, alternatives) {
  const request=++detailRequest;
  const selectedSymbol=symbol;
  selection=event;
  performance=null;
  chartChanged();
  detail.replaceChildren();
  detail.hidden=false;
  const header=node('div',null,'event-detail-head');
  const heading=node('h2',event.side+' · '+event.title);
  const close=node('button','关闭','secondary');
  close.type='button';
  close.addEventListener('click',()=>{
    detailRequest++;
    selection=null;
    performance=null;
    detail.hidden=true;
    chartChanged();
  });
  header.append(heading,close);
  detail.append(header);
  if(alternatives.length>1){
    const picker=node('select');
    picker.setAttribute('aria-label','选择此标记中的事件');
    for(const item of alternatives) {
      const option=node('option',item.date+' '+item.title);
      option.value=item.url;option.selected=item.url===event.url;
      picker.append(option);
    }
    picker.addEventListener('change',()=>void openEvent(alternatives.find(item=>item.url===picker.value),alternatives));
    detail.append(picker);
  }
  if(event.side==='交易'){
    detail.append(node('p',event.date+' · 交易公开信息'),sourceLink('查看龙虎榜记录',event.url),
      node('p','上榜信息只覆盖公开席位，其余机构交易情况未知。','event-caveat'));
    const trades=node('div','正在读取席位明细…');
    detail.append(trades);
    void get('disclosed-trades',{symbol:selectedSymbol,date:event.date}).then(
      data=>{if(request===detailRequest)displayTrades(trades,data);},
      ()=>{if(request===detailRequest)trades.textContent='席位明细暂不可用。';}
    );
  }else {
    detail.append(node('p',(event.published??event.date)+' · '+event.kind+' · '+event.publisher),
      node('p',event.explanation),node('blockquote',event.quote),
      sourceLink(event.kind==='公告'?'查看公告原文 · 第 '+event.part+' 页':'查看资讯原文',event.quoteUrl));
    if(event.hypothesis)detail.append(node('p','近 20 日研究假设：'+event.hypothesis));
  }
  detail.append(node('p','证据不足以确认事件持续影响了多久，或单独解释后续涨跌。','event-caveat'));
  const target=node('div','正在读取个股与板块日线…');
  target.setAttribute('aria-live','polite');
  detail.append(target);
  detail.scrollIntoView({block:'nearest'});
  try {
    const data=await get('event-performance',{symbol:selectedSymbol,date:event.date});
    if (request!==detailRequest)return;
    performance=data;
    renderPerformance(target,data);
    chartChanged();
  } catch {
    if(request===detailRequest)target.textContent='暂未取得后续行情数据，原文仍可查看。';
  }
}
