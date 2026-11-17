import { createRequire } from 'node:module';
import path from 'node:path';
import { load } from 'cheerio';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const sectors = {
  sh603893: {name:'半导体',code:'BK1036',classification:'电子设备-半导体-集成电路'},
  sz002475: {name:'消费电子',code:'BK1037',classification:'电子设备-消费电子设备-消费电子设备'},
  sz002009: {name:'专用设备',code:'BK0910',classification:'机械设备-专用设备-其他专用机械'}
};
export const analyzedStocks = new Set(Object.keys(sectors));
const require = createRequire(import.meta.url);
const pdfAssets = path.dirname(require.resolve('pdfjs-dist/package.json'));
const maxPdfBytes = 12 * 1024 * 1024;
const maxPdfPages = 15;
const maxPdfText = 11000;
const windows = new Map();

async function fetchSource(url, maxBytes) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(11000) });
  if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('原文不可用或超出大小限制');
  }
  const chunks = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('原文超出大小限制');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
}

export async function readDisclosure(item) {
  if (!/^https:\/\/static\.cninfo\.com\.cn\/finalpage\/\d{4}-\d{2}-\d{2}\/[\w.-]+\.pdf$/i.test(item.url)) {
    throw new Error('未确认公告原文地址');
  }
  const bytes = await fetchSource(item.url, maxPdfBytes);
  if (bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('公告源未返回 PDF');
  const task = getDocument({
    data: new Uint8Array(bytes), cMapUrl: path.join(pdfAssets,'cmaps').split(path.sep).join('/')+'/', cMapPacked:true,
    standardFontDataUrl:path.join(pdfAssets,'standard_fonts').split(path.sep).join('/')+'/', useSystemFonts:false,
    isEvalSupported:false, verbosity:0
  });
  try {
    const doc = await task.promise;
    const parts = [];
    let remaining = maxPdfText, examined = 0, clipped = false;
    for (let page=1;page<=Math.min(doc.numPages,maxPdfPages)&&remaining>0;page++) {
      const content=await (await doc.getPage(page)).getTextContent();
      const text=content.items.map(item=>item.str ? item.str+(item.hasEOL?'\n':' ') : '').join('').trim();
      examined++;
      if (!text) continue;
      clipped ||= text.length > remaining;
      parts.push({page,text:text.slice(0,remaining)});
      remaining-=text.length;
    }
    return {parts,coverage:{pages:doc.numPages, examined, partial:clipped || examined<doc.numPages || parts.length<examined}};
  } finally { await task.destroy(); }
}

function articleUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !/^[a-z]+\.eastmoney\.com$/.test(url.hostname) ||
      !/^\/a\/\d+\.html$/.test(url.pathname)) return null;
    return 'https://' + url.hostname + url.pathname;
  } catch { return null; }
}

export async function stockNews(stock, start, date) {
  const query = {
    uid:'',keyword:stock.name,type:['cmsArticleWebOld'],client:'web',clientVersion:'curr',
    param:{cmsArticleWebOld:{searchScope:'default',sort:'time',pageIndex:1,pageSize:60,preTag:'',postTag:''}}
  };
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?' + new URLSearchParams({
    cb:'financeCallback',param:JSON.stringify(query)
  });
  const raw = (await fetchSource(url, 2 * 1024 * 1024)).toString('utf8');
  const payload = raw.match(/^\s*financeCallback\(([\s\S]+)\);?\s*$/);
  const items = payload && JSON.parse(payload[1]).result?.cmsArticleWebOld;
  if (!Array.isArray(items)) throw new Error('资讯索引暂不可用');
  const matching = new Map();
  for (const row of items) {
    const url = articleUrl(row.url);
    const published = String(row.date ?? '');
    if (!url || !/^\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d$/.test(published) ||
        published.slice(0,10)<start || published.slice(0,10)>date || typeof row.title!=='string') continue;
    matching.set(url,{url,published,date:published.slice(0,10),title:row.title.replace(/<[^>]*>/g,'').slice(0,220),
      afterClose:published.slice(0,10)===date && published.slice(11)>='15:00:00',
      publisher:String(row.mediaName ?? '东方财富').slice(0,60)});
  }
  return {scanned:items.length,matched:matching.size,items:[...matching.values()].slice(0,6)};
}

export async function readNews(item) {
  if (articleUrl(item.url) !== item.url) throw new Error('未确认资讯原文地址');
  const $ = load((await fetchSource(item.url, 3 * 1024 * 1024)).toString('utf8'));
  const paragraphs = $('#ContentBody p').map((_,p)=>$(p).text().trim()).get().filter(Boolean);
  let remaining = 8500;
  const parts = [];
  for (const [index,text] of paragraphs.entries()) {
    if (remaining<=0) break;
    parts.push({page:index+1,text:text.slice(0,remaining)});
    remaining-=text.length;
  }
  return {parts,coverage:{partial:parts.length < paragraphs.length || remaining<0}};
}

async function eastmoney(url) {
  return JSON.parse((await fetchSource(url, 1024*1024)).toString('utf8')).data;
}

export async function stockIndustry(stock,date) {
  const sector=sectors[stock.symbol];
  if(!sector) return null;
  const {name,code,classification}=sector;
  const profileUrl='https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code='+stock.symbol.toUpperCase();
  const url='https://push2his.eastmoney.com/api/qt/stock/kline/get?'+new URLSearchParams({
    secid:'90.'+code,klt:'101',fqt:'0',lmt:'10',end:date.replaceAll('-',''),fields1:'f1,f2',fields2:'f51,f53'
  });
  const result=await eastmoney(url);
  if(result?.code!==code || !Array.isArray(result.klines)) return null;
  const rows=result.klines.map(line=>line.split(','));
  const at=rows.findIndex(row=>row[0]===date);
  if(at<1) return null;
  const close=Number(rows[at][1]), previousClose=Number(rows[at-1][1]);
  if(!(close>0&&previousClose>0)) return null;
  return {name,code,date,close,previousClose,returnPct:(close/previousClose-1)*100,
    fiveDayReturnPct: at>=5 && Number(rows[at-5][1])>0 ? (close/Number(rows[at-5][1])-1)*100 : null,
    classification:'东方财富公司分类：'+classification+'。使用对应板块作历史对照，未核实当日归属。', url, profileUrl};
}

async function withContent(items) {
  const output = [];
  const perItem = Math.floor(48_000 / Math.max(1,items.length));
  for(let index=0;index<items.length;index+=3){
    const batch=items.slice(index,index+3);
    output.push(...await Promise.all(batch.map(async item=>{
      try {
        const result=await (item.kind==='公告' ? readDisclosure(item) : readNews(item));
        let remaining=perItem;
        const parts=[];
        for(const part of result.parts){
          if(remaining<=0) break;
          parts.push({page:part.page,text:part.text.slice(0,remaining)});
          remaining-=part.text.length;
        }
        return {...item,parts,status:parts.length?'read':'unreadable',
          coverage:{...result.coverage,partial:result.coverage.partial || parts.length<result.parts.length || remaining<0}};
      } catch {return {...item,parts:[],status:'unavailable'};}
    })));
  }
  return output;
}

export function readEvidenceWindow(evidence) {
  const key=evidence.stock.symbol+':'+evidence.row.date;
  const saved=windows.get(key);
  if(saved?.until>Date.now()) return saved.result;
  if(windows.size>=24) windows.delete(windows.keys().next().value);
  const result=(async()=>{
    const date=evidence.row.date;
    const start=new Date(Date.parse(date+'T00:00:00Z')-7*86400_000).toISOString().slice(0,10);
    const [news,sector]=await Promise.allSettled([stockNews(evidence.stock,start,date),stockIndustry(evidence.stock,date)]);
    const newsIndex=news.status==='fulfilled'?news.value:null;
    const entries=[
      ...(evidence.disclosures?.items ?? []).map((item,index)=>({...item,id:'A'+(index+1),kind:'公告',publisher:'巨潮资讯'})),
      ...(newsIndex?.items ?? []).map((item,index)=>({...item,id:'N'+(index+1),kind:'资讯'}))
    ].sort((a,b)=>(b.published??b.date).localeCompare(a.published??a.date));
    return { ...evidence, industry:sector.status==='fulfilled'?sector.value:null,
      window:{start,end:date,disclosureTotal:evidence.disclosures?.total??null,newsScanned:newsIndex?.scanned??null,newsMatched:newsIndex?.matched??null},
      entries:await withContent(entries)};
  })();
  windows.set(key,{until:Date.now()+5*60_000,result});
  return result;
}
