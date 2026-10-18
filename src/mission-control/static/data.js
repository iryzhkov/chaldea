// Deterministic demonstration snapshots. No live readers or credentials.
const DATA = {
  now: new Date('2026-10-17T17:42:18+03:00'), tz: 'UTC+3', tzOffsetMin: 180,
  demo: true,
  // Closed wall-visible target dictionary. Keys are fixture IDs, never parsed command arguments.
  wallTargets: {
    hosts:'exec/hosts.go', hostsTest:'exec/hosts_test.go', execDir:'exec/',
    plan:'internal/plan/prepare.go', planTest:'internal/plan/plan_test.go', planDir:'internal/plan/',
    rollout:'rollout.yml', rolloutDoc:'fleet-rollout/README.md', pr412:'PR #412', pr418:'PR #418',
    thread:'thread …c91a', threads:'running threads', dataMap:'mission-control data map',
    jobTests:'job j-demo-01 · agent-a', jobEval:'job j-demo-07 · agent-b', jobPrior:'job j-demo-06 · agent-b',
    decision:'decision d-demo-01', review:'review task r-demo-02', planChange:'change plan p-demo-03',
    evalResults:'eval/results/batch-6.json', evalCode:'eval/harness.py', evalPlan:'eval plan',
    ingest:'ingest/backpressure.go', queue:'ingest/queue.go', projection:'orchestrationV2.ts',
    overview:'Overview', styles:'src/core.css', core:'src/core.js', spec:'design spec', reviewDoc:'review.md',
    policy:'src/route/policy.ts', handoff:'handoff document'
  },
  hosts: [
    { id:'omarchy-pc', label:'omarchy-pc', kind:'gaming pc · RTX 4090', slots:2, used:1, queue:0, cpu:38, ram:[27,64], gpu:62, vram:[14.2,24], vramBy:[['ollama',8.1],['whisper',2.9],['threads',3.2]], gate:'open', gateNote:'no game running', up:true, fresh:'live', age:2 },
    { id:'agent-a', label:'agent-a', kind:'vm · 16 vcpu', slots:3, used:3, queue:2, cpu:91, ram:[29,32], up:true, fresh:'live', age:4, converge:'rev 38 · 12m ago' },
    { id:'agent-b', label:'agent-b', kind:'vm · 8 vcpu', slots:1, used:1, queue:1, cpu:74, ram:[11,16], up:true, fresh:'live', age:3, converge:'rev 37 · held' },
    { id:'laptop', label:'laptop', kind:'macbook · asleep', slots:1, used:0, queue:0, cpu:0, ram:[0,32], up:false, fresh:'lost', age:7420, converge:'rev 38 · 2h ago' },
  ],
  threads: [
    { id:'t1', activity:'Editing exec/hosts.go · refusal ordering', title:'Chaldea exec-hosts failover', short:'Chaldea exec failover', host:'omarchy-pc', provider:'claude', model:'Opus 5.5', state:'working', age:4, run:1080, observed:4, tps:412,
      steps:[{tool:'edit_apply',target:'hosts',ageSeconds:4},{tool:'verify_run',target:'execDir',ageSeconds:41},{tool:'search',target:'execDir',ageSeconds:60},{tool:'read',target:'hosts',ageSeconds:120},{tool:'chaldea exec',target:'jobTests',ageSeconds:180},{tool:'edit_apply',target:'hostsTest',ageSeconds:300}], effort:'high' },
    { id:'t2', activity:'Running plan tests · 1 failing', title:'Huyang change_plan prepare pipeline', short:'Huyang prepare pipeline', host:'agent-a', provider:'codex', model:'Sol 6.1', state:'working', age:41, run:640, observed:41, tps:0,
      steps:[{tool:'chaldea exec',target:'jobTests',ageSeconds:41},{tool:'edit_apply',target:'plan',ageSeconds:180},{tool:'read',target:'planTest',ageSeconds:240},{tool:'change_plan',target:'planChange',ageSeconds:360},{tool:'search',target:'planDir',ageSeconds:420},{tool:'navigate',target:'plan',ageSeconds:480}], effort:'high' },
    { id:'t3', activity:'Review blocked: pinned revision', title:'Review: fleet-rollout PR #412', short:'Review rollout #412', host:'agent-a', provider:'claude', model:'Fable 5.1', state:'waiting-igor', age:372, run:960, observed:3, tps:0, effortx:'medium',
      steps:[{tool:'chaldea_decision_prepare',target:'decision',ageSeconds:3},{tool:'read',target:'rollout',ageSeconds:360},{tool:'watch_pull_request',target:'pr412',ageSeconds:420},{tool:'search',target:'rolloutDoc',ageSeconds:480},{tool:'delegate_task',target:'review',ageSeconds:720},{tool:'read',target:'rolloutDoc',ageSeconds:840}], effort:'high' },
    { id:'t4', activity:'Reading thread projections', title:'Mission control data map (T3 API)', short:'MC data map', host:'omarchy-pc', provider:'claude', model:'Sonnet 5.5', state:'working', age:12, run:3120, observed:12, tps:188,
      steps:[{tool:'t3_thread_read',target:'thread',ageSeconds:12},{tool:'t3_thread_list',target:'threads',ageSeconds:40},{tool:'jocasta',target:'dataMap',ageSeconds:540},{tool:'read',target:'projection',ageSeconds:840},{tool:'search',target:'projection',ageSeconds:1200},{tool:'read',target:'projection',ageSeconds:1860}], effort:'high' },
    { id:'t5', activity:'Eval batch 7 · 130 of 200', title:'Slopalytics eval batch 7', short:'Slopalytics batch 7', host:'agent-b', provider:'codex', model:'Luna 6', state:'working', age:131, run:840, observed:5, tps:0,
      steps:[{tool:'chaldea exec',target:'jobEval',ageSeconds:5},{tool:'read',target:'evalResults',ageSeconds:960},{tool:'edit_apply',target:'evalCode',ageSeconds:1320},{tool:'search',target:'evalCode',ageSeconds:1500},{tool:'chaldea exec',target:'jobPrior',ageSeconds:1800},{tool:'jocasta',target:'evalPlan',ageSeconds:2400}], effort:'high' },
    { id:'t6', activity:'Waiting for CI on PR #418', title:'Akasha ingest backpressure', short:'Akasha backpressure', host:'agent-a', provider:'codex', model:'Astra', state:'waiting-ci', age:184, run:780, observed:2, tps:0,
      steps:[{tool:'watch_pull_request',target:'pr418',ageSeconds:2},{tool:'read',target:'ingest',ageSeconds:180},{tool:'read',target:'queue',ageSeconds:240},{tool:'verify_run',target:'jobTests',ageSeconds:360},{tool:'edit_apply',target:'ingest',ageSeconds:540},{tool:'read',target:'queue',ageSeconds:660}], effort:'high' },
    { id:'t7', activity:'Rendering previews', title:'Mission control design', short:'MC design', host:'omarchy-pc', provider:'claude', model:'Fable 5.1', state:'working', age:1, run:10920, observed:1, tps:960,
      steps:[{tool:'html_preview',target:'overview',ageSeconds:1},{tool:'html_preview',target:'overview',ageSeconds:20},{tool:'edit_apply',target:'styles',ageSeconds:60},{tool:'edit_apply',target:'core',ageSeconds:120},{tool:'jocasta',target:'spec',ageSeconds:540},{tool:'read',target:'reviewDoc',ageSeconds:2400}], effort:'high' },
  ],
  decisions: [
    { id:'d1', q:'Promote fleet-rollout rev 38 to agent-b?', from:'Review: fleet-rollout PR #412', deadline:'18:30', def:'defer', age:372 },
    { id:'d2', q:'Keep Huyang 0.9.2 canary on agent-a overnight?', from:'Huyang canary watch', deadline:'22:00', def:'roll back', age:1560 },
  ],
  accounts: [
    { id:'claude · igor',  provider:'claude', cls:'paced',     used:61,  pace:58, reset:'2h 14m', weekly:'Sun 02:00 · 3d 8h', credits:[142,300], creditsExpire:'31 Oct', manualResets:1, fresh:'live', age:9 },
    { id:'claude · fleet', provider:'claude', cls:'use-it',    used:23,  pace:58, reset:'2h 14m', weekly:'Sun 02:00 · 3d 8h', credits:null, manualResets:0, fresh:'live', age:9 },
    { id:'codex · igor',   provider:'codex',  cls:'tight',     used:88,  pace:71, reset:'47m',    weekly:'Mon 00:00 · 2d 6h', credits:[18,50], creditsExpire:'24 Oct', manualResets:0, fresh:'stale', age:252 },
    { id:'codex · fleet',  provider:'codex',  cls:'unlimited', used:null,pace:null, reset:'—',    weekly:'—', credits:null, manualResets:0, fresh:'live', age:11 },
    { id:'codex · b',      provider:'codex',  cls:'stopped',   used:100, pace:71, reset:'3h 02m', weekly:'Mon 00:00 · 2d 6h', credits:null, manualResets:2, fresh:'live', age:11 },
    { id:'ollama · local', provider:'local',  cls:'unknown',   used:null,pace:null, reset:'—',    weekly:'—', credits:null, manualResets:0, fresh:'lost', age:1880 },
  ],
  tokens: {
    providers: [
      { id:'claude', label:'Claude', models:[
        { id:'opus',   label:'Opus 5.5',   rate:412, today:3_842_000, spark:[120,180,240,210,390,420,380,450,470,410,300,280,330,360,420,460,440,400,380,412,430,415,420,398,405,412,420,410,415,412] },
        { id:'fable',  label:'Fable 5.1',  rate:960, today:2_210_000, spark:[0,0,40,60,120,200,180,160,220,300,420,610,700,650,720,800,840,880,910,940,960,955,950,962,958,960,970,965,960,960] },
        { id:'sonnet', label:'Sonnet 5.5', rate:188, today:6_104_000, spark:[300,320,310,290,280,260,250,240,230,220,210,200,195,190,188,186,185,187,188,190,189,188,188,187,188,189,188,188,188,188] },
      ]},
      { id:'codex', label:'Codex', models:[
        { id:'sol',   label:'Sol 6.1', rate:0,   today:1_920_000, spark:[280,300,310,260,240,220,200,180,160,140,120,100,80,60,40,20,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
        { id:'astra', label:'Astra',   rate:0,   today:640_000,   spark:[90,110,120,100,80,60,80,100,90,70,50,30,20,10,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] },
        { id:'luna',  label:'Luna 6',  rate:74,  today:1_480_000, spark:[60,70,65,80,75,70,72,74,76,70,68,72,74,75,73,74,74,75,72,74,73,74,74,75,74,74,73,74,74,74] },
      ]},
      { id:'local', label:'Local', models:[
        { id:'qwen', label:'qwen3.5 35B-A3B', rate:38, today:910_000, spark:[0,0,0,0,30,40,38,42,36,38,40,39,38,37,38,38,39,38,36,38,38,39,38,38,38,37,38,38,38,38] },
      ]},
    ],
    hourly: [120,90,60,40,30,30,45,80,140,210,260,310,340,360,380,420,470,520,0,0,0,0,0,0],
  },
  events: [
    { t:'17:41', type:'canary',   text:'Huyang 0.9.2 canary on agent-a: 2h clean, provisional rate 6.1%', host:'agent-a' },
    { t:'17:36', type:'decision', text:'Decision waiting: promote fleet-rollout rev 38 to agent-b?', host:'agent-a', hot:true },
    { t:'17:29', type:'merge',    text:'PR #410 merged: chaldea exec-hosts refusal ordering', host:'omarchy-pc' },
    { t:'17:12', type:'deploy',   text:'ansible-pull converged rev 38 on omarchy-pc', host:'omarchy-pc' },
    { t:'16:58', type:'alert',    text:'Gatus: offsite backup heartbeat late (31h, limit 26h)', host:'homelab', hot:true },
    { t:'16:40', type:'merge',    text:'PR #409 merged: jocasta --if-revision retry guard', host:'agent-a' },
    { t:'16:21', type:'deploy',   text:'chaldea v0.14.1 released, agent-a and agent-b updated', host:'fleet' },
    { t:'15:55', type:'decision', text:'Igor answered: keep Huyang canary → yes, re-ask 22:00', host:'omarchy-pc' },
    { t:'15:30', type:'canary',   text:'whisper-server canary passed 50 requests, p95 410 ms', host:'omarchy-pc' },
    { t:'15:02', type:'alert',    text:'codex · igor quota class changed paced → tight', host:'quota' },
    { t:'14:47', type:'merge',    text:'PR #407 merged: OV memory_write namespace guard', host:'agent-b' },
    { t:'14:10', type:'deploy',   text:'trust bundle republished, 4 hosts verified', host:'homelab' },
    { t:'13:38', type:'alert',    text:'agent-b exec slot held 41m by j-8d90, released', host:'agent-b' },
    { t:'12:05', type:'merge',    text:'PR #405 merged: Slopalytics leaderboard export', host:'agent-b' },
    { t:'11:40', type:'deploy',   text:'ansible-pull converged rev 37 on agent-b, 2 changed', host:'agent-b' },
    { t:'11:12', type:'canary',   text:'Huyang 0.9.2 canary started on agent-a', host:'agent-a' },
    { t:'10:30', type:'alert',    text:'agent-a disk / crossed 85%', host:'agent-a' },
    { t:'09:48', type:'merge',    text:'PR #403 merged: fleet feed retention policy', host:'omarchy-pc' },
  ],
  prs: [
    { n:412, title:'fleet-rollout: pin ansible-pull to revision', repo:'omarchy-setup', author:'Opus 5.5', reviewer:'Fable 5.1', verdict:'blocking 1', ci:'pass', age:'38m' },
    { n:418, title:'akasha: ingest backpressure window', repo:'akasha', author:'Astra', reviewer:'—', verdict:'awaiting CI', ci:'running', age:'3m' },
    { n:415, title:'huyang: change_plan provisional evidence', repo:'huyang', author:'Sol 6.1', reviewer:'Fable 5.1', verdict:'accepted', ci:'pass', age:'1h 20m' },
    { n:411, title:'chaldea: decision inbox deadlines', repo:'chaldea', author:'Opus 5.5', reviewer:'Astra', verdict:'fix round 2', ci:'fail', age:'2h 05m' },
  ],
  gatus: [
    { id:'trust publisher', ok:true,  note:'bundle 4h 12m old' },
    { id:'akasha backup',   ok:true,  note:'02:10 · 1.2 GB' },
    { id:'offsite backup',  ok:false, note:'late 31h' },
    { id:'homelab health',  ok:true,  note:'9/10 services' },
    { id:'whisper.ryzhkov.dev', ok:true, note:'p95 410 ms' },
    { id:'fleet feed :1934', ok:true, note:'last event 1m' },
  ],
  akasha: { ingest:38, unit:'docs/min', backlog:1240 },
  huyang: { edits:412, provisional:6.1, refusals:9, plans:23 },
  shipped: ['#410 exec-hosts refusal ordering','#409 jocasta --if-revision guard','#407 OV namespace guard','#405 Slopalytics export','chaldea v0.14.1'],
  leaderboard: [
    { model:'Opus 5.5',  done:96.2, fail:1.1,  n:184 },
    { model:'Sol 6.1',   done:94.8, fail:2.0,  n:151 },
    { model:'Fable 5.1', done:93.9, fail:1.4,  n:72  },
    { model:'Sonnet 5.5',done:91.1, fail:3.8,  n:402 },
    { model:'Astra',     done:90.4, fail:2.6,  n:66  },
    { model:'Luna 6',    done:84.7, fail:7.9,  n:310 },
    { model:'qwen3.5 local', done:71.3, fail:11.6, n:130 },
  ],
  evalRun: { model:'qwen3.5 35B-A3B', done:130, total:200, eta:'19m', pass:88.4 },
  services: [['traefik',1],['gatus',1],['openviking',1],['jocasta',1],['akasha',1],['fleet feed',1],['whisper',1],['ollama',1],['home assistant',1],['offsite sync',0]],
  // Round 3 additions: fleet, trust, akasha, routing, task tree, waits, huyang per host, expiring, incidents, audit, presence.
  fleet: [
    { host:'omarchy-pc', releases:{ chaldea:['0.14.1','0.14.1'], host:['rev 38','rev 38'], huyang:['0.9.2','0.9.2'], t3:['0.1.0','0.1.0'], cli:['2.1.302','2.1.302'] }, converge:{ at:'17:12', outcome:'ok', changed:3 }, next:'18:12', roles:['desk','gpu','exec'], held:[] },
    { host:'agent-a',    releases:{ chaldea:['0.14.1','0.14.1'], host:['rev 38','rev 38'], huyang:['0.9.2','0.9.2 canary'], t3:['0.1.0','0.1.0'], cli:['2.1.302','2.1.298'] }, converge:{ at:'17:30', outcome:'ok', changed:1 }, next:'18:30', roles:['exec','builder','trust-publisher?'], held:['#412 trust enablement · hand converge'] },
    { host:'agent-b',    releases:{ chaldea:['0.14.1','0.14.1'], host:['rev 38','rev 37'], huyang:['0.9.2','0.9.1'], t3:['0.1.0','0.1.0'], cli:['2.1.302','2.1.298'] }, converge:{ at:'16:05', outcome:'held', changed:0 }, next:'held', roles:['exec','eval'], held:['rev 38 · waiting on decision'] },
    { host:'laptop',     releases:{ chaldea:['0.14.1','0.14.1'], host:['rev 38','rev 38'], huyang:['0.9.2','0.9.2'], t3:['0.1.0','0.1.0'], cli:['2.1.302','2.1.302'] }, converge:{ at:'15:31', outcome:'ok', changed:0 }, next:'asleep', roles:['desk','exec'], held:[] },
  ],
  rollouts: [
    { what:'rev 38 host release', missing:['agent-b'] },
    { what:'huyang 0.9.2', missing:['agent-b'], note:'canary on agent-a' },
    { what:'agent CLI 2.1.302', missing:['agent-a','agent-b'] },
    { what:'chaldea 0.14.1', missing:[] },
  ],
  trust: { seq:1842, age:'4h 12m', publisher:{ ok:true, age:'2m' }, kid:'k-2026-09-2', minted:7, expires:'19h 48m' },
  akashaMore: { parityPct:61, parityLeft:'1d 4h', backupAge:'15h', offsiteAge:'31h', offsiteLate:true, retained:'ok 03:10' },
  routing: { scope:'fleet · effective picks (quota-aware)', observed:40, byProvider:{
      claude:{ builder:{model:'Opus 5.5', effort:'high'}, 'critical review':{model:'Fable 5.1', effort:'medium'}, 'bulk read':{model:'Sonnet 5.5', effort:'low'}, general:{model:'Opus 5.5', effort:'high'} },
      codex:{ builder:{model:'Sol 6.1', effort:'high'}, 'critical review':{model:'Astra', effort:'medium'}, 'bulk read':{model:null, reason:'Luna 6 in probation · no eligible model'}, general:{model:null, reason:'codex · igor tight · admission paused'} } },
    picks:[['builder','Opus 5.5'],['critical review','Fable 5.1'],['bulk read','Sonnet 5.5'],['codex builder','Sol 6.1']], changes:[['15:02','codex','builder','Astra','Sol 6.1','codex · igor quota tight'],['Fri 11:20','claude','bulk read','Luna 6','Sonnet 5.5','fail rate 7.9 % over 310 tasks']], probation:[['Luna 6','fail 7.9% · 310 tasks'],['qwen3.5 local','fail 11.6% · eval running']] },
  tasks: [
    { d:0, title:'Chaldea exec-hosts failover', model:'Opus 5.5', repo:'chaldea', dur:'1h 48m', round:'', verdict:'orchestrating' },
    { d:1, title:'builder: exec/hosts.go refusal order', model:'Opus 5.5', repo:'chaldea', dur:'41m', round:'r2', verdict:'building' },
    { d:2, title:'review: Fable 5.1', model:'Fable 5.1', repo:'chaldea', dur:'6m', round:'r1', verdict:'1 blocking' },
    { d:2, title:'review: Astra (security)', model:'Astra', repo:'chaldea', dur:'4m', round:'r1', verdict:'accept' },
    { d:0, title:'Mission control design', model:'Fable 5.1', repo:'scratch', dur:'3h 02m', round:'', verdict:'round 3' },
    { d:1, title:'data map (T3 API)', model:'Sonnet 5.5', repo:'chaldea', dur:'52m', round:'', verdict:'done · jocasta @2' },
  ],
  waits: [
    { what:'quota reset · codex · igor', at:'18:29', left:'47m' },
    { what:'decision deadline · rev 38', at:'18:30', left:'48m' },
    { what:'Huyang canary re-ask', at:'22:00', left:'4h 18m' },
    { what:'T3 token renewal · agent-b', at:'12 Nov 09:00', left:'25d' },
  ],
  huyangHosts: [
    { host:'omarchy-pc', ver:'0.9.2', ls:['go','ts','py'], prov:4.8, ref:3 },
    { host:'agent-a',    ver:'0.9.2c', ls:['go','ts','py','rs'], prov:6.1, ref:5 },
    { host:'agent-b',    ver:'0.9.1', ls:['go','py'], prov:9.4, ref:1 },
    { host:'laptop',     ver:'0.9.2', ls:['go','ts'], prov:null, ref:0 },
  ],
  expiring: [
    { what:'trust bundle', left:'19h 48m', pct:79, at:'tomorrow 13:30' },
    { what:'codex · igor credits', left:'7d', pct:77, at:'24 Oct' },
    { what:'claude · igor credits', left:'14d', pct:53, at:'31 Oct' },
    { what:'T3 token · agent-b', left:'25d', pct:17, at:'12 Nov' },
    { what:'cert whisper.ryzhkov.dev', left:'41d', pct:54, at:'28 Nov' },
  ],
  incidents: [
    { sev:'fail', what:'Gatus: offsite backup late 31h (limit 26h)', host:'homelab', age:'44m' },
    { sev:'warn', what:'agent-a disk / at 88%', host:'agent-a', age:'2h' },
    { sev:'warn', what:'agent-a memory pressure: 29/32G, swap 1.1G', host:'agent-a', age:'12m' },
    { sev:'fail', what:'chaldea-retention.service failed 03:10, retried ok 03:25', host:'agent-b', age:'14h' },
    { sev:'ok',   what:'retention: 412 jobs pruned, 9.1G freed', host:'fleet', age:'14h' },
  ],
  audit: { last:'11 Oct', since:6, next:'M7 merge or 25 Oct', plan:'rev 12', lanes:[['fleet-rollout','M6',72],['huyang prepare','M4',40],['mission control','design',85]] },
  presence: { laptop:'asleep since 15:38', gate:'open · no game running', quiet:'23:00–07:00 · off' },
  // Round 4: a pool of 48 plausible agents for the density fixtures (?agents=N). Order is stable: by start time.
  agentPool: (() => {
    const titles = ['Chaldea exec-hosts failover','Huyang change_plan prepare pipeline','Review: fleet-rollout PR #412','Mission control data map (T3 API)','Slopalytics eval batch 7','Akasha ingest backpressure','Mission control design','Jocasta conflict retry guard','OV namespace guard tests','Trust publisher heartbeat gap','whisper-server canary round 2','Fleet feed retention policy','ansible-pull pin to revision','Decision inbox deadlines','Huyang diagnostics evidence paging','Chaldea quota headroom publisher','Gatus offsite backup probe','Sunshine virtual display profile','Minecraft DH thread limits','Local model eval harness','Codex adapter restart-resume','T3 token renewal automation','Roadmap executor handoff format','Review: akasha PR #418','Review: huyang PR #415','Review: chaldea PR #411 (security)','Ollama alias local 128K context','Traefik cert renewal check','Home Assistant webpage card','Bellerophon night profile tuning','Slopalytics leaderboard export','Fleet config drift report','Agent CLI 2.1.302 rollout','Hyprland monitor profiles','Memory curation pass October','OpenViking reindex job','Akasha parity check scheduler','Chaldea wait fire-time audit','Huyang language server install','Fleet rollout M6 verification','PR #420 docs: embedding CSP','Eval batch 8 queue','Codex credits burn forecast','Trust anchor rotation plan','Jocasta archive sweep','Steward coordinator smoke test','Da Vinci scheduler review','Laptop wake-on-LAN probe'];
    const hosts = ['omarchy-pc','agent-a','agent-b','omarchy-pc','agent-a','agent-a'];
    const models = [['claude','Opus 5.5'],['codex','Sol 6.1'],['claude','Fable 5.1'],['claude','Sonnet 5.5'],['codex','Luna 6'],['codex','Astra']];
    const acts = [['edit_apply','policy'],['chaldea exec','jobTests'],['read','rollout'],['t3_thread_read','thread'],['chaldea exec','jobEval'],['watch_pull_request','pr418'],['html_preview','overview'],['change_plan','planChange'],['verify_run','jobTests'],['jocasta','handoff'],['search','planDir'],['delegate_task','review'],['watch_pull_request','pr412'],['navigate','plan']];
    const efforts = ['high','high','medium','low','medium','medium'];
    const states = ['working','working','working','waiting-igor','working','waiting-ci','working','working','failed','working','working','idle'];
    return titles.map((t, i) => ({ id:'a' + i, title:t, host:hosts[i % hosts.length], provider:models[i % models.length][0], model:models[i % models.length][1], state:states[i % states.length], effort:efforts[i % efforts.length], tps:[412,0,960,188,0,74][i % 6], run: 300 + i * 210, observed: i % 7 === 3 ? 400 : (i * 13) % 50, steps: Array.from({ length:6 }, (_,k) => ({tool:acts[(i+k)%acts.length][0],target:acts[(i+k)%acts.length][1],ageSeconds:k === 0 ? (i*13)%50 : (k*2+i%3)*60})) }));
  })(),
  sources: [
    { id:'t3 shell · omarchy-pc', kind:'t3shell', age:4 }, { id:'t3 shell · agent-a', kind:'t3shell', age:6 }, { id:'t3 shell · agent-b', kind:'t3shell', age:9 }, { id:'t3 shell · laptop', kind:'t3shell', age:7420, state:'asleep' },
    { id:'fleet feed', kind:'feed', age:48 }, { id:'chaldea quota', kind:'quota', age:252, state:'stale' }, { id:'host telemetry', kind:'host', age:null, state:'nosource' }, { id:'ollama quota', kind:'quota', age:null, state:'unsupported' }, { id:'akasha api', kind:'akasha', age:null, state:'nosource' }, { id:'converge reports', kind:'fleet', age:70 }, { id:'gatus', kind:'gatus', age:15 }, { id:'slopalytics', kind:'slop', age:300 },
  ],
};
