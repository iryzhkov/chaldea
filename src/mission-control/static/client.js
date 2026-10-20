// Age the retained source snapshot even when the browser transport is quiet or lost.
export function projectClientSnapshot(snapshot, now, connected) {
  if (!snapshot) return null;
  const lost = !connected || !Number.isFinite(snapshot.now) || now - snapshot.now > 30_000;
  return { ...snapshot,
    source: { ...snapshot.source, observedAt: !snapshot.sampled && snapshot.source.state === "live" ? snapshot.now : snapshot.source.observedAt,
      state: lost && snapshot.source.state === "live" ? "disconnected" : snapshot.source.state },
    ...(snapshot.hostSummary ? { hostSummary: snapshot.hostSummary.map(h => ({ ...h,
      freshness: lost && h.freshness === "live" ? "disconnected" : h.freshness })) } : {}),
    agents: snapshot.agents.map(a => ({ ...a,
      detailObservedAt: !snapshot.sampled && a.activityFreshness === "live" ? snapshot.now : a.detailObservedAt,
      activityFreshness: lost && a.activityFreshness === "live" ? "disconnected" : a.activityFreshness,
    })),
  };
}
// Browser receives only the allowlisted MissionModel snapshot. No credentials or T3 access.
if (typeof window !== "undefined") {
window.DATA = { now:new Date(), tz:"UTC", tzOffsetMin:0, demo:false, threads:[], agentPool:[], wallTargets:{}, hosts:[], decisions:[], incidents:[], shipped:[], events:[], prs:[], accounts:[], sources:[], tokens:{providers:[],hourly:[]} };
document.getElementById("board").style.visibility = "hidden";
const script = document.createElement("script"); script.src = "/core.js"; document.body.append(script);
script.onload = () => {
  const { R, UI } = window.MC, { panel, heroStat, gauge, st, budget } = UI;
  document.getElementById("view").setAttribute("tabindex","0");
  document.getElementById("view").setAttribute("aria-label","Mission Control page");
  const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const missing = text => '<div class="muted">' + esc(text) + '</div>';
  let snapshot = null, receivedSnapshot = null, transportConnected = false, mode = window.MC.modeFromURL();
  const age = at => at == null ? null : Math.max(0,Math.floor((Date.now()-at)/1000));
  const sourcePanel = (area,title,body,kind="t3shell") => panel(area,title,body,kind,age(snapshot?.source.observedAt),snapshot?.source.state === "live" ? "live" : snapshot?.source.state === "nosource" ? "nosource" : age(snapshot?.source.observedAt)>(snapshot?.sampled?600:300) ? "lost" : "stale");
  const unavailable = (area,title) => panel(area,title,missing("Unavailable · no authorized source"),"host",null,"nosource");
  const accountBody = a => {
    const used = a.used == null ? missing(a.state === "unsupported" ? "Quota not applicable" : "Usage unknown") : gauge(a.used,"pri",undefined,a.used + "%","used · " + (a.duration == null ? "window duration unknown" : a.duration + " min window"));
    const reset = a.resetsAt == null ? "Reset unknown" : "Reset in " + Math.max(0,Math.ceil((a.resetsAt-Date.now())/60000)) + " min";
    return '<div class="acard">' + used + '<div class="facts"><div>' + esc(a.state) + '</div><div>' + esc(reset) + '</div><div>' + (a.unlimited === true ? "Credit balance unlimited" : a.credits == null ? "Credit balance unknown" : "Credits " + esc(a.credits) + " remaining") + '</div><div>' + (a.manualResets == null ? "Manual resets unknown" : a.manualResets + " manual resets available") + '</div><div class="t1 muted">Credits ' + esc(a.creditState) + ' · resets ' + esc(a.resetState) + '</div><div class="t1 muted">Cached quota · observed ' + (age(a.observedAt) ?? "unknown") + 's ago</div></div><div class="more">Window history unavailable</div></div>';
  };
  const agoText = at => age(at) == null ? "unknown" : age(at)<60 ? age(at)+"s ago" : age(at)<3600 ? Math.floor(age(at)/60)+"m ago" : Math.floor(age(at)/3600)+"h ago";
  const timestamp = at => Number.isFinite(at) ? '<time datetime="'+new Date(at).toISOString()+'">'+esc(new Date(at).toISOString().replace("T"," ").slice(0,19)+" UTC")+'</time>' : "unknown";
  const quotaHosts = () => snapshot?.quota?.hosts;
  const quotaFresh = (state,at) => state==="error" ? "error" : at==null ? "nosource" : age(at)>5400 ? "lost" : age(at)>1800 ? "stale" : "cached";
  const quotaRows = h => h.accounts.slice(0,4).map(a=>{
    const used=Number.isFinite(a.used)?a.used:null;
    return '<div class="quota-account"><strong>'+esc(a.label)+'</strong><span class="source-meta">'+esc(a.state)+' · observed '+esc(agoText(a.observedAt))+'</span>'
      +(used==null?missing(a.state==="unsupported"?"Quota not applicable":"Usage unknown"):resourceMeter(a.label+" used",used,used+"% used · "+Number((100-used).toFixed(2))+"% headroom"))
      +'<div class="source-meta">'+(a.duration==null?"":esc(a.duration)+" min window · ")+(a.resetsAt==null?"Reset unknown":"Reset "+timestamp(a.resetsAt))+'</div>'
      +((a.unlimited===true||a.credits!=null||a.manualResets!=null)?'<div class="source-meta">'+[a.unlimited===true?"Credits unlimited":a.credits!=null?"Credits remaining "+esc(a.credits):"",a.manualResets!=null?esc(a.manualResets)+" manual resets available":""].filter(Boolean).join(" · ")+'</div>':"")+'</div>';
  }).join("") || missing(h.state==="byte-budget"?"Quota withheld · host byte budget":h.state==="error"?"Quota source error · no quota data":"No quota data observed");
  const quotaHostCard = (h,area="acct") => panel(area,"Observed by "+h.host,
    '<div class="source-meta">'+esc(h.state)+' · quota source '+esc(agoText(h.observedAt))+'</div>'+quotaRows(h)+(h.omitted?'<div class="more">'+esc(h.omitted)+' account rows omitted by source</div>':""),
    "quota",age(h.observedAt),quotaFresh(h.state,h.observedAt),"quota-host");
  const quotas = (area="acct") => Array.isArray(quotaHosts()) ? '<div class="host-coverage">Per-host quota observations · the same account may appear on multiple hosts</div>'+(quotaHosts().map(h=>quotaHostCard(h,area)).join("")||missing("No host quota observations"))
    : snapshot?.quota.accounts.length ? budget(snapshot.quota.accounts,6,a=>panel(area,a.label,accountBody(a),"quota",age(a.observedAt),["unknown","error"].includes(a.state) ? "nosource" : a.state === "unsupported" ? "unsupported" : ["stale","lost"].includes(a.state) ? a.state : undefined),"accounts") : unavailable(area,"Quota · " + (snapshot?.quota.state || "unknown"));
  const eventRows = () => (snapshot?.events?.rows||[]).filter(r=>["chaldea-fleet-pull","chaldea-retention"].includes(r.job)&&["changed","failed"].includes(r.status)).slice().sort((a,b)=>b.occurredAt-a.occurredAt);
  const eventBody = (limit=64) => {
    const rows=eventRows();
    return (rows.length?budget(rows,limit,r=>'<div class="item maintenance-event"><div class="l1">'+st(r.status==="failed"?"fail":"ok",r.status)+' <strong>'+esc(r.job==="chaldea-fleet-pull"?"Fleet pull":"Retention")+'</strong> · '+esc(r.host)+'</div><div class="source-meta">Occurred '+timestamp(r.occurredAt)+' · received '+timestamp(r.receivedAt)+'</div></div>',"observed runs"):missing("No changed or failed timer runs observed in 48h"));
  };
  const eventCoverage = () => {
    const e=snapshot?.events;
    return '<div class="source-meta">Fleet pull and retention timers · 48h window · '+esc(e?.state||"unknown")+' · last checked '+esc(agoText(e?.checkedAt))+(e?.truncated?' · truncated; more runs may be omitted':"")+'</div>';
  };
  const eventFresh = () => snapshot?.events?.state==="error"?"error":snapshot?.events?.checkedAt==null?"nosource":age(snapshot.events.checkedAt)>900?"stale":"cached";
  R.overview = () => {
    const s=snapshot,agents=window.MC.orderThreads(s?.agents||[]),hosts=hostList(),observed=hosts.filter(h=>h.observedAt!=null).length;
    const stats=[[s?agents.filter(a=>["working","thinking"].includes(a.state)).length:"—","working"],[s?agents.filter(a=>a.state.startsWith("waiting")).length:"—","waiting"],[hosts.length?observed+" / "+hosts.length:"—","hosts observed"]];
    if(s?.tokens.rate!=null)stats.push([s.tokens.rate.toFixed(1),s.tokens.coverage==="partial"?"rate lower bound":"output tok/s"]);
    const kpi='<div class="stats hero-row">'+stats.map(x=>heroStat(...x)).join("")+'</div><div class="source-meta">Needs Igor, incidents, exec slots, queued jobs, shipped and daily totals: not connected</div>';
    const rowLimit=innerWidth<=650?2:4;
    const rows=agents.slice(0,rowLimit).map(a=>'<div class="item overview-thread"><div class="l1"><span class="t two">'+esc(a.title)+'</span>'+UI.providerMark(a)+'</div><div class="activity-preview">'+esc(activityItems(a)[0]?.text||"Previews unavailable")+'</div><div class="source-meta">'+st(a.state,a.state)+' · '+esc(a.model)+' · '+esc(a.host)+'</div></div>').join("");
    const q=Array.isArray(quotaHosts())?(quotaHosts().map(h=>{
      const accounts=h.accounts||[], known=accounts.filter(a=>Number.isFinite(a.used)), values=known.map(a=>a.used);
      const usage=known.length?' · '+Math.min(...values)+'–'+Math.max(...values)+'% used across '+known.length+' known windows':' · usage unknown';
      return '<div class="quota-glance"><strong>'+esc(h.host)+'</strong><div class="source-meta">'+esc(h.state)+' · '+accounts.length+' account observations'+esc(usage)+'</div><div class="source-meta">Source '+esc(agoText(h.observedAt))+(h.omitted?' · '+esc(h.omitted)+' omitted by source':'')+'</div></div>';
    }).join("")||missing("No host quota observations")):s?.quota.accounts.length?budget(s.quota.accounts,2,a=>'<div class="item">'+esc(a.label)+' · '+esc(a.state)+' · '+(a.used==null?"usage unknown":a.used+"% used")+'</div>',"accounts"):missing("No cached quota");

    return sourcePanel("kpi",(s?.sampled?"Enrolled sources · sampled":"Local observations")+" · "+(s?.source.state||"connecting"),kpi)
      +unavailable("inbox","Decision inbox")
      +sourcePanel("threads","Threads · "+threadCoverage(Math.min(rowLimit,agents.length)),(rows||missing("No observed threads"))+'<a class="detail-link" href="?mode=agents">All threads · active first, including completed</a>')
      +panel("hosts","Hosts · CPU / RAM",hosts.map(h=>compactHost(h)).join("")||missing("No host observations"),"host",null,"cached","overview-resources")
      +panel("quota","Quota by observing host",q+'<div class="source-meta">Same account may repeat across hosts</div><a class="detail-link" href="?mode=quota">All quota observations / details</a>',"quota",null,"cached")
      +panel("events","Latest maintenance changes / failures",eventCoverage()+eventBody(2),"akasha",age(s?.events?.checkedAt),eventFresh());
  };
  R.tokens = () => {
    // Cards and host summaries overlap. Count only unique transported cards.
    const rows=[...new Map((snapshot?.agents||[]).map(a=>[a.id,a])).values()].slice(0,48);
    const count=n=>Number.isSafeInteger(n)&&n>=0;
    const usages=rows.map(a=>a.details && (!a.detailCoverage||a.detailCoverage==="reported") && a.details.fieldCoverage!=="identity-only"?a.details.usage:null);
    const usable=usages.filter(u=>u&&u.turns>0&&u.coverage!=="not-reported"&&["input","output","total"].some(k=>count(u[k])));
    const times=usable.map(u=>u.observedAt).filter(count),at=times.length===usable.length&&times.length?Math.min(...times):null;
    const fresh=at==null?"nosource":snapshot?.source?.state==="live"&&rows.every(a=>a.activityFreshness==="live")?"live":"stale";
    const metric=(key,label)=>{
      const contributors=usable.filter(u=>count(u[key])),n=contributors.reduce((sum,u)=>sum+u[key],0);
      return heroStat(contributors.length&&count(n)?n:"—",label,contributors.length+" / "+rows.length+" threads report this field");
    };
    const turns=usable.reduce((sum,u)=>sum+u.turns,0),missingThreads=rows.length-usable.length;
    const partial=missingThreads>0||snapshot?.truncated||snapshot?.total!==rows.length||usable.some(u=>u.coverage!=="observed");
    const scope=(partial?"Partial coverage":"Observed coverage")+" · "+turns+" usable turns / "+usable.length+" usable threads · "+missingThreads+" shown threads missing usable usage"
      +" · shown "+rows.length+" / "+(snapshot?.total??"unknown")+" threads · source "+(snapshot?.source?.state||"unknown")
      +" · oldest usage "+(at==null?"unknown":age(at)+"s ago");
    return panel("thero","Retained OBSERVED main-agent contributions",'<div class="stats">'+metric("input","input")+metric("output","output")+metric("total","input + output")+'</div>',"t3thread",at==null?null:age(at),fresh)
      +panel("models","Subsets and coverage",'<div class="stats">'+metric("cacheRead","cache read · input subset")+metric("cacheWrite","cache write · input subset")+metric("reasoning","reasoning · output subset")+'</div>'
        +missing(scope)+missing("Cache reads and writes are included in input; reasoning is included in output.")
        +missing("Retention: up to eight turns per thread, at most 48 shown threads. Missing fields remain unknown. These are retained observations, not lifetime, daily or process totals.")
        +missing("Generation rate, p95, daily totals and model history unavailable."),"t3thread",at==null?null:age(at),fresh);
  };
  R.quota=()=>quotas();
  R.events=()=>panel("ecount","Maintenance observations",eventCoverage(),"akasha",age(snapshot?.events?.checkedAt),eventFresh())
    +panel("timeline","Changed / failed timer runs",eventBody(),"akasha",age(snapshot?.events?.checkedAt),eventFresh());
  const dailyHealthBody = () => {
    const d=snapshot?.ops?.dailyHealth,r=d?.report;
    return '<div class="source-meta">Daily health · '+esc(d?.state||"unknown")+' · last checked '+esc(agoText(d?.checkedAt))+'</div>'
      +(r?'<div class="item"><strong>'+esc(r.status)+'</strong><div class="source-meta">Report occurred '+timestamp(r.occurredAt)+' · received '+timestamp(r.receivedAt)+'</div></div>'+r.checks.map(c=>'<div class="check-row"><span>'+esc(c.name)+'</span><strong>'+esc(c.status)+'</strong></div>').join("")+(r.omitted?'<div class="more">'+esc(r.omitted)+' checks omitted</div>':""):missing("No report in 48h"));
  };
  R.ops=()=>panel("health","Daily health",dailyHealthBody(),"akasha",age(snapshot?.ops?.dailyHealth?.checkedAt),snapshot?.ops?.dailyHealth?.state==="error"?"error":snapshot?.ops?.dailyHealth?.checkedAt==null?"nosource":age(snapshot.ops.dailyHealth.checkedAt)>900?"stale":"cached")
    +panel("tasks","Maintenance changes / failures",eventCoverage()+eventBody(),"akasha",age(snapshot?.events?.checkedAt),eventFresh())
    +panel("resources","Host sources / resource pressure",hostList().map(h=>compactHost(h)).join("")||missing("No host observations"),"host",null,"cached");
  R.lab=()=>{
    const agents=snapshot?.agents||[],hosts=[...new Set(agents.map(a=>a.host))];
    const distributions=hosts.map(host=>{
      const rows=agents.filter(a=>a.host===host),groups=new Map();
      for(const a of rows){
        const reported=a.details&&(!a.detailCoverage||a.detailCoverage==="reported")&&a.details.fieldCoverage!=="identity-only";
        const p=reported?a.details.provider:null,driver=p?.driver||"Provider unknown",instance=p?.instanceId||"",model=a.model||"Model unknown",effort=reported&&a.details.effort?.source==="reported"?a.details.effort.value:null;
        const key=JSON.stringify([driver,instance,model,effort,a.state]);
        const group=groups.get(key)||{a,driver,instance,model,effort,state:a.state,count:0};group.count++;groups.set(key,group);
      }
      return panel("routing",host+" · "+rows.length+" observed threads",[...groups.values()].map(g=>'<div class="distribution-row"><div class="distribution-provider">'+UI.providerMark(g.a)+'<strong>'+esc(g.driver)+(g.instance?" · "+esc(g.instance):"")+'</strong><span class="num">'+g.count+'</span></div><div>'+esc(g.model)+'</div><div class="source-meta">'+esc(g.state)+' · reported effort '+esc(g.effort||"unknown")+'</div></div>').join(""),"t3thread",age(hostList().find(h=>h.host===host)?.observedAt),"cached","lab-host");
    }).join("");
    return panel("summary","Observed thread set",missing(threadCoverage())+missing("Current provider, model, reported effort and activity by host. AA quality scores disabled / unqualified. Exec slots unknown: no read-only capacity source."),"t3thread",age(snapshot?.source.observedAt),snapshot?.source.state==="live"?"live":"nosource")
      +(distributions||panel("routing","Thread observations",missing("No observed threads"),"t3thread",null,"nosource"));
  };
  const hostList = () => snapshot?.hostSummary || [];
  const hostFreshness = h => h.observedAt == null ? "nosource" : h.freshness === "live" && snapshot?.sampled && age(h.observedAt)>90 ? "stale" : h.freshness;
  const resourceMeter = (label,pct,value) => UI.stacked(esc(label),pct,esc(value),pct == null ? "nosrc" : pct>=95?"fail":pct>=80?"warn":"")
    .replace('<div class="meter', '<div role="meter" aria-label="'+esc(label+" "+value)+'" aria-valuemin="0" aria-valuemax="100"'+(pct==null?' aria-valuetext="Unavailable"':' aria-valuenow="'+pct.toFixed(2)+'"')+' class="meter');
  const resources = h => {
    const r=h.resources?.sample;
    if(!r)return resourceMeter("CPU",null,"Not reported")+resourceMeter("RAM",null,"Not reported")+missing(h.resources?.state==="byte-budget"?"Resources withheld · host byte budget":"Resource sample unavailable");
    const used=Math.max(0,r.totalMemoryBytes-r.availableMemoryBytes),gib=n=>(n/1073741824).toFixed(1);
    const cpu=Number.isFinite(r.cpuUtilization)?r.cpuUtilization*100:null,ram=r.totalMemoryBytes>0?used/r.totalMemoryBytes*100:null;
    const sampleAge=age(r.sampledAt),fresh=hostFreshness(h),last=fresh!=="live"||sampleAge==null||sampleAge>90;
    return resourceMeter("CPU",cpu,(cpu==null?"Not reported":cpu.toFixed(1)+"%")+" · "+r.cpuCount+" cores")
      +resourceMeter("RAM",ram,gib(used)+" / "+gib(r.totalMemoryBytes)+" GiB · "+(ram==null?"unknown":ram.toFixed(1)+"%")+" used")
      +'<div class="resource-note">'+esc(gib(r.availableMemoryBytes)+" GiB available · sample "+(sampleAge??"unknown")+"s ago"+(last?" · last known / "+fresh:" · observed"))+'</div>';
  };
  const hostCard = (h,expanded=false) => {
    const sourceAge=age(h.observedAt),fresh=hostFreshness(h);
    const status=h.observedAt==null?"NOT OBSERVED · thread count unknown":(fresh==="live"?"observed":fresh)+" · source "+sourceAge+"s ago · shown "+h.shown+" / "+(h.total??"unknown")+(h.truncated?" · truncated; fleet total unknown":"");
    const states=Object.entries(h.states||{}).map(([state,count])=>esc(state)+": "+esc(count)).join(" · ");
    const models=(h.models||[]).map(m=>esc(m.model)+": "+esc(m.count)).join(" · ");
    return panel("host",h.host,'<div class="host-status">'+esc(status)+'</div>'+resources(h)+(expanded?'<div class="host-work">'+states+'</div><div class="muted">'+models+'</div>':""),"host",sourceAge,fresh,"host-card");
  };
  const compactHost = h => {
    const r=h.resources?.sample,fresh=hostFreshness(h),gib=n=>(n/1073741824).toFixed(1),used=r?Math.max(0,r.totalMemoryBytes-r.availableMemoryBytes):null;
    const cpu=r&&Number.isFinite(r.cpuUtilization)?r.cpuUtilization*100:null,ram=r&&r.totalMemoryBytes>0?used/r.totalMemoryBytes*100:null;
    return '<div class="host-glance"><div class="host-glance-head"><strong>'+esc(h.host)+'</strong><span>'+esc(fresh)+' · source '+esc(agoText(h.observedAt))+'</span></div>'
      +resourceMeter(h.host+" CPU",cpu,"CPU "+(cpu==null?"not reported":cpu.toFixed(1)+"% · "+r.cpuCount+" cores"))
      +resourceMeter(h.host+" RAM",ram,"RAM "+(r?gib(used)+" / "+gib(r.totalMemoryBytes)+" GiB":"not reported"))
      +'<div class="source-meta">'+(r?'Resource sample '+esc(agoText(r.sampledAt))+(age(r.sampledAt)>90||fresh!=="live"?' · last known / '+esc(fresh):""):h.resources?.state==="byte-budget"?"Resources withheld · host byte budget":"Resource sample unavailable")+'</div></div>';
  };
  R.fleet=()=>'<div class="host-coverage">Resources · observed CPU and RAM</div>'+hostList().map(h=>hostCard(h,true)).join("");
  const usage = u => !u||u.coverage==="not-reported"?"Usage not reported":("Input "+(u.input??"?")+" · output "+(u.output??"?")+" · observed total "+(u.total??"?")+" · cache read "+(u.cacheRead??"?")+" / write "+(u.cacheWrite??"?")+" · reasoning "+(u.reasoning??"?")+" (subsets) · "+u.coverage+" / "+u.turns+" observed main-agent turns · usage "+age(u.observedAt)+"s ago · generation rate not reported");
  const previewText = p => p && ["reported","truncated","redacted"].includes(p.state) && typeof p.text==="string" ? p.text : null;
  const previewLabel = p => p.state==="reported"?"":" · "+p.state;
  const detailBody = a => {
    const d=a.details;if(!d||a.detailCoverage&&a.detailCoverage!=="reported")return missing(a.detailCoverage==="byte-budget"?"Detail withheld · host byte budget":"Detail not reported · older producer or host byte budget");
    const p=d.assistant,effort=d.effort.value?d.effort.value+" ("+d.effort.source+")":"not reported";
    const commands=d.commands,w=d.work,c=w.children;
    const identity=d.identity,id=identity?.appThreadId;
    const identityBody=id?.text?'<div class="thread-id">App thread <code title="'+esc(id.text)+'">'+esc(id.text.length>26?id.text.slice(0,26)+"…":id.text)+'</code> · '+esc(id.state)+(id.state==="reported"?'<button type="button" data-copy-thread="'+esc(id.text)+'">Copy ID</button>':' · full ID unavailable')+'</div>':missing("App thread ID "+(id?.state??"not reported"));
    if(d.fieldCoverage==="identity-only")return identityBody+missing("Other detail withheld · host byte budget");
    const countWork=c=>c?c.active+" active / "+c.queued+" queued / "+c.completed+" completed observed":"not reported";
    return '<div class="agent-detail">'+identityBody+'<div class="facts"><div>Effort '+esc(effort)+'</div><div>Assistant: '+esc(previewText(p)??p.state)+' · '+esc(p.state)+'</div><div>'+esc(commandLabel(a))+': '+(commands.length?commands.map(p=>esc(previewText(p)??p.state)+" ("+esc(p.state)+")").join(" · "):"not reported / no active observation")+(d.commandsOmitted?" · "+d.commandsOmitted+" omitted":"")+'</div><div>'+esc(usage(d.usage))+'</div><div>Context '+(d.context?d.context.used+" / "+(d.context.max??"?"):"not reported")+'</div><div>Children '+(c?c.active+" active / "+c.queued+" queued / "+c.completed+" completed observed":"not reported")+' · delegates '+esc(countWork(w.delegates))+' · native subagents '+esc(countWork(w.subagents))+' · monitors '+(w.monitors??"not reported")+' · background '+(w.background??"not reported")+' · durable waits unavailable · '+esc(w.coverage)+'</div></div></div>';
  };
  // Counts describe the received observation set, never an inferred fleet total.
  const threadCoverage = (visible=snapshot?.agents.length??0) => {
    const received=snapshot?.agents.length??0;
    return "showing "+visible+" of "+received+" observed threads"+(snapshot?.truncated?" · capture truncated; upstream reports "+(snapshot.total??"unknown")+"; fleet total unknown":"") ;
  };
  const coverage = () => threadCoverage()+" · 48-row bound";
  UI.threadCoverage=(visible,received,start)=>threadCoverage(visible)+(received>visible?" · rows "+(start+1)+"–"+(start+visible)+" of received set":"");
  const commandIsCurrent = a => ["working","thinking"].includes(a.state) && a.activityFreshness==="live" && age(a.detailObservedAt)!=null && age(a.detailObservedAt)<=60;
  const commandLabel = a => commandIsCurrent(a)?"Active command observed":"Last observed command · outcome unknown";
  const activityItems = a => {
    const d=a.details;
    if(!d || a.detailCoverage && a.detailCoverage!=="reported" || d.fieldCoverage==="identity-only")return [];
    const recent=Array.isArray(d.recent)?d.recent.filter(p=>["assistant","command"].includes(p.kind)&&previewText(p.preview)).slice(0,3):[];
    if(recent.length)return recent.map(p=>({
      kind:(p.kind==="assistant"?"Assistant":p.status==="running"?(commandIsCurrent(a)?"Active command observed":"Last observed command · outcome unknown"):"Command · "+(["completed","failed","cancelled"].includes(p.status)?p.status:"outcome unknown"))+(!Number.isFinite(p.at)?"":" · observed "+age(p.at)+"s ago")+previewLabel(p.preview),
      text:p.preview.text, stamp:[p.kind,p.preview.text,p.preview.state,p.at,p.status]
    }));
    const items=[];
    if(previewText(d.assistant))items.push({kind:"Assistant"+previewLabel(d.assistant),text:d.assistant.text,stamp:["assistant",d.assistant.text,d.assistant.state]});
    for(const p of d.commands||[])if(previewText(p))items.push({kind:commandLabel(a)+previewLabel(p),text:p.text,stamp:["command",p.text,p.state]});
    return items.slice(0,3);
  };
  UI.providerMark = a => {
    const p=a.details?.provider,driver=p?.driver,known=["codex","claudeAgent"].includes(driver);
    const name=driver==="codex"?"OpenAI Codex":driver==="claudeAgent"?"Claude":driver||"Provider unknown";
    const label=name+(p?.instanceId?" · "+p.instanceId:"");
    const art=driver==="codex"?'<svg viewBox="0 0 24 24" aria-hidden="true">'+Array.from({length:6},(_,i)=>'<rect x="8" y="2" width="8" height="13" rx="4" fill="none" stroke="currentColor" stroke-width="1.8" transform="rotate('+i*60+' 12 12)"/>').join("")+'</svg>':driver==="claudeAgent"?'<svg viewBox="0 0 24 24" aria-hidden="true">'+Array.from({length:12},(_,i)=>'<path d="M12 3 L12 9" stroke="currentColor" stroke-width="2" transform="rotate('+i*30+' 12 12)"/>').join("")+'</svg>':'?';
    return '<span class="provider-mark'+(known?' branded':'')+'" role="img" aria-label="'+esc(label)+'" title="'+esc(label)+'">'+art+'</span>';
  };
  const compactTokens = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(n>=1e4?0:1)+'K' : String(n);
  UI.agentMetrics = a => {
    const d=a.details, reported=d && (!a.detailCoverage || a.detailCoverage==="reported") && d.fieldCoverage!=="identity-only";
    const effort=reported && ["reported","configured"].includes(d.effort?.source) && d.effort.value ? d.effort.value+" "+d.effort.source : "effort unknown", u=reported?d.usage:null;
    const tokens=u && u.coverage!=="not-reported" && Number.isFinite(u.total)?u.total:null;
    return (a.model && a.model!=="unknown"?'<span class="card-model" title="'+esc(a.model)+'">'+esc(a.model)+'</span>':'')
      +'<span class="card-effort" title="Effort provenance">'+esc(effort)+'</span>'
      +(tokens==null?'':'<span class="card-usage" title="'+esc(usage(u))+'">'+esc(compactTokens(tokens))+' tok</span>');
  };
  UI.agentChangeStamp = a => {
    const previews=activityItems(a).map(p=>p.stamp);
    return JSON.stringify([a.observedAt,a.activityObservedAt,a.state,a.title,previews]);
  };
  UI.agentActivity = a => {
    const items=activityItems(a);
    return '<div class="recent-activity">'+(items.length?items.map(p=>'<div class="activity-item"><span class="activity-kind" title="'+esc(p.kind)+'">'+esc(p.kind.replace("Active command observed","Command · running").replace("Last observed command · outcome unknown","Command · outcome unknown").replace(" · observed "," · "))+'</span><span class="activity-preview">'+esc(p.text)+'</span></div>').join(""):'<div class="activity-empty">Previews unavailable</div>')+'</div>';
  };
  R["agent-summary"]=()=>'<div class="host-coverage">'+esc("Host overview · "+coverage())+'</div>'+hostList().map(h=>hostCard(h,true)).join("");
  const originalAgents=R.agents;
  R.agents=()=>originalAgents().replace('data-console="FLIGHT">Agents','data-console="FLIGHT">Live threads');

  // A native modal lives outside the grid. Its close control survives all data refreshes.
  const drawer=document.createElement("dialog");
  drawer.setAttribute("class","thread-drawer");drawer.setAttribute("aria-label","Thread details");
  drawer.innerHTML='<button type="button" data-close-details>Close details</button><div class="drawer-content"></div>';
  document.body.append(drawer);
  let selectedThread=null,drawerHTML="";
  UI.detailsOpen=()=>drawer.open===true;
  const updateDrawer=()=>{
    if(!selectedThread)return;
    const a=snapshot?.agents.find(a=>a.id===selectedThread);
    const activityAge=age(a?.detailObservedAt),host=snapshot?.hostSummary?.find(h=>h.host===a?.host);
    const freshness=a?'<p class="detail-freshness">'+esc("Activity "+(a.activityFreshness==="live"&&(activityAge==null||activityAge>60)?"stale":a.activityFreshness??"unknown")+" · "+(activityAge==null?"age unknown":activityAge+"s ago")+"; "+a.host+" source "+(host?hostFreshness(host):a.freshness??"unknown")+" · "+(age(host?.observedAt??a.observedAt)??"unknown")+"s ago · detail coverage "+(a.detailCoverage??"not reported"))+'</p>':'';
    const html=a?'<h2>'+esc(a.title)+'</h2><div>'+st(a.state,a.state)+' · '+esc(a.host)+' · '+esc(a.model)+'</div><p>'+UI.providerMark(a)+'</p>'+freshness+detailBody(a)+UI.agentActivity(a)+'<p>Previews are observations, not a transcript. Only explicitly reported command outcomes are shown. Absence does not imply completion.</p>':missing("Thread is no longer in the observed set");
    if(html!==drawerHTML){
      const content=drawer.querySelector(".drawer-content");
      if(content.contains(document.activeElement))drawer.querySelector("[data-close-details]").focus();
      content.innerHTML=html;drawerHTML=html;
    }
  };
  drawer.addEventListener("close",()=>{
    const opener=document.getElementById("view").querySelector('[data-thread-details="'+encodeURIComponent(selectedThread)+'"]');
    selectedThread=null;(opener||document.getElementById("view").querySelector("[data-thread-grid]"))?.focus();
  });
  document.addEventListener("click",e=>{
    const close=e.target.closest?.("[data-close-details]");
    if(close){drawer.close();return;}
    const open=e.target.closest?.("[data-thread-details]");
    if(open){selectedThread=decodeURIComponent(open.dataset.threadDetails);updateDrawer();drawer.showModal();drawer.querySelector("[data-close-details]").focus();return;}
    const button=e.target.closest?.("[data-copy-thread]");if(button)navigator.clipboard?.writeText(button.dataset.copyThread).catch(()=>{});
  });
  document.addEventListener("mc:mode",e=>{mode=e.detail;});
  function render() {
    snapshot = projectClientSnapshot(receivedSnapshot, Date.now(), transportConnected);
    const sourceLabel = snapshot?.sampled ? "Akasha status snapshots" : snapshot ? "Local T3 snapshots" : "No observed source";
    window.MC.SOURCES.t3shell.label = sourceLabel;
    window.MC.SOURCES.t3thread.label = sourceLabel;
    if(snapshot) {
      DATA.demo=snapshot.demo; DATA.agentSourceAge=age(snapshot.source.observedAt);
      DATA.threads=snapshot.agents.map(a=>({ ...a, activityObservedAt:receivedSnapshot.agents.find(raw=>raw.id===a.id)?.detailObservedAt, state:a.state, sourceFreshness:snapshot.source.state!=="live"?snapshot.source.state:hostFreshness(snapshot.hostSummary?.find(h=>h.host===a.host)||a), observed:age(a.detailObservedAt), sourceObserved:age(snapshot.hostSummary?.find(h=>h.host===a.host)?.observedAt ?? a.observedAt), age:null, run:age(a.startedAt), effort:a.details?.effort?.value?a.details.effort.value+" ("+a.details.effort.source+")":"not reported", steps:a.steps.map(tool=>({tool})) }));
      DATA.agentPool=DATA.threads; DATA.sources=[];
    }
    window.MC.show(window.MC.MODES.includes(mode)?mode:"overview");
    updateDrawer();
    document.getElementById("globalfresh").textContent=(snapshot?.sampled?"Sampled sources ":"PC ") + (snapshot?.source.state || "connecting") + " · quota " + (snapshot?.quota.state || "unknown");
    document.getElementById("urgent").textContent=snapshot?.demo?"DEMO DATA":"READ ONLY";
    document.getElementById("clock").textContent=new Date().toISOString().slice(11,16)+" UTC";
    document.getElementById("board").style.visibility="visible";
  }
  render();
  const events=new EventSource("/api/events");
  events.addEventListener("snapshot",e=>{ receivedSnapshot=JSON.parse(e.data); transportConnected=true; render(); });
  events.onerror=()=>{ transportConnected=false; render(); };
  setInterval(render,5000);
  addEventListener("pagehide",()=>events.close(),{once:true});
};
}
