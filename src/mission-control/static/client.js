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
  const quotas = (area="acct") => snapshot?.quota.accounts.length ? budget(snapshot.quota.accounts,6,a=>panel(area,a.label,accountBody(a),"quota",age(a.observedAt),["unknown","error"].includes(a.state) ? "nosource" : a.state === "unsupported" ? "unsupported" : ["stale","lost"].includes(a.state) ? a.state : undefined),"accounts") : unavailable(area,"Quota · " + (snapshot?.quota.state || "unknown"));
  R.overview = () => {
    const s=snapshot, agents=s?.agents || [], live=s?.source.state === "live";
    const quotaObserved=s?.quota.accounts.map(a=>a.observedAt).filter(Number.isFinite) || [];
    const kpi = '<div class="stats hero-row">' + [["—","needs Igor"],["—","open incidents"],[s?agents.filter(a=>a.state==="working").length:"—","working"],[s?agents.filter(a=>a.state==="waiting-igor").length:"—","waiting"],["—","exec slots"],["—","queued jobs"],[s?.tokens.rate == null ? "—" : s.tokens.rate.toFixed(1),s?.tokens.coverage==="partial"?"rate lower bound":"output rate","tok/s · 60 s avg"],["—","shipped today"]].map(x=>heroStat(...x)).join("") + '</div>';
    const rows=agents.slice(0,4).map(a=>'<div class="item"><div class="l1"><span class="t two t1">' + esc(a.title) + '</span></div><div class="l2">' + st(a.state,a.state) + ' · ' + esc(a.model) + ' · ' + esc(a.host) + '</div><div class="t1 muted">' + esc(activityItems(a)[0]?.text ? activityItems(a)[0].kind+": "+activityItems(a)[0].text : "Previews unavailable") + '</div></div>').join("");
    return sourcePanel("kpi",(s?.sampled?"Enrolled sources · sampled · ":"PC canary · ") + (live?"connected":"last known") + (s?.tokens.coverage==="partial"?" · partial tokens":""),kpi) + unavailable("inbox","Decision inbox") + sourcePanel("threads","Threads · " + threadCoverage(Math.min(4,agents.length)),rows || missing("No observed threads")) + sourcePanel("hosts","Hosts · resources",fleetBody(),"host") + panel("quota","Quota",s?.quota.accounts.length ? budget(s.quota.accounts,2,a=>'<div class="item">' + esc(a.label) + ' · ' + esc(a.state) + ' · ' + (a.used==null?"usage unknown":a.used+"% used") + '</div>',"accounts") : missing("No cached quota"),"quota",quotaObserved.length ? age(Math.max(...quotaObserved)) : null) + unavailable("events","Latest events");
  };
  R.tokens = () => sourcePanel("thero",snapshot?.tokens.coverage==="partial"?"Partial output · 60 s average":"Output rate · 60 s average",'<div class="stats">' + heroStat(snapshot?.tokens.rate == null ? "—" : snapshot.tokens.rate.toFixed(1),snapshot?.tokens.coverage==="partial"?"rate lower bound":"output rate","tok/s · 60 s avg") + heroStat(snapshot?.tokens.output ?? "—",snapshot?.tokens.coverage==="partial"?"output lower bound":"observed output","since process start") + '</div>',"t3thread") + panel("models","Observation scope",missing(snapshot?.tokens.scope || "No usage data") + missing("Updated " + (age(snapshot?.tokens.observedAt) ?? "unknown") + "s ago · daily totals and model history unavailable"),"t3thread",age(snapshot?.tokens.observedAt),snapshot?.source.state === "live" ? undefined : "stale") + unavailable("hourly","Today by hour");
  R.quota=()=>quotas();
  for(const m of ["events","ops","lab"]) R[m]=()=>unavailable("summary",m + " unavailable");
  const hostList = () => snapshot?.hostSummary || [];
  const hostFreshness = h => h.observedAt == null ? "nosource" : h.freshness === "live" && age(h.observedAt)>90 ? "stale" : h.freshness;
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
  const fleetBody = () => hostList().map(h=>hostCard(h)).join("") || missing("No host observations");
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
    if(Array.isArray(d.recent))return d.recent.slice(0,3).filter(p=>["assistant","command"].includes(p.kind)&&previewText(p.preview)).map(p=>({
      kind:(p.kind==="assistant"?"Assistant":p.status==="running"?(commandIsCurrent(a)?"Active command observed":"Last observed command · outcome unknown"):"Command · "+(["completed","failed","cancelled"].includes(p.status)?p.status:"outcome unknown"))+(!Number.isFinite(p.at)?"":" · observed "+age(p.at)+"s ago")+previewLabel(p.preview),
      text:p.preview.text
    }));
    const items=[];
    if(previewText(d.assistant))items.push({kind:"Assistant"+previewLabel(d.assistant),text:d.assistant.text});
    for(const p of d.commands||[])if(previewText(p))items.push({kind:commandLabel(a)+previewLabel(p),text:p.text});
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
    const effort=reported?d.effort?.value:null, u=reported?d.usage:null;
    const tokens=u && u.coverage!=="not-reported" && Number.isFinite(u.total)?u.total:null;
    return (a.model && a.model!=="unknown"?'<span class="card-model" title="'+esc(a.model)+'">'+esc(a.model)+'</span>':'')
      +(effort?'<span class="card-effort" title="Reported effort">'+esc(effort)+'</span>':'')
      +(tokens==null?'':'<span class="card-usage" title="'+esc(usage(u))+'">'+esc(compactTokens(tokens))+' tok</span>');
  };
  UI.agentChangeStamp = a => {
    const d=a.details, reported=d && (!a.detailCoverage || a.detailCoverage==="reported") && d.fieldCoverage!=="identity-only";
    const previews=!reported?[]:Array.isArray(d.recent)?d.recent.slice(0,3).filter(p=>["assistant","command"].includes(p.kind)&&previewText(p.preview)).map(p=>[p.kind,p.preview.text,p.preview.state,p.at,p.status]):[previewText(d.assistant),(d.commands||[]).map(previewText)];
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
      DATA.threads=snapshot.agents.map(a=>({ ...a, activityObservedAt:receivedSnapshot.agents.find(raw=>raw.id===a.id)?.detailObservedAt, state:a.state, observed:age(a.detailObservedAt), sourceObserved:age(snapshot.hostSummary?.find(h=>h.host===a.host)?.observedAt ?? a.observedAt), age:null, run:age(a.startedAt), effort:a.details?.effort?.value?a.details.effort.value+" ("+a.details.effort.source+")":"not reported", steps:a.steps.map(tool=>({tool})) }));
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
