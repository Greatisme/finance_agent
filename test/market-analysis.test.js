import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleAnalysis } from '../src/market-analysis.js';

test('timeline keeps all sources and downgrades unsupported citations', () => {
  const text = '公司预计归母净利润同比下降百分之二十。';
  const makeItem = (id, kind, status) => ({
    id, kind, status, url: 'https://example.com/' + id, title: '样例 ' + id,
    parts: status === 'read' ? [{page:2,text}] : []
  });
  const entries = [makeItem('A1','公告','read'), makeItem('N1','资讯','read'), makeItem('N2','资讯','unavailable'), {...makeItem('N3','资讯','read'),afterClose:true}];
  const annotation = (id, part, quote) => ({
    id, part, quote, category:'财务业绩', impact:'利空', explanation:'利润下滑可能压低盈利预期。'
  });
  const result = assembleAnalysis({
    stock:{symbol:'sh603893'}, row:{date:'2026-11-17'}, source:{url:'https://example.com/market'}, entries
  }, JSON.stringify({
    items:[annotation('A1',2,text), annotation('N1',1,text), annotation('N2',2,text), annotation('N3',2,text)],
    movements:[{text:'有依据的判断',refs:['P','A1']}, {text:'错误段落',refs:['N1']}, {text:'未取得正文',refs:['N2']}, {text:'收盘后发布',refs:['N3']}],
    limitations:['时间关联不能证明因果。']
  }));
  assert.deepEqual(result.entries.map(item=>item.impact),['利空','证据不足','证据不足','利空']);
  assert.equal(result.entries[0].quoteUrl,'https://example.com/A1#page=2');
  assert.deepEqual(result.movements.map(item=>item.text),['有依据的判断']);
});
