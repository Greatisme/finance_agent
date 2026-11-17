import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForecast } from '../src/forecast.js';

function candles(size) {
  return Array.from({length:size},(_,index)=>({
    date:new Date(Date.UTC(2020,0,1+index)).toISOString().slice(0,10),
    close:100*1.002**index
  }));
}

test('forecast excludes later bars, fingerprints canonical prices, and evaluates a chronological holdout',()=>{
  const rows=candles(680);
  const asOf=rows[599].date;
  const reference=buildForecast(rows.slice(0,600),{asOf,source:{url:'https://example.com',retrievedAt:'A'}});
  const actual=buildForecast([...rows].reverse(),{asOf,source:{url:'https://example.com',retrievedAt:'B'}});
  assert.deepEqual(actual,reference);
  assert.equal(actual.inputFingerprint.length,64);
  assert.equal(actual.basePrice,rows[599].close);
  assert.equal(actual.asOf,asOf);
  assert.equal(actual.status,'ready');
  for(const horizon of actual.horizons) {
    assert.ok(horizon.upProbability>0.999);
    assert.equal(horizon.downProbability,0);
    assert.ok(Math.abs(horizon.expectedPrice-actual.basePrice*1.002**horizon.sessions)<1e-8);
    assert.ok(horizon.validation.lastTrainingOutcome<horizon.validation.start);
    assert.ok(horizon.validation.end<=asOf);
    assert.ok(horizon.validation.samples<=Math.ceil((600*0.35)/horizon.sessions));
    assert.equal(horizon.conclusion,'neutral');
  }
  const changed=rows.slice(0,600);
  changed[35]={...changed[35],close:changed[35].close*1.001};
  assert.notEqual(buildForecast(changed,{asOf}).inputFingerprint,actual.inputFingerprint);
});

test('unverified disclosures cannot alter the model estimates or enter its institutional validation',()=>{
  const rows=candles(500);
  const asOf=rows.at(-1).date;
  const reference=buildForecast(rows,{asOf});
  const actual=buildForecast(rows,{asOf,listingDays:{
    since:rows[0].date,asOf,days:rows.filter((_,index)=>index%43===0)
  }});
  assert.equal(actual.institutions.status,'context_only');
  assert.equal(actual.inputFingerprint,reference.inputFingerprint);
  assert.deepEqual(actual.horizons,reference.horizons);
});

test('institution disclosure dates become known only from the following session',()=>{
  const rows=candles(430);
  const published=rows[428].date;
  const listingDays={complete:true,since:rows[0].date,asOf:rows[429].date,days:[{date:published}]};
  const onDisclosure=buildForecast(rows,{asOf:published,listingDays});
  const nextSession=buildForecast(rows,{asOf:rows[429].date,listingDays});
  assert.equal(onDisclosure.institutions.eligibleSignals,0);
  assert.equal(nextSession.institutions.eligibleSignals,1);
  assert.equal(nextSession.institutions.status,'context_only');
});
