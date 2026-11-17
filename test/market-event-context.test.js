import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedEvents, followThrough, closedThrough } from '../src/market-events.js';
import { latestKnownReport } from '../src/research-context.js';
import { calculateIndicators } from '../web/indicators.js';

test('event results use the same sessions and exclude selected day while intraday', () => {
  const days=['2026-11-06','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13'];
  const stock=days.map((date,i)=>({date,close:100+i}));
  const industry=days.filter(date=>date!=='2026-11-09').map(date=>({date,close:50+days.indexOf(date)}));
  const session={date:'2026-11-07',calendar:stock,stock,industry};
  const cutoff=closedThrough(new Date('2026-11-13T05:00:00Z'));
  const incomplete=followThrough(session.date,session.calendar,stock,industry,cutoff);
  assert.equal(incomplete.baseline,'2026-11-06');
  assert.equal(incomplete.start,'2026-11-09');
  assert.equal(incomplete.results[0].stock.close,101);
  assert.equal(incomplete.results[0].industry,null);
  assert.equal(incomplete.results[1].date,null);
  const full=followThrough(session.date,stock,stock,industry,'2026-11-13');
  assert.equal(full.results[1].date,'2026-11-13');
  assert.equal(full.results[1].industry.close,55);
  assert.equal(full.results[2].date,null);
});

test('event feed deduplicates sourced directional marks by stock and URL',()=>{
  const item={url:'https://example.com/source',quoteUrl:'https://example.com/source#page=1',
    quote:'有核实过的正文',date:'2026-11-03',title:'测试事项',impact:'利多',id:'A1'};
  const report=entries=>({report:{stock:{symbol:'sh603893'},date:'2026-11-11',entries,movements:[]}});
  const events=reviewedEvents([report([item]),report([item,{...item,url:'https://example.com/unknown',quote:''}])],'sh603893');
  assert.equal(events.length,1);
  assert.equal(events[0].side,'多方');
  assert.deepEqual(reviewedEvents([report([item])],'sz002009'),[]);
});

test('fundamentals omit unannounced and same-date financial reports',()=>{
  const records=[
    {SECURITY_CODE:'603893',NOTICE_DATE:'2026-10-27',REPORT_DATE:'2026-09-30'},
    {SECURITY_CODE:'603893',NOTICE_DATE:'2026-08-22',REPORT_DATE:'2026-06-30'},
    {SECURITY_CODE:'002009',NOTICE_DATE:'2026-08-22',REPORT_DATE:'2026-06-30'}
  ];
  assert.equal(latestKnownReport(records,'603893','2026-10-27')?.REPORT_DATE,'2026-06-30');
  assert.equal(latestKnownReport(records,'603893','2026-10-28')?.REPORT_DATE,'2026-09-30');
});

test('MACD and RSI wait for warm-up and handle flat, rising and falling series',()=>{
  const flat=calculateIndicators(Array(50).fill(10));
  assert.equal(flat[13].rsi,null);
  assert.equal(flat[14].rsi,50);
  assert.equal(flat[32].macd,null);
  assert.equal(flat[33].macd,0);
  assert.equal(calculateIndicators(Array.from({length:60},(_,i)=>i+1)).at(-1).rsi,100);
  assert.equal(calculateIndicators(Array.from({length:60},(_,i)=>60-i)).at(-1).rsi,0);
});
