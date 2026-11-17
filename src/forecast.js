import { createHash } from 'node:crypto';
import { mean, metrics, pairedBlockInterval } from './model.js';

const config = Object.freeze({
  horizons:Object.freeze([1,5,20]),
  maxHistory:2000,
  lookback:20,
  trendThresholdPct:3,
  trainShare:0.65,
  minTraining:80,
  minValidation:20,
  shrinkage:40,
  rangeCoverage:0.80,
  directionalThreshold:0.55,
  bootstrapReplicates:240,
  bootstrapSeed:42
});
const { horizons, maxHistory, lookback, minTraining, minValidation, shrinkage, rangeCoverage }=config;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const model = Object.freeze({
  id:'historical-trend',
  version:'1.0.0',
  config,
  label:'历史趋势概率模型',
  method:'按过去 20 个有行情交易日的涨跌分组。上涨超过 3%、下跌超过 3%和其余情况分别估计，样本少时向全部历史样本加权。近 35% 数据留作时间外检验，基准为不分组的历史上涨率和平均涨跌幅。',
  methodUrl:'https://otexts.com/fpp3/accuracy.html',
  priceBasis:'未复权收盘价。上涨指第 N 个有行情交易日的收盘价严格高于基准收盘价。',
  limitations:Object.freeze([
    '每只股票单独使用最近最多 2,000 条已收盘日线。',
    '分红、送转和除权可能造成价格跳变，涨跌幅不包含分红收益。',
    '遇到停牌或行情缺报，按下一条有效日线计数，不推算具体到期日期。',
    '价格区间取历史分布的中间 80%，实际覆盖率按时间外样本检验。',
    '财报、政策、板块与机构披露在独立证据中展示，当前数值模型只使用日线价格。'
  ])
});

function trendAt(rows,index) {
  const change=(rows[index].close/rows[index-lookback].close-1)*100;
  return change>config.trendThresholdPct?'rising':change< -config.trendThresholdPct?'falling':'flat';
}

function makeSamples(rows,sessions,institutions) {
  const samples=[];
  for(let index=lookback;index+sessions<rows.length;index++){
    const end=index+sessions;
    samples.push({
      index,end,date:rows[index].date,endDate:rows[end].date,
      trend:trendAt(rows,index),institution:institutions?.[index]??null,
      realized:(rows[end].close/rows[index].close-1)*100
    });
  }
  return samples;
}

function distribution(samples,matched) {
  const conditionalWeight=matched.length/(matched.length+shrinkage);
  const weighted=[
    ...samples.map(sample=>[sample.realized,(1-conditionalWeight)/samples.length]),
    ...matched.map(sample=>[sample.realized,conditionalWeight/matched.length])
  ].sort(([left],[right])=>left-right);
  let upProbability=0, downProbability=0, expectedReturnPct=0, cumulative=0, low=null, high=null;
  for(const [value,weight] of weighted){
    if(value>0)upProbability+=weight;
    else if(value<0)downProbability+=weight;
    expectedReturnPct+=value*weight;
    cumulative+=weight;
    if(low===null&&cumulative>=(1-rangeCoverage)/2)low=value;
    if(high===null&&cumulative>=(1+rangeCoverage)/2)high=value;
  }
  return {
    upProbability:Math.min(1,upProbability),downProbability:Math.min(1,downProbability),expectedReturnPct,
    low,high,matchedSamples:matched.length
  };
}

function fit(samples,key) {
  const baseline=distribution(samples,[]);
  const groups=new Map();
  for(const sample of samples){
    const group=key(sample);
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group).push(sample);
  }
  const predictions=new Map([...groups].map(([group,members])=>[group,distribution(samples,members)]));
  return {baseline,predict:sample=>predictions.get(key(sample))??baseline};
}

function nonOverlapping(samples) {
  let previousEnd=-1;
  return samples.filter(sample=>{
    if(sample.index<previousEnd)return false;
    previousEnd=sample.end;
    return true;
  });
}

function evaluate(samples,estimate,reference,sessions) {
  if(!samples.length)return {samples:0,signalSupported:false};
  const forecasts=samples.map(sample=>{
    const predicted=estimate(sample), baseline=reference(sample);
    return {
      date:sample.date,y:Number(sample.realized>0),
      p:predicted.upProbability,baseline:baseline.upProbability,
      error:Math.abs(sample.realized-predicted.expectedReturnPct),
      baselineError:Math.abs(sample.realized-baseline.expectedReturnPct),
      inside:Number(sample.realized>=predicted.low&&sample.realized<=predicted.high)
    };
  });
  const summary=metrics(forecasts);
  const brierDeltaInterval=forecasts.length>=minValidation
    ? pairedBlockInterval(forecasts,'p','baseline',Math.max(2,Math.ceil(lookback/sessions)),config.bootstrapReplicates,config.bootstrapSeed+sessions)
    : null;
  const maePct=mean(forecasts.map(row=>row.error));
  const baselineMaePct=mean(forecasts.map(row=>row.baselineError));
  return {
    samples:forecasts.length,start:samples[0].date,end:samples.at(-1).endDate,
    brier:summary.brier,baselineBrier:mean(forecasts.map(row=>(row.baseline-row.y)**2)),
    maePct,baselineMaePct,directionalAccuracy:summary.accuracy,
    rangeCoverage:mean(forecasts.map(row=>row.inside)),brierDeltaInterval,
    signalSupported:Boolean(brierDeltaInterval?.upper95<0&&maePct<baselineMaePct)
  };
}

function institutionFeatures(rows,listing) {
  if(listing?.complete!==true||!Array.isArray(listing.days)||!isoDay.test(listing.since??'')||!isoDay.test(listing.asOf??'')){
    return {eligibleSignals:0,values:null,reason:'公开榜单的历史完整性和披露时间覆盖待核实。'};
  }
  const dates=[...new Set(listing.days.map(item=>item.date).filter(date=>isoDay.test(date)&&date>=listing.since&&date<=listing.asOf))].sort();
  const values=rows.map((row,index)=>{
    const first=rows[index-5]?.date;
    if(!first||first<listing.since||row.date>listing.asOf)return null;
    // A date-only disclosure becomes visible at the next session.
    return dates.some(date=>date>=first&&date<row.date);
  });
  return {
    values,eligibleSignals:values.filter(value=>value===true).length,
    reason:'已核实的历史披露尚不足以比较增量效果。'
  };
}

function institutionCheck(train,test,sessions) {
  const eligibleTrain=train.filter(sample=>sample.institution!==null);
  const eligibleTest=nonOverlapping(test.filter(sample=>sample.institution!==null));
  const hasCoverage=(samples,min)=>{
    const active=samples.filter(sample=>sample.institution).length;
    return active>=min&&samples.length-active>=min;
  };
  if(eligibleTrain.length<minTraining||eligibleTest.length<minValidation||
    !hasCoverage(eligibleTrain,20)||!hasCoverage(eligibleTest,8))return null;
  const priceOnly=fit(eligibleTrain,sample=>sample.trend);
  const joined=fit(eligibleTrain,sample=>[sample.trend,sample.institution].join(':'));
  return evaluate(eligibleTest,joined.predict,priceOnly.predict,sessions);
}

function horizonForecast(rows,sessions,split,institutions) {
  const samples=makeSamples(rows,sessions,institutions);
  const train=samples.filter(sample=>sample.end<split);
  const test=samples.filter(sample=>sample.index>=split);
  const referencePrice=rows.at(-1)?.close;
  if(samples.length<minTraining||referencePrice==null){
    return {sessions,upProbability:null,downProbability:null,expectedReturnPct:null,expectedPrice:null,
      range:null,trainingSamples:samples.length,validation:null,conclusion:'insufficient'};
  }
  let validation=null, institutionValidation=null;
  if(train.length>=minTraining){
    const original=fit(train,sample=>sample.trend);
    validation={...evaluate(nonOverlapping(test),original.predict,()=>original.baseline,sessions),
      lastTrainingOutcome:train.at(-1).endDate};
    institutionValidation=institutionCheck(train,test,sessions);
  }
  // The display forecast is refit after the sealed test metrics are calculated.
  const finalModel=fit(samples,sample=>sample.trend);
  const prediction=finalModel.predict({trend:trendAt(rows,rows.length-1)});
  const {upProbability,downProbability,expectedReturnPct,low,high,matchedSamples}=prediction;
  let conclusion='neutral';
  if(validation?.signalSupported){
    if(upProbability>=config.directionalThreshold&&expectedReturnPct>0)conclusion='bullish';
    if(downProbability>=config.directionalThreshold&&expectedReturnPct<0)conclusion='bearish';
  }
  const priceAt=returnPct=>referencePrice*(1+returnPct/100);
  return {
    sessions,upProbability,downProbability,expectedReturnPct,expectedPrice:priceAt(expectedReturnPct),
    range:{low:priceAt(low),high:priceAt(high),coverage:rangeCoverage},
    trainingSamples:samples.length,matchedSamples,validation,institutionValidation,conclusion
  };
}

export function buildForecast(priceRows,{asOf,source=null,listingDays=null}={}) {
  const rows=[...new Map((priceRows??[])
    .filter(row=>isoDay.test(row?.date??'')&&row.date<=asOf&&Number.isFinite(row.close)&&row.close>0)
    .map(row=>[row.date,row])).values()]
    .sort((a,b)=>a.date.localeCompare(b.date)).slice(-maxHistory);
  const split=Math.floor(rows.length*config.trainShare);
  const inputFingerprint=createHash('sha256')
    .update(JSON.stringify([model.id,model.version,config,rows.map(({date,close})=>[date,close])]))
    .digest('hex');
  const sourceUrl=typeof source==='string'?source:source?.url;
  const institutions=institutionFeatures(rows,listingDays);
  const estimates=horizons.map(sessions=>horizonForecast(rows,sessions,split,institutions.values));
  const institutionEvaluated=estimates.some(item=>item.institutionValidation);
  return {
    model,inputFingerprint,asOf:rows.at(-1)?.date??null,basePrice:rows.at(-1)?.close??null,
    source:sourceUrl?{url:sourceUrl,historyUrls:source?.historyUrls??[]}:null,
    history:{start:rows[0]?.date??null,sessions:rows.length},
    status:estimates.some(item=>item.conclusion!=='insufficient')?'ready':'insufficient',
    institutions:{status:institutionEvaluated?'evaluated':'context_only',eligibleSignals:institutions.eligibleSignals,
      reason:institutionEvaluated?'在同一历史区间与纯行情模型比较。实时数值使用纯行情模型。':institutions.reason},
    horizons:estimates
  };
}
