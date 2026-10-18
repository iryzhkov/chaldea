// Age the retained source snapshot even when the browser transport is quiet or lost.
export function projectClientSnapshot(snapshot, now, connected) {
  if (!snapshot) return null;
  const lost = !connected || !Number.isFinite(snapshot.now) || now - snapshot.now > 30_000;
  return { ...snapshot,
    source: { ...snapshot.source, observedAt: !snapshot.sampled && snapshot.source.state === "live" ? snapshot.now : snapshot.source.observedAt,
      state: lost && snapshot.source.state === "live" ? "disconnected" : snapshot.source.state },
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
  let snapshot = null, receivedSnapshot = null, transportConnected = false, mode = new URLSearchParams(location.search).get("mode") || "overview";
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
    const rows=budget(agents,4,a=>'<div class="item"><div class="l1"><span class="t two t1">' + esc(a.title) + '</span></div><div class="l2">' + st(a.state,a.state) + ' · ' + esc(a.model) + ' · ' + esc(a.host) + '</div><div class="t1 muted">' + esc(a.steps[0] || "Activity unavailable") + '</div></div>',"threads");
    return sourcePanel("kpi",(s?.sampled?"Enrolled sources · sampled · ":"PC canary · ") + (live?"connected":"last known") + (s?.tokens.coverage==="partial"?" · partial tokens":""),kpi) + unavailable("inbox","Decision inbox") + sourcePanel("threads","Threads · showing " + agents.length + " of " + (s?.total ?? "unknown") + (s?.truncated ? " · coverage incomplete" : ""),rows || missing("No observed threads")) + unavailable("hosts","Hosts · exec slots") + panel("quota","Quota",s?.quota.accounts.length ? budget(s.quota.accounts,2,a=>'<div class="item">' + esc(a.label) + ' · ' + esc(a.state) + ' · ' + (a.used==null?"usage unknown":a.used+"% used") + '</div>',"accounts") : missing("No cached quota"),"quota",quotaObserved.length ? age(Math.max(...quotaObserved)) : null) + unavailable("events","Latest events");
  };
  R.tokens = () => sourcePanel("thero",snapshot?.tokens.coverage==="partial"?"Partial output · 60 s average":"Output rate · 60 s average",'<div class="stats">' + heroStat(snapshot?.tokens.rate == null ? "—" : snapshot.tokens.rate.toFixed(1),snapshot?.tokens.coverage==="partial"?"rate lower bound":"output rate","tok/s · 60 s avg") + heroStat(snapshot?.tokens.output ?? "—",snapshot?.tokens.coverage==="partial"?"output lower bound":"observed output","since process start") + '</div>',"t3thread") + panel("models","Observation scope",missing(snapshot?.tokens.scope || "No usage data") + missing("Updated " + (age(snapshot?.tokens.observedAt) ?? "unknown") + "s ago · daily totals and model history unavailable"),"t3thread",age(snapshot?.tokens.observedAt),snapshot?.source.state === "live" ? undefined : "stale") + unavailable("hourly","Today by hour");
  R.quota=()=>quotas();
  for(const m of ["fleet","events","ops","lab"]) R[m]=()=>unavailable("summary",m + " unavailable");
  const originalAgents = R.agents;
  R.agents = () => originalAgents().replace(/hosts awake[^<]*/g,(snapshot?.sampled?"Enrolled sources only · sampled":"PC source only · fleet presence not observed") + (snapshot?.truncated ? " · coverage incomplete" : ""));
  document.addEventListener("mc:mode",e=>{mode=e.detail;});
  function render() {
    snapshot = projectClientSnapshot(receivedSnapshot, Date.now(), transportConnected);
    if(snapshot) {
      DATA.demo=snapshot.demo;
      DATA.threads=snapshot.agents.map(a=>({ ...a, state:a.state, observed:age(a.detailObservedAt), age:null, run:age(a.startedAt), effort:"unknown", steps:a.steps.map(tool=>({tool})) }));
      DATA.agentPool=DATA.threads; DATA.sources=[];
    }
    window.MC.show(window.MC.MODES.includes(mode)?mode:"overview");
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
