import { financialFiling } from './market.js';

const financial = new Map();
const trading = new Map();

async function json(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(8500)});
  if(!response.ok) throw new Error('数据源暂不可用');
  return response.json();
}

function cached(map,key,fetcher) {
  const previous=map.get(key);
  if(previous?.until>Date.now())return previous.value;
  if(map.size>=65)map.delete(map.keys().next().value);
  const value=fetcher().catch(error=>{if(map.get(key)?.value===value)map.delete(key);throw error;});
  map.set(key,{value,until:Date.now()+10*60_000});
  return value;
}

function finite(value) {
  return typeof value==='number' && Number.isFinite(value)?value:null;
}

export function latestKnownReport(rows, code, date) {
  return rows.filter(row=>row.SECURITY_CODE===code && /^\d{4}-\d{2}-\d{2}/.test(row.NOTICE_DATE??'') &&
    row.NOTICE_DATE.slice(0,10)<date).sort((a,b)=>b.REPORT_DATE.localeCompare(a.REPORT_DATE))[0]??null;
}

async function financialSeries(symbol,date) {
  const code=symbol.slice(2);
  const url='https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code='+symbol.toUpperCase();
  const rows=await cached(financial,symbol,async()=>{
    const result=await json(url);
    if(!Array.isArray(result.data))throw new Error('未取得财务指标');
    return result.data;
  });
  const item=latestKnownReport(rows,code,date);
  if(!item)return null;
  const map = item=>({period:item.REPORT_DATE.slice(0,10),disclosed:item.NOTICE_DATE.slice(0,10),kind:item.REPORT_TYPE,
    revenue:finite(item.TOTALOPERATEREVE),revenueYoY:finite(item.TOTALOPERATEREVETZ),
    netProfit:finite(item.PARENTNETPROFIT),profitYoY:finite(item.PARENTNETPROFITTZ),
    roe:finite(item.ROEJQ),debtRatio:finite(item.ZCFZL),operatingCashPerShare:finite(item.MGJYXJJE),
    eps:finite(item.EPSJB),bookPerShare:finite(item.BPS),url});
  const periods=new Map();
  for(const row of rows){
    if(row.SECURITY_CODE!==code||!row.NOTICE_DATE||row.NOTICE_DATE.slice(0,10)>=date||
       row.REPORT_DATE?.slice(5,10)!==item.REPORT_DATE.slice(5,10))continue;
    const period=row.REPORT_DATE.slice(0,10);
    if(!periods.has(period)||periods.get(period).NOTICE_DATE<row.NOTICE_DATE)periods.set(period,row);
  }
  return {latest:map(item),comparable:[...periods.entries()].sort(([a],[b])=>b.localeCompare(a)).slice(0,4).map(([,row])=>map(row))};
}

function tradesUrl(name,filter) {
  return 'https://datacenter-web.eastmoney.com/api/data/v1/get?'+new URLSearchParams({
    reportName:name,columns:'ALL',filter,pageSize:'35',pageNumber:'1',sortColumns:'TRADE_DATE',sortTypes:'-1'
  });
}

export async function publicTrades(code,date) {
  return cached(trading,code+':'+date,async()=>{
    const filter='(SECURITY_CODE="'+code+'")(TRADE_DATE=\''+date+'\')';
    const url=tradesUrl('RPT_BILLBOARD_DAILYDETAILS',filter);
    const listing=await json(url);
    if(!listing.success){
      // The source returns this explicit no-record message when the filter has no hits.
      if (/没有相关数据|未查询到|无数据|返回数据为空/.test(listing.message??''))return {rows:[],seats:[],url,seatSources:[]};
      throw new Error('交易公开信息暂不可用');
    }
    const exact=(listing.result?.data??[]).filter(row=>row.SECURITY_CODE===code && row.TRADE_DATE?.slice(0,10)===date);
    if(!exact.length)return {rows:[],seats:[],url,seatSources:[]};
    const seatSources=['RPT_BILLBOARD_DAILYDETAILSBUY','RPT_BILLBOARD_DAILYDETAILSSELL'].map(name=>tradesUrl(name,filter));
    const responses=await Promise.allSettled(seatSources.map(async source=>{
      const result=await json(source);
      if(!result.success)throw new Error('席位明细暂不可用');
      return result.result?.data??[];
    }));
    const seats=new Map();
    for (const [index,response] of responses.entries()) {
      if(response.status!=='fulfilled') continue;
      for(const row of response.value) {
        if(row.SECURITY_CODE!==code||row.TRADE_DATE?.slice(0,10)!==date||row.OPERATEDEPT_NAME!=='机构专用')continue;
        const key=[row.TRADE_ID,row.OPERATEDEPT_CODE,row.BUY,row.SELL].join('|');
        seats.set(key,{reason:row.EXPLANATION,buy:finite(row.BUY),sell:finite(row.SELL),net:finite(row.NET),url:seatSources[index]});
      }
    }
    return {rows:exact.map(row=>({reason:row.EXPLANATION,buy:finite(row.TOTAL_BUY),sell:finite(row.TOTAL_SELL),net:finite(row.TOTAL_NET)})),
      seats:[...seats.values()],url,seatSources,
      incompleteSeats:responses.some(response=>response.status!=='fulfilled')};
  });
}

async function lastDisclosedTrade(code,date) {
  const dateParam = "'" + date + "'";
  const url = tradesUrl('RPT_BILLBOARD_DAILYDETAILS', '(SECURITY_CODE="' + code + '")(TRADE_DATE<' + dateParam + ')');
  const listing=await json(url);
  const last=listing.result?.data?.find(row=>row.SECURITY_CODE===code && row.TRADE_DATE?.slice(0,10)<date)?.TRADE_DATE?.slice(0,10);
  return last ? {date:last,...await publicTrades(code,last)} : null;
}

export function technicalAt(rows,date) {
  const index=rows.findIndex(row=>row.date===date);
  if(index<0)return null;
  const row=rows[index];
  const prices=rows.slice(Math.max(0,index-19),index+1), priorVolume=rows.slice(Math.max(0,index-20),index);
  const average=(values,field)=>values.reduce((sum,value)=>sum+value[field],0)/values.length;
  const ma20=prices.length===20?average(prices,'close'):null;
  const avgVolume=priorVolume.length===20?average(priorVolume,'volume'):null;
  const prev=rows[index-1]?.close??null;
  return {date,close:row.close,ma20,aboveMA20:ma20?(row.close/ma20-1)*100:null,
    daily:prev?(row.close/prev-1)*100:null,fiveDay:index>=5?(row.close/rows[index-5].close-1)*100:null,
    volumeRatio:avgVolume>0?row.volume/avgVolume:null};
}

export async function listedDays(code, asOf) {
  return cached(trading,'listed:'+code+':'+asOf,async()=>{
    const since=new Date(Date.parse(asOf)-365*86400_000).toISOString().slice(0,10);
    const url=tradesUrl('RPT_BILLBOARD_DAILYDETAILS',"(SECURITY_CODE=\""+code+"\")(TRADE_DATE>='"+since+"')(TRADE_DATE<='"+asOf+"')");
    const listing=await json(url);
    if(!listing.success && !/没有相关数据|未查询到|无数据|返回数据为空/.test(listing.message??''))throw new Error('交易公开信息暂不可用');
    const days=new Map();
    for(const row of listing.result?.data??[]){
      const date=row.TRADE_DATE?.slice(0,10);
      if(row.SECURITY_CODE!==code||!date||date<since||date>asOf)continue;
      if(!days.has(date))days.set(date,new Set());
      if(row.EXPLANATION)days.get(date).add(row.EXPLANATION);
    }
    return {since,asOf,url,days:[...days.entries()].sort(([a],[b])=>b.localeCompare(a)).slice(0,12)
      .map(([date,reasons])=>({date,reasons:[...reasons],url:tradesUrl('RPT_BILLBOARD_DAILYDETAILS',"(SECURITY_CODE=\""+code+"\")(TRADE_DATE='"+date+"')")}))};
  });
}

export async function stockDossier(symbol,asOf,prices) {
  const priceRows=prices?.rows??[];
  const date=priceRows.filter(row=>row.date<=asOf).at(-1)?.date;
  const technical=date?{...technicalAt(priceRows,date),url:prices.url}:null;
  const nextDate=new Date(Date.parse(asOf)+86400_000).toISOString().slice(0,10);
  const [finance,list]=await Promise.allSettled([financialSeries(symbol,nextDate),listedDays(symbol.slice(2),asOf)]);
  const series=finance.value;
  const listData=list.value;
  const [filing,latest]=await Promise.allSettled([
    series?.latest?financialFiling(symbol,series.latest):null,
    listData?.days[0]?publicTrades(symbol.slice(2),listData.days[0].date):null
  ]);
  return {asOf,technical,value:series?{...series.latest,filing:filing.value??null}:null,
    comparable:series?.comparable??[],list:listData?{...listData,latest:latest.value??null}:null,
    availability:{value:finance.status==='fulfilled',trades:list.status==='fulfilled'}};
}

export async function researchContext(symbol,date,prices) {
  const technical=technicalAt(prices.rows,date);
  if(!technical)return null;
  const [value,trades]=await Promise.allSettled([financialSeries(symbol,date).then(series=>series?.latest??null),publicTrades(symbol.slice(2),date)]);
  const report=value.value;
  const [filing, previous]=await Promise.allSettled([
    report?financialFiling(symbol,report):null,
    trades.value?.rows.length===0?cached(trading,'last:'+symbol+':'+date,()=>lastDisclosedTrade(symbol.slice(2),date)):null
  ]);
  return {technical:{...technical,url:prices.url},value:report?{...report,filing:filing.value??null}:null,
    trades:trades.value?{...trades.value,previous:previous.value??null}:null,
    availability:{value:value.status==='fulfilled',trades:trades.status==='fulfilled'}};
}
