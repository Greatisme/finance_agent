const $=id=>document.getElementById(id);

function ema(values,period) {
  let value=null, sum=0, samples=0;
  return values.map(price=>{
    if(price==null) return null;
    if(value!==null) return value+=(price-value)*2/(period+1);
    sum+=price;
    samples++;
    if(samples===period)value=sum/period;
    return value;
  });
}

export function calculateIndicators(prices) {
  const fast=ema(prices,12), slow=ema(prices,26);
  const dif=prices.map((_,i)=>slow[i]==null?null:fast[i]-slow[i]);
  const signal=ema(dif,9);
  let gain=0, loss=0;
  return prices.map((price,i)=>{
    let rsi=null;
    if(i>0){
      const change=price-prices[i-1], up=Math.max(change,0), down=Math.max(-change,0);
      if(i<=14){gain+=up/14;loss+=down/14;}
      else {gain=(gain*13+up)/14;loss=(loss*13+down)/14;}
      if(i>=14)rsi=gain===0&&loss===0?50:loss===0?100:100-100/(1+gain/loss);
    }
    return {dif:dif[i],signal:signal[i],macd:signal[i]==null?null:2*(dif[i]-signal[i]),rsi};
  });
}

const defaults={volume:true,macd:false,rsi:false};
let preferences={...defaults};
let rows=[];
let indicators=[], position=new Map();
let described=null;
const volumeFormat=new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:2});
function ready() {
  try {
    const stored=JSON.parse(localStorage.getItem('finance-indicators')??'{}');
    for(const name of Object.keys(defaults)) if(typeof stored?.[name]==='boolean')preferences[name]=stored[name];
  } catch {}
  for(const input of document.querySelectorAll('[data-indicator]')){
    input.checked=preferences[input.dataset.indicator];
    input.addEventListener('change',()=>{
      preferences[input.dataset.indicator]=input.checked;
      try{localStorage.setItem('finance-indicators',JSON.stringify(preferences));}catch{}
      drawIndicators(rows);
    });
  }
}

export function setIndicatorHistory(history) {
  position=new Map(history.map((row,index)=>[row.date,index]));
  indicators=calculateIndicators(history.map(row=>row.close));
}

function plot(kind,shown) {
  const pane=$('indicator-'+kind);
  pane.hidden=!preferences[kind];
  if(pane.hidden)return;
  const canvas=pane.querySelector('canvas'), bounds=canvas.getBoundingClientRect();
  if(!bounds.width||!bounds.height)return;
  const start=position.get(shown[0]?.date);
  const points=start==null?[]:indicators.slice(start,start+shown.length);
  const ctx=canvas.getContext('2d'), ratio=devicePixelRatio||1;
  canvas.width=Math.round(bounds.width*ratio);
  canvas.height=Math.round(bounds.height*ratio);
  ctx.setTransform(ratio,0,0,ratio,0,0);
  const left=12,right=bounds.width-57,top=10,bottom=bounds.height-10;
  const step=(right-left)/Math.max(1,shown.length);
  if(kind==='volume'){
    const maxVolume=Math.max(1,...shown.map(row=>row.volume));
    ctx.strokeStyle='#dce5ef';
    ctx.beginPath();ctx.moveTo(left,bottom);ctx.lineTo(right,bottom);ctx.stroke();
    ctx.fillStyle='#54657b';ctx.font='10px system-ui';
    ctx.fillText(volumeFormat.format(maxVolume),right+5,top+3);
    const columns=Math.max(1,Math.ceil(1.7/step));
    for(let index=0;index<shown.length;index+=columns){
      const rows=shown.slice(index,index+columns);
      const row=rows.reduce((largest,point)=>point.volume>largest.volume?point:largest);
      const height=row.volume/maxVolume*(bottom-top);
      const width=rows.length*step;
      const bar=Math.max(1,Math.min(12,width*.68));
      ctx.fillStyle=row.close>=row.open?'#d58596':'#78b29f';
      ctx.fillRect(left+index*step+(width-bar)/2,bottom-height,bar,height);
    }
    return;
  }
  const scale=Math.max(.01,...points.flatMap(point=>[point.dif,point.signal,point.macd].map(value=>Math.abs(value??0))));
  const y=value=>kind==='rsi'? bottom-value*(bottom-top)/100 : top+(scale-value)/(scale*2)*(bottom-top);
  ctx.strokeStyle='#dce5ef';ctx.fillStyle='#54657b';ctx.font='10px system-ui';
  for(const value of kind==='rsi'?[30,50,70]:[0]){
    const yy=y(value);
    ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    ctx.fillText(String(value),right+5,yy+3);
  }
  if(kind==='macd') points.forEach((point,index)=>{
    if(point.macd==null)return;
    const a=y(point.macd), b=y(0);
    ctx.fillStyle=point.macd>=0?'#c33551':'#098260';
    ctx.fillRect(left+(index+.19)*step,Math.min(a,b),Math.min(12,step*.62),Math.abs(a-b));
  });
  for(const [key,color] of kind==='rsi'?[['rsi','#6d54bb']]:[['dif','#b78336'],['signal','#2d8ac0']]){
    let started=false;ctx.strokeStyle=color;ctx.beginPath();
    points.forEach((point,i)=>{
      if(point[key]==null)return;
      const x=left+(i+.5)*step;
      if(started)ctx.lineTo(x,y(point[key]));
      else ctx.moveTo(x,y(point[key]));
      started=true;
    });
    ctx.stroke();
  }
}

export function describeIndicators(row) {
  described=row;
  const sample=indicators[position.get(row?.date)];
  const fixed=value=>value==null?'—':value.toFixed(2);
  $('indicator-volume').querySelector('span').textContent=row
    ? row.volume.toLocaleString('zh-CN')+' 手'+(row.volumeMultiple==null?'':' · 量比 '+fixed(row.volumeMultiple))
    : '—';
  $('indicator-macd').querySelector('span').textContent=
    'DIF '+fixed(sample?.dif)+' · DEA '+fixed(sample?.signal)+' · 柱 '+fixed(sample?.macd);
  $('indicator-rsi').querySelector('span').textContent='RSI '+fixed(sample?.rsi);
}

export function drawIndicators(visible) {
  rows=visible;
  for(const key of ['volume','macd','rsi'])plot(key,visible);
  describeIndicators(described??visible.at(-1));
}

if(typeof document!=='undefined')ready();
