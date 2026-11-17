import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const symbols = new Set(['sh603893','sz002475','sz002009']);
const directory = path.resolve('data/intraday');
const formatter = new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Shanghai', weekday:'short', year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', hourCycle:'h23'
});
const cache = new Map();
let pending;
let started = false;

function clock(now = new Date()) {
  const values = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type,part.value]));
  return {date:values.year+'-'+values.month+'-'+values.day, weekday:values.weekday,
    minute:Number(values.hour)*60+Number(values.minute)};
}

export function pollingWindow(now) {
  const {weekday,minute} = clock(now);
  if (weekday==='Sat' || weekday==='Sun') return false;
  return (minute>=570 && minute<=691) || (minute>=780 && minute<=903);
}

export function parseIntraday(payload, symbol, fetchedAt) {
  const series=payload?.data?.[symbol];
  const record=series?.data;
  if (payload?.code!==0 || !/^\d{8}$/.test(record?.date) || !Array.isArray(record?.data)) {
    throw new Error('分时行情格式不完整');
  }
  const minutes=new Map();
  for(const item of record.data){
    if(typeof item!=='string') continue;
    const [time,rawPrice,rawVolume]=item.trim().split(/\s+/);
    const price=Number(rawPrice),totalVolume=Number(rawVolume);
    if (!/^(09[3-5]\d|10[0-5]\d|11[0-2]\d|1130|1[34][0-5]\d|1500)$/.test(time) ||
      !Number.isFinite(price)||price<=0||!Number.isFinite(totalVolume)||totalVolume<0) continue;
    minutes.set(time,{time,price,totalVolume});
  }
  let previousVolume=0;
  const points=[...minutes.values()].sort((a,b)=>a.time.localeCompare(b.time)).map(point=>{
    const volume=Math.max(0,point.totalVolume-previousVolume);
    previousVolume=point.totalVolume;
    return {time:point.time.slice(0,2)+':'+point.time.slice(2),price:point.price,volume};
  });
  if (!points.length) throw new Error('数据源未返回有效分钟点');
  const previousClose=Number(series.qt?.[symbol]?.[4]);
  return {symbol,date:record.date.replace(/^(\d{4})(\d\d)(\d\d)$/,'$1-$2-$3'),
    previousClose:Number.isFinite(previousClose)&&previousClose>0?previousClose:null,points,fetchedAt,
    source:'腾讯行情',sourceUrl:'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+symbol};
}

const fileFor = symbol => path.join(directory,symbol+'.json');

async function refresh(symbol) {
  try {
    const response=await fetch('https://web.ifzq.gtimg.cn/appstock/app/minute/query?code='+symbol,{
      signal:AbortSignal.timeout(8500)
    });
    if(!response.ok) throw new Error('行情源暂不可用');
    const snapshot=parseIntraday(await response.json(),symbol,new Date().toISOString());
    const previous=cache.get(symbol)?.snapshot;
    if (previous && (snapshot.date<previous.date || snapshot.date===previous.date &&
      snapshot.points.at(-1).time<previous.points.at(-1).time)) {
      throw new Error('行情源返回较早快照');
    }
    cache.set(symbol,{snapshot,unavailable:false});
    try {
      await mkdir(directory,{recursive:true});
      const tmp=fileFor(symbol)+'.'+process.pid+'.tmp';
      await writeFile(tmp,JSON.stringify(snapshot));
      await rename(tmp,fileFor(symbol));
    } catch(error) { console.warn('分时缓存写入失败',symbol,error.code??error.message); }
  } catch {
    cache.set(symbol,{snapshot:cache.get(symbol)?.snapshot,unavailable:true});
  }
}

function collect() {
  if(!pending) pending=Promise.all([...symbols].map(refresh)).finally(()=>{pending=undefined;});
  return pending;
}

export function startIntraday() {
  if(started) return;
  started=true;
  pending=Promise.all([...symbols].map(async symbol=>{
    try {
      const snapshot=JSON.parse(await readFile(fileFor(symbol),'utf8'));
      if(snapshot.symbol===symbol && Array.isArray(snapshot.points) && snapshot.points.length) {
        cache.set(symbol,{snapshot,unavailable:false});
      }
    } catch {}
  })).then(()=>Promise.all([...symbols].map(refresh))).finally(()=>{pending=undefined;});
  setInterval(()=>{if(pollingWindow()) void collect();},20_000).unref();
}

export function intradaySnapshot(symbol) {
  if(!symbols.has(symbol))return null;
  const {date}=clock();
  const state=cache.get(symbol);
  return {snapshot:state?.snapshot??null, unavailable:state?.unavailable??false,
    collecting:pollingWindow(), previousSession:!!state?.snapshot && state.snapshot.date!==date};
}
