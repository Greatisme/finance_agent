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
  const forecast=card('走势预测与投资意见',true);
  forecast.append(el('p','当前仅积累研究证据。尚未对这类证据完成跨股票、按时间隔离的样本外验证，暂不输出上涨概率或买卖意见。'));
  const review=card('按交易日追查波动');
  review.append(document.getElementById('evidence'));
  root.replaceChildren(valueCard(data,stock),timeline,tradeHistory(data,stock),chart,forecast,review);
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
