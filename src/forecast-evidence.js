import { bars } from './market.js';
import { industryHistory } from './market-sources.js';

const institutionSince = '2020-01-01';
const institutionReports = ['RPT_BILLBOARD_DAILYDETAILSBUY', 'RPT_BILLBOARD_DAILYDETAILSSELL'];
const institutionalCache = new Map();

async function institutionSide(symbol, asOf, reportName) {
  const code = symbol.slice(2);
  const source = new URL('https://datacenter-web.eastmoney.com/api/data/v1/get');
  source.search = new URLSearchParams({
    reportName, columns:'SECURITY_CODE,TRADE_DATE,OPERATEDEPT_NAME',
    filter:'(SECURITY_CODE="'+code+'")(OPERATEDEPT_NAME="机构专用")(TRADE_DATE>=\''+institutionSince+'\')(TRADE_DATE<=\''+asOf+'\')',
    sortColumns:'TRADE_DATE', sortTypes:'-1', pageSize:'100', pageNumber:'1'
  });

  const sourceUrl=source.href;
  const dates = new Set();
  let expectedPages, expectedCount, count=0;
  for(let page=1;page<=5;page++){
    source.searchParams.set('pageNumber',String(page));
    const response=await fetch(source,{signal:AbortSignal.timeout(8500)});
    if(!response.ok)throw new Error('机构披露来源暂不可用');
    const data=await response.json();
    if(page===1&&!data.success&&/返回数据为空|没有相关数据/.test(data.message??''))return {sourceUrl,dates:[]};
    const result=data.result;
    if(!data.success||!Number.isInteger(result?.pages)||result.pages<1||result.pages>5||
       !Number.isInteger(result.count)||!Array.isArray(result.data)){
      throw new Error('机构披露日期覆盖未核实');
    }
    expectedPages??=result.pages;
    expectedCount??=result.count;
    if(result.pages!==expectedPages||result.count!==expectedCount)throw new Error('机构披露分页变动');
    for(const row of result.data){
      const date=row.TRADE_DATE?.slice(0,10);
      if(row.SECURITY_CODE!==code||row.OPERATEDEPT_NAME!=='机构专用'||
         !/^\d{4}-\d{2}-\d{2}$/.test(date??'')||date<institutionSince||date>asOf){
        throw new Error('机构披露记录与查询范围不符');
      }
      dates.add(date);
      count++;
    }
    if(page===expectedPages){
      if(count!==expectedCount)throw new Error('机构披露分页数据不完整');
      return {sourceUrl,dates:[...dates]};
    }
  }
  throw new Error('机构披露超出分页范围');
}

export function institutionalHistory(symbol, asOf) {
  const cached=institutionalCache.get(symbol);
  if(cached?.asOf===asOf&&cached.expires>Date.now())return cached.result;
  const result=Promise.all(institutionReports.map(report=>institutionSide(symbol,asOf,report))).then(rows=>({
    since:institutionSince,asOf,complete:true,
    days:[...new Set(rows.flatMap(row=>row.dates))].sort().map(date=>({date})),
    sources:rows.map((row,index)=>({label:index===0?'机构买入榜披露':'机构卖出榜披露',url:row.sourceUrl}))
  })).catch(()=>null);
  institutionalCache.set(symbol,{asOf,expires:Date.now()+10*60_000,result});
  return result;
}

export async function marketContext(symbol, asOf) {
  if(!asOf)return {};
  const [market,industry]=await Promise.allSettled([
    bars('sh000300',{end:asOf,limit:35}),industryHistory(symbol,asOf,35)
  ]);
  return {market:market.value,industry:industry.value};
}

const pct = value => value==null?'—':(value>0?'+':'')+value.toFixed(2)+'%';
const sources = (label,url) => url?[{label,url}]:[];

function movement(data) {
  const rows=data?.rows??[];
  const latest=rows.at(-1), prior=rows.at(-6);
  if(!latest)return null;
  const change=prior?.close>0?(latest.close/prior.close-1)*100:null;
  return latest.date+' 收盘 '+latest.close.toFixed(2)+' 点'+(change==null?'':'，近 5 日 '+pct(change))+'。';
}

export function forecastDrivers(forecast,dossier,events,{market,industry},institutions) {
  const active=forecast.status==='ready';
  const asOf=forecast.asOf??dossier.asOf;
  const technical=dossier.technical;
  const policy=events.filter(item=>item.date<=asOf&&item.date>=new Date(Date.parse(asOf)-90*86_400_000).toISOString().slice(0,10)&&
    /政策|监管|产业规划|补贴|关税|征求意见/.test(item.title)&&item.quoteUrl).at(-1);
  const lastSeat=institutions?.days.at(-1);
  const listing=dossier.list;
  const lastListing=listing?.days?.[0];
  const value=dossier.value;
  const indexMove=movement(market), industryMove=movement(industry);
  return [
    {key:'prices',label:'个股行情',use:active?'model':'missing',
      detail:active?'以已收盘的个股日线计算。最近一日 '+pct(technical?.daily)+'，最近五日 '+pct(technical?.fiveDay)+'。':'未取得足够的已收盘日线。',
      sources:sources('个股日线',forecast.source?.url??technical?.url)},
    {key:'policy',label:'政策与监管',use:policy?'context':'missing',
      detail:policy?policy.date+' · '+policy.title+'。近 90 天档案中的已核对原文。':'近 90 天档案中暂没有已核对原文的相关政策或监管记录。',
      sources:sources('公告或资讯原文',policy?.quoteUrl)},
    {key:'market',label:'大盘行情',use:indexMove?'context':'missing',detail:indexMove??'暂未取得同期沪深 300 日线。',
      sources:sources('沪深 300 日线',market?.url)},
    {key:'industry',label:'行业走势',use:industryMove?'context':'missing',detail:industryMove?industry.name+' · '+industryMove:'暂未取得同期行业日线。',
      sources:sources('行业日线',industry?.url)},
    {key:'institutions',label:'机构公开席位',use:lastSeat||lastListing?'context':'missing',
      detail:(lastSeat?'最近一次机构专用席位出现在 '+lastSeat.date+'。':lastListing?'最近龙虎榜公开交易日为 '+lastListing.date+'，机构席位历史暂未核实。':'暂未取得可核实的机构席位记录。')+
        (institutions?'自 '+institutions.since+' 起，来源共返回 '+institutions.days.length+' 个席位披露日。':'')+
        '公开席位只覆盖披露范围。'+(forecast.institutions?.reason??''),
      sources:institutions?.sources??sources('查看龙虎榜公开记录',listing?.url)},
    {key:'fundamentals',label:'公司财报',use:value?'context':'missing',
      detail:value?value.period+' 报告期 · 营收同比 '+pct(value.revenueYoY)+'，归母净利润同比 '+pct(value.profitYoY)+'。':'暂未取得已发布的公司财报。',
      sources:sources(value?.filing?'报告原文':'财报指标',value?.filing?.url??value?.url)}
  ];
}
