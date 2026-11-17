import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntraday, pollingWindow } from '../src/intraday.js';

test('minute snapshot sorts points, de-duplicates minutes and converts cumulative volume', () => {
  const symbol='sh603893';
  const payload={code:0,data:{[symbol]:{data:{date:'20261117',data:[
    '1300 11.0 22', '0930 10.0 5','0931 10.5 15','0931 10.6 18','1215 10.9 19','1501 0 99'
  ]},qt:{[symbol]:['','','','','9.8']}}}};
  const result=parseIntraday(payload,symbol,'2026-11-17T05:01:00.000Z');
  assert.equal(result.date,'2026-11-17');
  assert.equal(result.previousClose,9.8);
  assert.deepEqual(result.points,[
    {time:'09:30',price:10,volume:5},{time:'09:31',price:10.6,volume:13},{time:'13:00',price:11,volume:4}
  ]);
  assert.throws(()=>parseIntraday({},symbol,'2026-11-17T05:01:00.000Z'),/不完整/);
});

test('polling follows Shanghai time, skips lunch and weekends, and captures the close', () => {
  for (const date of ['2026-11-17T01:30Z','2026-11-17T05:00Z','2026-11-17T07:01Z'])
    assert.equal(pollingWindow(new Date(date)),true,date);
  for (const date of ['2026-11-17T01:29Z','2026-11-17T04:00Z','2026-11-17T07:10Z','2026-11-21T01:45Z'])
    assert.equal(pollingWindow(new Date(date)),false,date);
});
