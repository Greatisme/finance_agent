const $ = id => document.getElementById(id);
const canvas = $('minute-chart'), ctx = canvas.getContext('2d');
let stock, state, mode = 'daily', requestId = 0;
const button = document.querySelector('[data-chart-mode="intraday"]');
const number = value => value.toFixed(2);
function slot(time) {
  const [hour,min]=time.split(':').map(Number);
  const minute=hour*60+min;
  return minute<=690?minute-570:121+minute-780;
}
function draw() {
  if(mode!=='intraday') return;
  const {width,height}=canvas.getBoundingClientRect();
  if(!width||!height) return;
  const ratio=devicePixelRatio||1;
  canvas.width=Math.round(width*ratio); canvas.height=Math.round(height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const {points,previousClose}=state?.snapshot??{};
  if(!points?.length) return;
  const left=12,right=55,top=19,bottom=height-90,volumeBottom=height-25;
  const plotWidth=width-left-right;
  const base=previousClose??points[0].price;
  const spread=Math.max(base*.001,...points.map(point=>Math.abs(point.price-base)))*1.12;
  const x=time=>left+slot(time)/241*plotWidth;
  const y=value=>top+(base+spread-value)/(spread*2)*(bottom-top);
  const maxVolume=Math.max(1,...points.map(point=>point.volume));
  ctx.font='11px system-ui';ctx.textBaseline='middle';
  for(let i=0;i<=4;i++){
    const value=base+spread-spread*i/2, yy=y(value);
    ctx.strokeStyle='#e1e7ee';
    if(i===2)ctx.setLineDash([4,3]);
    ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle='#54657b';ctx.fillText(number(value),width-right+5,yy);
  }
  for(const [text,offset] of [['09:30',0],['11:30 / 13:00',.5],['15:00',1]]){
    const xx=left+offset*plotWidth, tw=ctx.measureText(text).width;
    ctx.fillText(text,Math.min(width-right-tw,Math.max(left,xx-tw/2)),height-10);
  }
  ctx.fillText('成交量',left,bottom+19);
  ctx.strokeStyle='#216acf';ctx.beginPath();
  for(const [index,point] of points.entries()){
    const xx=x(point.time), yy=y(point.price);
    if(index)ctx.lineTo(xx,yy);
    else ctx.moveTo(xx,yy);
  }
  ctx.stroke();
  const end=points.at(-1);
  ctx.fillStyle='#216acf';ctx.beginPath();ctx.arc(x(end.time),y(end.price),2.5,0,2*Math.PI);ctx.fill();
  for(const [index,point] of points.entries()){
    const bar=point.volume/maxVolume*42;
    ctx.fillStyle=point.price>=(points[index-1]?.price??base)?'#e59cac':'#8bc4b3';
    ctx.fillRect(x(point.time),volumeBottom-bar,Math.max(1,plotWidth/242*.7),bar);
  }
}

function describe(point) {
  const snapshot=state?.snapshot;
  if(!snapshot||!point) return;
  const p=snapshot.previousClose ? (point.price/snapshot.previousClose-1)*100 : null;
  const change=p===null?'—':(p>0?'+':'')+number(p)+'%';
  $('minute-info').textContent=snapshot.date+' '+point.time+'  价格 '+number(point.price)+'  涨跌 '+change+'  成交 '+point.volume.toLocaleString('zh-CN')+' 手';
}
async function refresh() {
  if(mode!=='intraday'||!stock) return;
  const id=++requestId;
  try {
    const response=await fetch('/api/intraday?'+new URLSearchParams({symbol:stock.symbol}));
    if(!response.ok) throw new Error('分时数据暂不可用');
    const result=await response.json();
    if(id!==requestId||mode!=='intraday') return;
    state=result;
    const {snapshot,unavailable,previousSession,collecting}=result;
    $('minute-status').textContent=snapshot
      ? '腾讯分时 · '+snapshot.date+(unavailable?' · 显示缓存':previousSession?' · 最近交易日':collecting?' · 自动更新':'')
      : unavailable?'暂未取得分时数据':'正在等待后台采集';
    describe(snapshot?.points.at(-1));
    draw();
  } catch(error) {
    if(id===requestId && mode==='intraday') $('minute-status').textContent=error.message;
  }
}
function setMode(next) {
  mode=next;
  requestId++;
  const intraday=mode==='intraday';
  $('daily-chart-pane').hidden=intraday;
  $('minute-chart-pane').hidden=!intraday;
  $('periods').hidden=intraday;
  $('quote-adjustment').textContent=intraday?'分钟线':'未复权';
  document.querySelectorAll('[data-chart-mode]').forEach(item=>
    item.setAttribute('aria-pressed',String(item.dataset.chartMode===mode)));
  if(intraday){draw();void refresh();}
}
canvas.addEventListener('pointermove',event=>{
  const rect=canvas.getBoundingClientRect(),points=state?.snapshot?.points;
  if(!points?.length)return;
  const time=(event.clientX-rect.left-12)/(rect.width-67)*241;
  if(time<0||time>slot(points.at(-1).time)+1)return;
  describe(points.reduce((a,b)=>Math.abs(slot(b.time)-time)<Math.abs(slot(a.time)-time)?b:a));
});
canvas.addEventListener('pointerleave',()=>describe(state?.snapshot?.points.at(-1)));
document.querySelectorAll('[data-chart-mode]').forEach(item=>item.addEventListener('click',()=>setMode(item.dataset.chartMode)));
document.addEventListener('finance:stock',event=>{
  stock=event.detail.stock;
  requestId++;
  state=null;
  button.disabled=!event.detail.analysisEnabled;
  $('minute-info').textContent='';
  $('minute-status').textContent='正在读取分时缓存…';
  if(button.disabled) setMode('daily');
  else if(mode==='intraday'){draw();void refresh();}
});
new ResizeObserver(draw).observe(canvas);
setInterval(()=>{if(!document.hidden&&canvas.getClientRects().length)void refresh();},20000);
