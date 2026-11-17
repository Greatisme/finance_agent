const cninfo = 'https://www.cninfo.com.cn';
const quoteHost = 'https://web.ifzq.gtimg.cn';
const symbolPattern = /^(sh|sz)\d{6}$/;
const cache = new Map();

function cached(key, lifetime, load) {
  const saved = cache.get(key);
  if (saved?.until > Date.now()) return saved.result;
  if (cache.size >= 250) cache.delete(cache.keys().next().value);
  const result = load().catch(error => {
    if (cache.get(key)?.result === result) cache.delete(key);
    throw error;
  });
  cache.set(key, { until: Date.now() + lifetime, result });
  return result;
}

async function getJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(9500) });
  if (!response.ok) throw new Error('数据源暂不可用');
  return response.json();
}

async function directory() {
  return cached('directory', 3600_000, async () => {
    const result = await getJson(cninfo + '/new/data/szse_stock.json');
    if (!Array.isArray(result.stockList)) throw new Error('证券名单格式异常');
    return result.stockList.filter(row => row.category === 'A股' && /^(60|68|00|30)\d{4}$/.test(row.code) &&
      typeof row.zwjc === 'string' && typeof row.orgId === 'string').map(row => {
        const exchange = row.code.startsWith('6') ? 'sh' : 'sz';
        return { symbol: exchange + row.code, name: row.zwjc, code: row.code,
          pinyin: String(row.pinyin ?? '').toLowerCase(), orgId: row.orgId, market: exchange === 'sh' ? 'sse' : 'szse' };
      });
  });
}

export async function searchStocks(input) {
  const query = input.trim().toLowerCase();
  if (!query || query.length > 40) return [];
  const stocks = await directory();
  const matches = stocks.filter(row => row.symbol === query || row.name.includes(query) ||
    row.code.startsWith(query) || row.pinyin.startsWith(query));
  const rank = row => row.code === query || row.symbol === query || row.name === query ? 0 : 1;
  return matches.sort((a,b) => rank(a)-rank(b)).slice(0,10).map(({symbol,name,code}) => ({symbol,name,code}));
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const marketToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function listingInfo(symbol) {
  return cached('listing:'+symbol, 24 * 3600_000, async () => {
    const code = symbol.slice(2)+'.'+symbol.slice(0,2).toUpperCase();
    const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get?'+new URLSearchParams({
      reportName: 'RPT_F10_BASIC_ORGINFO', columns: 'SECUCODE,LISTING_DATE', filter: '(SECUCODE="'+code+'")'
    });
    const payload = await getJson(url);
    const row = payload.result?.data?.find(item => item.SECUCODE === code);
    const date = row?.LISTING_DATE?.slice(0,10);
    if (!datePattern.test(date ?? '') || date < '1990-12-19' || date > marketToday()) throw new Error('未取得上市日期');
    return { date, url };
  });
}

async function tencentDaily(symbol, start, end, limit) {
  const url = quoteHost+'/appstock/app/fqkline/get?param='+[symbol,'day',start,end,limit,''].join(',');
  const payload = await getJson(url);
  const rows = payload.data?.[symbol]?.day;
  if (payload.code !== 0 || !Array.isArray(rows)) throw new Error('未取得腾讯未复权日线');
  return {url, rows};
}

async function eastmoneyDaily(symbol, start, end, limit) {
  const code = symbol.slice(2);
  const market = symbol.startsWith('sh') ? '1' : '0';
  const params = new URLSearchParams({
    secid:market+'.'+code, klt:'101', fqt:'0', lmt:String(limit),
    end:(end||marketToday()).replaceAll('-',''), fields1:'f1,f2', fields2:'f51,f52,f53,f54,f55,f56'
  });
  if (start) params.set('beg',start.replaceAll('-',''));
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?'+params;
  const payload = await getJson(url);
  if (payload.rc !== 0 || payload.data?.code !== code || !Array.isArray(payload.data.klines)) {
    throw new Error('未取得东方财富未复权日线');
  }
  return { url, rows:payload.data.klines.map(row=>row.split(',')) };
}

export async function bars(symbol, { start='', end='', limit=300 }={}) {
  const lifetime = end && end < marketToday() ? 24 * 3600_000 : 5 * 60_000;
  return cached(['bars',symbol,start,end,limit].join(':'), lifetime, async () => {
    const {url, rows:series} = await tencentDaily(symbol,start,end,limit).catch(()=>eastmoneyDaily(symbol,start,end,limit));
    const rows = [...new Map(series.filter(Array.isArray).map(([date,open,close,high,low,volume]) => [
      date, {date, open:+open, close:+close, high:+high, low:+low, volume:+volume}
    ])).values()].filter(row => datePattern.test(row.date) && (!start || row.date >= start) && (!end || row.date <= end) &&
      [row.open,row.close,row.high,row.low,row.volume].every(Number.isFinite) && row.low > 0 && row.volume >= 0 &&
      row.high >= Math.max(row.open,row.close,row.low) && row.low <= Math.min(row.open,row.close));
    rows.sort((a,b)=>a.date.localeCompare(b.date));
    if (!rows.length) throw new Error('有效行情不足');
    return {rows, url, retrievedAt: new Date().toISOString()};
  });
}

async function historicalBars(symbol, recent, listing) {
  const last = recent.rows.at(-1).date;
  const ranges = [];
  // Two calendar years fit under the provider's 640-row limit.
  for (let start=listing.date; start<recent.rows[0].date;) {
    const rangeEnd = (Number(start.slice(0,4))+1)+'-12-31';
    const end = rangeEnd < last ? rangeEnd : last;
    ranges.push({start,end,limit:640});
    start = dateOffset(end,1);
  }
  const segments = [];
  for (let i=0;i<ranges.length;i+=5) {
    segments.push(...await Promise.allSettled(ranges.slice(i,i+5).map(range=>bars(symbol,range))));
  }
  const failed = segments.flatMap((part, index) => part.status === 'rejected' ? [index] : []);
  for (let i=0; i<failed.length; i+=2) {
    const batch = failed.slice(i,i+2);
    const retried = await Promise.allSettled(batch.map(index=>bars(symbol,ranges[index])));
    batch.forEach((index, offset)=>{segments[index]=retried[offset];});
  }
  // Keep the newest uninterrupted series if a request failed. The coverage label
  // will show that older candles are missing rather than bridge an unknown period.
  const available = segments.slice(segments.findLastIndex(part=>part.status==='rejected')+1).map(part=>part.value);
  const rows = new Map();
  for (const segment of [...available,recent]) {
    for (const row of segment.rows) if (row.date>=listing.date) rows.set(row.date,row);
  }
  return { ...recent, rows:[...rows.values()].sort((a,b)=>a.date.localeCompare(b.date)), historyUrls:available.map(part=>part.url) };
}

function statsAt(rows,index) {
  const row = rows[index], prior = rows[index-1];
  const volumes = rows.slice(Math.max(0,index-20),index);
  const meanVolume = volumes.length === 20 ? volumes.reduce((sum,item)=>sum+item.volume,0)/20 : 0;
  return {...row, returnPct: prior ? (row.close/prior.close-1)*100 : null,
    fiveDayReturnPct: index>=5 ? (row.close/rows[index-5].close-1)*100 : null,
    twentyDayReturnPct: index>=20 ? (row.close/rows[index-20].close-1)*100 : null,
    previousClose: prior?.close ?? null, volumeMultiple: meanVolume > 0 ? row.volume/meanVolume : null};
}

export async function stockChart(symbol, { recentOnly = false }={}) {
  if (!symbolPattern.test(symbol)) return null;
  const stock = (await directory()).find(row=>row.symbol===symbol);
  if (!stock) return null;
  const [recent, listing] = await Promise.all([
    bars(symbol), recentOnly ? null : listingInfo(symbol).catch(()=>null)
  ]);
  const data = listing && listing.date<recent.rows[0].date ? await historicalBars(symbol,recent,listing) : recent;
  const start = data.rows[0].date, end = data.rows.at(-1).date;
  return {stock: {name:stock.name, code:stock.code, symbol}, rows:data.rows.map((_,index)=>statsAt(data.rows,index)),
    source:{url:data.url,retrievedAt:data.retrievedAt,historyUrls:data.historyUrls??[]},
    coverage:{start,end,listingDate:listing?.date??null,fromListing:start===listing?.date,listingSource:listing?.url??null}};
}

function dateOffset(date, days) {
  const day = new Date(date+'T00:00:00Z');
  day.setUTCDate(day.getUTCDate()+days);
  return day.toISOString().slice(0,10);
}

async function disclosureWindow(stock, date, { days=30, limit=8 }={}) {
  const start = dateOffset(date,-days);
  const url = cninfo+'/new/hisAnnouncement/query';
  const body = new URLSearchParams({pageNum:'1',pageSize:'30',tabName:'fulltext',column:stock.market,
    stock:stock.code+','+stock.orgId,seDate:start+'~'+date});
  const result = await getJson(url,{method:'POST',headers:{Referer:cninfo+'/'},body});
  if (!Number.isFinite(result.totalAnnouncement) || (result.totalAnnouncement > 0 && !Array.isArray(result.announcements))) {
    throw new Error('巨潮公告响应不完整');
  }
  const items = [...new Map((result.announcements ?? []).filter(row=>row.secCode===stock.code &&
    typeof row.announcementTitle==='string' && /^finalpage\/\d{4}-\d{2}-\d{2}\/[\w.-]+\.pdf$/i.test(row.adjunctUrl))
    .map(row=>[row.announcementId,{
      title:row.announcementTitle.replace(/<[^>]*>/g,'').slice(0,220),
      date:row.adjunctUrl.split('/')[1],url:'https://static.cninfo.com.cn/'+row.adjunctUrl
    }])).values()].filter(row=>row.date>=start && row.date<=date);
  return {start,end:date,total:result.totalAnnouncement,items:items.slice(0,limit)};
}

export async function financialFiling(symbol,report) {
  const title = {'三季报':/第?三季度报告/,'一季报':/第?一季度报告/,'半年报':/半年度报告/,'年报':/年度报告/}[report.kind];
  if(!title)return null;
  return cached('filing:'+symbol+':'+report.period,3600_000,async()=>{
    const stock=(await directory()).find(item=>item.symbol===symbol);
    if(!stock)return null;
    const data=await disclosureWindow(stock,report.disclosed,{days:1,limit:30});
    return data.items.find(item=>item.title.includes(report.period.slice(0,4)) && title.test(item.title) &&
      !/摘要|英文|提示性|修订前/.test(item.title))??null;
  });
}

export async function stockEvidence(symbol,date) {
  if (!symbolPattern.test(symbol) || !datePattern.test(date)) return null;
  return cached('evidence:'+symbol+':'+date, 5 * 60_000, async () => {
    const stock = (await directory()).find(item=>item.symbol===symbol);
    if (!stock) return null;
    const range = {end:date};
    const [prices, index, disclosures] = await Promise.allSettled([
      bars(symbol,range), bars('sh000300',range), disclosureWindow(stock,date)
    ]);
    const stockIndex = prices.value?.rows.findIndex(item=>item.date===date) ?? -1;
    if (stockIndex<0) return null;
    const row = statsAt(prices.value.rows,stockIndex);
    const marketIndex = index.value?.rows.findIndex(item=>item.date===date) ?? -1;
    const stats = marketIndex>0 ? statsAt(index.value.rows,marketIndex) : null;
    const benchmark = stats ? {
      returnPct:stats.returnPct, fiveDayReturnPct:stats.fiveDayReturnPct,
      twentyDayReturnPct:stats.twentyDayReturnPct, url:index.value.url
    } : null;
    return {stock:{name:stock.name,code:stock.code,symbol},row,
      source:{url:prices.value.url,retrievedAt:prices.value.retrievedAt},benchmark,
      disclosures:disclosures.status==='fulfilled' ? disclosures.value : null};
  });
}
