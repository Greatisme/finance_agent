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

async function bars(symbol) {
  return cached('bars:'+symbol, 5 * 60_000, async () => {
    const url = `${quoteHost}/appstock/app/fqkline/get?param=${symbol},day,,,140,`;
    const payload = await getJson(url);
    const series = payload.data?.[symbol]?.day;
    if (payload.code !== 0 || !Array.isArray(series)) throw new Error('未取得腾讯未复权日线');
    const rows = [...new Map(series.filter(Array.isArray).map(([date,open,close,high,low,volume]) => [
      date, {date, open:+open, close:+close, high:+high, low:+low, volume:+volume}
    ])).values()].filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
      [row.open,row.close,row.high,row.low,row.volume].every(Number.isFinite) && row.low > 0 && row.volume >= 0 &&
      row.high >= Math.max(row.open,row.close,row.low) && row.low <= Math.min(row.open,row.close));
    rows.sort((a,b)=>a.date.localeCompare(b.date));
    if (rows.length < 2) throw new Error('有效行情不足');
    return {rows, url, retrievedAt: new Date().toISOString()};
  });
}

function statsAt(rows,index) {
  const row = rows[index], prior = rows[index-1];
  const volumes = rows.slice(Math.max(0,index-20),index);
  const meanVolume = volumes.length === 20 ? volumes.reduce((sum,item)=>sum+item.volume,0)/20 : 0;
  return {...row, returnPct: prior ? (row.close/prior.close-1)*100 : null,
    previousClose: prior?.close ?? null, volumeMultiple: meanVolume > 0 ? row.volume/meanVolume : null};
}

export async function stockChart(symbol) {
  if (!symbolPattern.test(symbol)) return null;
  const stock = (await directory()).find(row=>row.symbol===symbol);
  if (!stock) return null;
  const data = await bars(symbol);
  return {stock: {name:stock.name, code:stock.code, symbol}, rows:data.rows.map((_,index)=>statsAt(data.rows,index)),
    source:{url:data.url,retrievedAt:data.retrievedAt}};
}

function dateOffset(date, days) {
  const day = new Date(date+'T00:00:00Z');
  day.setUTCDate(day.getUTCDate()+days);
  return day.toISOString().slice(0,10);
}

async function disclosureWindow(stock, date) {
  const start = dateOffset(date,-7);
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
  return {start,end:date,total:result.totalAnnouncement,items:items.slice(0,8)};
}

export async function stockEvidence(symbol,date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return cached('evidence:'+symbol+':'+date, 5 * 60_000, async () => {
    const chart = await stockChart(symbol);
    const row = chart?.rows.find(item=>item.date===date && item.previousClose!==null);
    if (!row) return null;
    const stock = (await directory()).find(item=>item.symbol===symbol);
    const [index, disclosures] = await Promise.allSettled([bars('sh000300'),disclosureWindow(stock,date)]);
    const marketIndex = index.status==='fulfilled' ? index.value.rows.findIndex(item=>item.date===date) : -1;
    const benchmark = marketIndex>0 ? {
      returnPct:statsAt(index.value.rows,marketIndex).returnPct,url:index.value.url
    } : null;
    return {stock:chart.stock,row,source:chart.source,benchmark,
      disclosures:disclosures.status==='fulfilled' ? disclosures.value : null};
  });
}
