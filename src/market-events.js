export function reviewedEvents(history, symbol) {
  const unique = new Map();
  for (const { report } of history.slice().reverse()) {
    if (report?.stock?.symbol !== symbol) continue;
    for (const entry of report.entries ?? []) {
      if (!entry.quote || !entry.quoteUrl || !['利多', '利空'].includes(entry.impact) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || unique.has(entry.url)) continue;
      const side = entry.impact === '利多' ? '多方' : '空方';
      const monthly = report.movements?.find(item => item.side === side && item.horizon === '近20日' &&
        item.refs.includes(entry.id));
      unique.set(entry.url, { ...entry, side, researchDate: report.date, hypothesis: monthly?.text ?? null });
    }
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date) || a.title.localeCompare(b.title,'zh-CN'));
}

export function closedThrough(now = new Date()) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(now).map(part=>[part.type,part.value]));
  const date=values.year+'-'+values.month+'-'+values.day;
  return +values.hour>=15 ? date : new Date(Date.parse(date)-86400_000).toISOString().slice(0,10);
}

export function followThrough(date, calendar, stockRows, industryRows, cutoff) {
  const sessions=calendar.map(row=>row.date);
  const firstAfter=sessions.findIndex(day=>day>date);
  const first=firstAfter===-1?sessions.length:firstAfter;
  const baseline=first>0&&date<=cutoff?sessions[first-1]:null;
  const completed=baseline?sessions.slice(first,first+20).filter(day=>day<=cutoff):[];
  const closeByDate = rows => new Map(rows.map(row=>[row.date,row.close]));
  const individual=closeByDate(stockRows), industry=closeByDate(industryRows);
  function calculate(values, end) {
    const baseClose=values.get(baseline), close=values.get(end);
    return Number.isFinite(baseClose) && baseClose>0 && Number.isFinite(close) && close>0
      ? {baselineClose:baseClose,close,returnPct:(close/baseClose-1)*100} : null;
  }
  return {
    baseline, start:completed[0]??null,end:completed.at(-1)??null,completed:completed.length,
    results:[1,5,20].map(days=>{
      const end=completed[days-1]??null;
      return {days,date:end,stock:end?calculate(individual,end):null,industry:end?calculate(industry,end):null};
    })
  };
}
