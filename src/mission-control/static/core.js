// Mission control board core, round 5. Palette, one freshness contract, content budgets, instrument helpers, renderers,
// agent density tiers, cycling and display care.
(function () {
  const Q = new URLSearchParams(location.search);
  const MODES = ['overview','agents','agent-summary','fleet','tokens','quota','events','ops','lab'];
  const MORE = new Set(['ops','lab']);
  const LABEL = { overview:'Overview', agents:'Live threads', 'agent-summary':'Agent summary', fleet:'Fleet', tokens:'Tokens', quota:'Quota', events:'Events', ops:'Ops', lab:'Lab' };
  const DWELL = { overview:30, agents:20, 'agent-summary':20, fleet:20, tokens:20, quota:20, events:20, ops:15, lab:15 };
  const CONSOLE = { kpi:'FLIGHT', inbox:'FD', threads:'CAPCOM', hosts:'EECOM', quota:'FAO', events:'PAO', summary:'FLIGHT', config:'EECOM', rollouts:'BOOSTER', trust:'INCO', timers:'BOOSTER', expiring:'FAO', thero:'EECOM', models:'GNC', hourly:'FIDO', acct:'FAO', ecount:'PAO', timeline:'PAO', einbox:'FD', waits:'FD', incidents:'SURGEON', prs:'GUIDO', backups:'EECOM', health:'SURGEON', tasks:'CAPCOM', routing:'GNC', board:'RETRO', eval:'GNC', huyang:'GUIDO', audit:'FLIGHT' };
  const GLYPH = { working:'●', 'waiting-igor':'◆', 'waiting-ci':'◐', failed:'✕', idle:'○', merge:'⑂', deploy:'▲', alert:'!', canary:'◐', decision:'?', 'use-it':'▲', unlimited:'∞', paced:'●', tight:'◆', stopped:'✕', unknown:'?', ok:'●', warn:'◆', fail:'✕', up:'●', down:'✕', late:'◆', none:'—' };
  const CLS = { working:'pri', 'waiting-igor':'warn', 'waiting-ci':'sec', failed:'fail', idle:'stale', merge:'ok', deploy:'pri', alert:'fail', canary:'sec', decision:'warn', 'use-it':'ok', unlimited:'ok', paced:'pri', tight:'warn', stopped:'fail', unknown:'stale', ok:'ok', warn:'warn', fail:'fail', up:'ok', down:'fail', late:'warn', none:'stale' };
  const STATE_LABEL = { waiting:'Waiting', working:'Working', 'waiting-igor':'Waiting for Igor', 'waiting-ci':'Waiting for CI', failed:'Failed', idle:'Idle' };
  // One freshness contract: expected cadence, stale and lost thresholds in seconds, per source kind.
  const SOURCES = { t3shell:{ cadence:10, stale:30, lost:300, label:'T3 shell stream' }, t3thread:{ cadence:30, stale:60, lost:600, label:'T3 thread stream' }, exec:{ cadence:30, stale:90, lost:600, label:'chaldea exec list' }, host:{ cadence:30, stale:90, lost:600, label:'host telemetry' }, quota:{ cadence:900, stale:1800, lost:5400, label:'chaldea quota' }, feed:{ cadence:30, stale:120, lost:900, label:'fleet feed' }, fleet:{ cadence:300, stale:900, lost:3600, label:'converge reports' }, gatus:{ cadence:60, stale:300, lost:900, label:'gatus' }, akasha:{ cadence:300, stale:900, lost:3600, label:'akasha api' }, slop:{ cadence:86400, stale:129600, lost:259200, label:'slopalytics' }, jocasta:{ cadence:300, stale:900, lost:3600, label:'jocasta' }, gh:{ cadence:120, stale:600, lost:1800, label:'github' } };
  const freshOf = (kind, age, explicit) => explicit || (age == null ? 'nosource' : age <= SOURCES[kind].stale ? 'live' : age <= SOURCES[kind].lost ? 'stale' : 'lost');

  // ---------- palette & direction ----------
  const DIR_PALETTE = { phosphor:'green-phosphor', hud:'hud-cool', muthur:'amber-phosphor', flight:'mocr-1969', approach:'cvd-contrast', cyberpunk:'cyberpunk', bellerophon:'amber-phosphor' };
  const dirParam = Q.get('dir');
  const paletteKey = PALETTES[Q.get('palette')] ? Q.get('palette') : (dirParam && DIR_PALETTE[dirParam]) || document.body.dataset.defaultPalette || PALETTE_KEYS[0];
  const P = PALETTES[paletteKey];
  for (const k of ['bg','primary','secondary','accent','ok','warn','fail','stale','dim','glow']) document.documentElement.style.setProperty('--' + k, P[k]);
  document.body.dataset.palette = paletteKey;
  const dir = dirParam || document.body.dataset.defaultDir;
  if (dir) { document.body.className = document.body.className.replace(/\bdir-\S+/g, '').trim() + ' dir-' + dir; document.body.dataset.dir = dir; }
  document.title = 'Mission control · ' + (dir || 'board') + ' · ' + paletteKey;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const still = Q.get('still') === '1';
  const setScale = () => document.documentElement.style.setProperty('--k', String(Math.min(2, Math.max(0.55, innerWidth / 1920)))); setScale();
  const portrait = () => matchMedia('(orientation: portrait)').matches;

  // ---------- time basis: one clock, fixed offset, timezone shown ----------
  const t0wall = Date.now(); const base = DATA.now.getTime();
  const now = () => new Date(base + (reduceMotion || still ? 0 : Date.now() - t0wall));
  const hhmm = d => { const z = new Date(d.getTime() + DATA.tzOffsetMin * 60e3); return z.toISOString().slice(11, 16); };
  const parseHM = s => { const [h, m] = s.split(':').map(Number); const z = new Date(base + DATA.tzOffsetMin * 60e3); z.setUTCHours(h, m, 0, 0); return z.getTime() - DATA.tzOffsetMin * 60e3; };
  const secsUntil = s => Math.round((parseHM(s) - now().getTime()) / 1000);

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  // A closed fixture dictionary, never item.title, input, arguments, output or arbitrary target text.
  const WALL_TOOLS = new Set(['read','search','navigate','edit_apply','change_plan','verify_run','chaldea exec','t3_thread_read','t3_thread_list','jocasta','watch_pull_request','html_preview','delegate_task','chaldea_decision_prepare','Command running']);
  const safeStep = s => {
    if (!s || !WALL_TOOLS.has(s.tool)) return { tool:'Activity unavailable', target:'', age:'' };
    const target = Object.hasOwn(DATA.wallTargets, s.target) ? DATA.wallTargets[s.target] : '';
    return { tool:s.tool, target, age:Number.isFinite(s.ageSeconds) && s.ageSeconds >= 0 ? ago(s.ageSeconds) : '' };
  };
  const st = (kind, label) => `<span class="st ${CLS[kind] || 'sec'}"><i>${GLYPH[kind] || '·'}</i>${label !== undefined ? esc(label) : ''}</span>`;
  const ago = s => s == null ? '—' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : s < 86400 ? `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m` : `${Math.floor(s/86400)}d`;
  const dur = ago;
  // Pure presentation state: missing samples hold the last source value. Counts settle for 10 s;
  // rates ease over 5 s. Time is explicit so fixtures and checks do not depend on wall time.
  const createDisplayState = () => {
    const held = new Map(), counts = new Map(), rates = new Map();
    return {
      source(key, value) { if (value !== undefined && value !== null) held.set(key, value); return held.get(key); },
      count(key, value, at) {
        if (!counts.has(key)) counts.set(key, { value, candidate:value, since:at });
        const s = counts.get(key);
        if (value !== s.candidate) { s.candidate = value; s.since = at; }
        if (at - s.since >= 10000) s.value = s.candidate;
        return s.value;
      },
      rate(key, value, at) {
        if (!Number.isFinite(value)) return rates.get(key)?.value;
        if (!rates.has(key)) rates.set(key, { value, at });
        const s = rates.get(key), dt = Math.max(0, at - s.at);
        s.value += (value - s.value) * (1 - Math.exp(-dt / 5000)); s.at = at;
        return s.value;
      }
    };
  };
  const display = createDisplayState();
  const displayedRate = () => {
    const rates = DATA.tokens.providers.flatMap(p => p.models.map(m => display.source('rate-' + p.id + '-' + m.id, m.rate))).filter(Number.isFinite);
    return Math.round(display.rate('all', rates.length ? rates.reduce((a,b) => a + b, 0) : undefined, performance.now()));
  };
  const compact = n => n >= 1e6 ? (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? (n/1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(n);
  const sev = (pct, w = 80, f = 95) => pct == null ? 'nosrc' : pct >= f ? 'fail' : pct >= w ? 'warn' : '';
  const FRESH_WORD = { live:'observed', stale:'stale', lost:'no data', nosource:'no source', asleep:'asleep', unsupported:'not applicable' };
  const panel = (area, title, body, kind, age, explicit, extra = '') => { const f = freshOf(kind, age, explicit);
    const chip = f === 'live' ? ago(age) : f === 'stale' ? 'stale ' + ago(age) : f === 'lost' ? 'no data ' + ago(age) : FRESH_WORD[f];
    const note = f === 'stale' ? `<div class="lastknown">Last observed ${ago(age)} ago · values are last known · source ${SOURCES[kind].label}</div>` : f === 'lost' ? `<div class="lastknown">No data for ${ago(age)} · last known values · source ${SOURCES[kind].label}</div>` : '';
    return `<section class="panel p-${area} ${extra}" data-fresh="${f}"><header><h2 data-console="${CONSOLE[area] || 'SYS'}">${esc(title)}</h2><span class="fresh" title="${SOURCES[kind].label}">${chip}</span></header><div class="body">${note}${body}</div></section>`; };
  // content budget: n rows then an explicit remainder line
  const budget = (items, n, render, what = 'more') => items.slice(0, n).map(render).join('') + (items.length > n ? `<div class="more">+${items.length - n} ${what} · showing ${n} of ${items.length}</div>` : '');

  // ---------- instruments ----------
  const stat = (v, l, cls = '', hero = false) => `<div class="stat ${cls} ${hero ? 'hero' : ''}"><div class="v num">${v}</div><div class="l">${esc(l)}</div></div>`;
  const heroStat = (v, label, unit = '', cls = '') => `<div class="stat ${cls}"><div class="v num">${esc(v)}</div><div class="unit-slot num">${esc(unit) || '&nbsp;'}</div><div class="l">${esc(label)}</div></div>`;
  const meter = (pct, cls = '', pace, thr) => pct == null ? `<div class="meter empty"></div>` : `<div class="meter ${cls}"><i class="fill" style="width:${Math.max(0, Math.min(100, pct))}%"></i>${thr != null ? `<s class="thr" style="left:${thr}%"></s>` : ''}${pace != null ? `<s class="pace" style="left:${pace}%"></s>` : ''}</div>`;
  const metric = (label, pct, value, cls = '', pace, extra = '', thr) => `<div class="metric ${cls} ${extra}"><span class="l">${label}</span>${meter(pct, cls, pace, thr)}<span class="v">${value}</span></div>`;
  const stacked = (label, pct, value, cls = '', pace, thr) => metric(label, pct, value, cls, pace, 'stack', thr);
  const spark = (pts, cls = '') => { const w = 100, h = 30, max = Math.max(1, ...pts), n = pts.length;
    const xy = pts.map((v, i) => [i / (n - 1) * w, h - 2 - v / max * (h - 4)]);
    const d = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<div class="sparkwrap ${cls}"><svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="base" d="M0 ${h - 1} L${w} ${h - 1}"/><path d="${d}"/></svg><i class="dot" style="top:${(xy[n - 1][1] / h * 100).toFixed(1)}%"></i></div>`; };
  const gauge = (pct, cls, pace, big, small) => { const r = 46, cx = 60, cy = 60, A = Math.PI;
    const arc = (from, to) => { const x1 = cx + r * Math.cos(from), y1 = cy + r * Math.sin(from), x2 = cx + r * Math.cos(to), y2 = cy + r * Math.sin(to); return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > A ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`; };
    const tick = q => { const a = A + A * q; return `<line class="tick" x1="${(cx + (r - 5) * Math.cos(a)).toFixed(1)}" y1="${(cy + (r - 5) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r + 5) * Math.cos(a)).toFixed(1)}" y2="${(cy + (r + 5) * Math.sin(a)).toFixed(1)}"/>`; };
    const pl = pace != null ? (() => { const a = A + A * pace / 100; return `<line class="pace" x1="${(cx + (r - 9) * Math.cos(a)).toFixed(1)}" y1="${(cy + (r - 9) * Math.sin(a)).toFixed(1)}" x2="${(cx + (r + 9) * Math.cos(a)).toFixed(1)}" y2="${(cy + (r + 9) * Math.sin(a)).toFixed(1)}"/>`; })() : '';
    return `<div class="gauge ${cls}"><svg viewBox="0 0 120 66"><path class="track" d="${arc(A, 2 * A)}"/>${pct ? `<path class="fillarc" d="${arc(A, A + A * Math.min(100, pct) / 100 - 0.001)}"/>` : ''}${[0.25, 0.5, 0.75].map(tick).join('')}${pl}</svg><div class="big">${big}</div><div class="small">${small}</div></div>`; };
  // columns: fixed domain (max), zero baseline, empty positions for missing/future, partial current period hatched
  const colsChart = (vals, { max, nowIdx = -1, axis = [], yl = v => String(v), unitMax } = {}) => { const M = max || Math.max(1, ...vals.filter(v => v != null));
    return `<div class="cols"><div class="y"><span>${yl(unitMax || M)}</span><span>${yl((unitMax || M) / 2)}</span><span>0</span></div><div class="plot">${vals.map((v, i) => v == null ? `<b class="empty"></b>` : `<b class="${i === nowIdx ? 'now' : ''}" style="height:${(Math.min(M, v) / M * 100).toFixed(1)}%"></b>`).join('')}</div><div class="axis">${axis.map(a => `<span>${a}</span>`).join('')}</div></div>`; };
  const lamp = (cls, label, word) => `<span class="lamp ${cls}"><i></i>${esc(label)}${word ? ` <span class="w">${esc(word)}</span>` : ''}</span>`;
  const slots = h => { let s = ''; for (let i = 0; i < h.slots; i++) s += `<b class="${i < h.used ? 'on' : ''}"></b>`; for (let i = 0; i < h.queue; i++) s += `<b class="q"></b>`; return `<span class="slots">${s}</span>`; };
  const classOf = cls => ({ 'use-it':'ok', unlimited:'ok', paced:'pri', tight:'warn', stopped:'fail', unknown:'stale' }[cls] || '');
  const chip = m => `<span class="chip">${esc(m)}</span>`;

  // ---------- shared fragments ----------
  const live = () => DATA.threads.filter(t => t.state !== 'idle');
  const decisionsSorted = () => DATA.decisions.map(d => ({ ...d, left: secsUntil(d.deadline) })).sort((a, b) => a.left - b.left);
  const inboxList = (n = 3, withSource = true) => { const ds = decisionsSorted(); return ds.length ? budget(ds, n, d => `<div class="item q"><div class="l1"><span class="t two">${st('decision')} ${esc(d.q)}</span></div><div class="l2"><span>due in <b class="num">${dur(d.left)}</b> · ${d.deadline}</span><span>default: <b>${esc(d.def)}</b></span>${withSource ? `<span>${esc(d.from)}</span>` : ''}</div></div>`, 'decisions') : '<div class="muted">Nothing waiting on you</div>'; };
  const threadRows = (n) => { const ts = live(); return budget(ts, n, t => { const activity = safeStep(t.steps?.[0]); return `<div class="row thread">${st(t.state)}<span class="ell b">${esc(t.title)}</span><span class="num faint t1">${ago(t.observed)}</span><span class="meta"><span>${STATE_LABEL[t.state]}${t.state.startsWith('waiting') ? ' · ' + dur(t.age) : ''}</span><span>${esc(t.model)} · ${esc(t.host)}</span><span class="ell">${esc(activity.tool)} ${esc(activity.target)}</span></span></div>`; }, 'threads'); };
  const verdictOf = p => p.verdict.startsWith('accept') ? ['merge', 'Review: accepted'] : p.verdict.startsWith('block') || p.verdict.startsWith('fix') ? ['alert', 'Review: blocked · ' + p.verdict] : p.verdict.startsWith('await') ? ['canary', 'Review: not yet'] : ['canary', p.verdict];
  const prRows = (list, n) => budget(list, n, p => { const [k, w] = verdictOf(p); return `<div class="row pr"><span class="num muted">#${p.n}</span><span class="ell b">${esc(p.title)}</span><span class="meta">${st(k, w)}${lamp(p.ci === 'pass' ? 'ok' : p.ci === 'fail' ? 'fail' : 'warn', 'CI', p.ci === 'pass' ? 'passed' : p.ci === 'fail' ? 'failed' : 'running')}<span class="ell">${esc(p.repo)} · ${esc(p.author)} · ${p.age}</span></span></div>`; }, 'PRs');
  const eventsIn6h = () => { const cut = now().getTime() - 6 * 3600e3; return DATA.events.filter(e => parseHM(e.t) >= cut); };
  const eventRows = (list, n) => budget(list, n, e => `<div class="row ev ${e.hot ? 'hot' : ''}"><span class="t">${e.t}</span>${st(e.type)}<span class="text ell"><b>${esc(e.type)}</b> ${esc(e.text)}</span></div>`, 'events');
  const expiringRows = (n) => budget(DATA.expiring, n, x => stacked(esc(x.what), x.pct, `${x.left} · ${esc(x.at)}`, sev(x.pct, 75, 90)), 'expiring');
  const incidents = () => DATA.incidents.filter(i => i.sev !== 'ok');

  // ---------- renderers ----------
  const R = {};
  R.overview = () => {
    const working = live().filter(t => t.state === 'working').length, waiting = live().filter(t => t.state.startsWith('waiting')).length;
    const awake = DATA.hosts.filter(h => h.up); const used = awake.reduce((a, h) => a + h.used, 0), cap = awake.reduce((a, h) => a + h.slots, 0), queue = DATA.hosts.reduce((a, h) => a + h.queue, 0);
    const rate = displayedRate();
    const inc = incidents().length, dec = decisionsSorted();
    const kpi = `<div class="stats hero-row">${heroStat(dec.length, 'needs Igor', '', dec.length ? 'warn' : '')}${heroStat(inc, 'open incidents', '', inc ? 'fail' : '')}${heroStat(working, 'working')}${heroStat(waiting, 'waiting', '', waiting ? 'warn' : '')}${heroStat(used, 'exec slots', 'of ' + cap + ' awake')}${heroStat(queue, 'queued jobs', '', queue ? 'warn' : '')}${heroStat(rate.toLocaleString('en-US'), 'output rate', 'tok/s · 60 s avg')}${heroStat(DATA.shipped.length, 'shipped today')}</div>
      ${dec.length ? `<div class="kpi-deadline"><span class="cap">earliest deadline · in ${dur(dec[0].left)}</span><span class="t two">${esc(dec[0].q)}</span><span class="t1 muted">default: ${esc(dec[0].def)} · ${dec[0].deadline} ${DATA.tz}</span></div>` : ''}`;
    const hosts = budget(DATA.hosts, 4, h => `<div class="host"><div class="head"><span class="name">${esc(h.label)}</span><span class="kind">${esc(h.kind)}</span>${h.up ? slots(h) : ''}${h.queue ? `<span class="faint num">+${h.queue}</span>` : ''}</div>
      ${h.up ? `${metric('cpu', null, '—<span class="unit">no source</span>', 'nosrc')}${metric('ram', null, '—<span class="unit">no source</span>', 'nosrc')}${h.gpu != null ? metric('vram', null, '—<span class="unit">no source</span>', 'nosrc') : ''}` : `<div>${lamp('off', 'laptop', 'not observed')} <span class="t1 muted">no probe yet · last converge 2h ago</span></div>`}
      <div class="foot"><span>threads <b class="num">${DATA.threads.filter(t => t.host === h.id).length}</b></span>${h.gate ? `<span>game gate: <b class="warnc">no source</b></span>` : ''}${h.converge ? `<span>converge ${esc(h.converge)}</span>` : ''}</div></div>`, 'hosts');
    const blocked = DATA.prs.filter(p => /block|fix|await/.test(p.verdict));
    const threads = threadRows(4) + `<div class="sub">PRs needing attention · ${blocked.length} of ${DATA.prs.length} in flight</div>` + prRows(blocked, 2);
    const quota = budget(DATA.accounts, 6, a => `<div class="acct"><div class="head"><span class="n">${esc(a.id)}</span>${st(a.cls, a.cls)}</div>${a.used != null ? stacked('used of window', a.used, `${a.used}<span class="unit">%</span> · clock ${a.pace}%`, classOf(a.cls) === 'pri' ? sev(a.used) : classOf(a.cls), a.pace) : a.cls === 'unlimited' ? `<div class="t1 muted">credit balance unlimited · no window</div>` : `<div class="t1 muted">quota not applicable · local model</div>`}${a.used != null ? `<div class="t1 muted">reset in <b class="num">${a.reset}</b></div>` : ''}</div>`, 'accounts');
    const evs = eventsIn6h();
    const events = budget(evs, 2, e => `<div class="item"><div class="l1"><span class="t two t2" style="font-size:var(--t2)">${st(e.type)} ${esc(e.text)}</span></div><div class="l2"><span class="num">${e.t}</span><span>${esc(e.host)}</span></div></div>`, 'events') ;
    return panel('kpi', 'Fleet', kpi, 't3shell', 2) + panel('inbox', 'Waiting on Igor', inboxList(2), 'feed', 6) + panel('threads', 'Threads · ' + live().length + ' live', threads, 't3shell', 1)
      + panel('hosts', 'Hosts · exec slots', hosts, 'exec', 4) + panel('quota', 'Quota', quota, 'quota', 252) + panel('events', 'Latest events', events, 'feed', 48);
  };

  // Agents: count-based density. Tiers 1 / 4 / 12 / 24 / 48, page beyond 48 (8 per page in portrait).
  const agentSet = () => { const n = DATA.demo ? parseInt(Q.get('agents'), 10) : 0; if (!n) return DATA.threads; const pool = DATA.agentPool; return Array.from({ length: Math.max(1, Math.min(480, n)) }, (_, i) => ({ ...pool[i % pool.length], id: 'a' + i, title: pool[i % pool.length].title + (i >= pool.length ? ' (' + (Math.floor(i / pool.length) + 1) + ')' : '') })); };
  const tierOf = n => n <= 1 ? 1 : n <= 4 ? 4 : n <= 12 ? 12 : n <= 24 ? 24 : 48;
  let agentPage = 0;
  R.agents = () => {
    const incoming = agentSet(); const all = !DATA.demo ? incoming : display.source('agents', incoming.length === display.count('agents', incoming.length, performance.now()) ? incoming : null) || incoming;
    const per = portrait() ? 8 : 48; const pages = Math.max(1, Math.ceil(all.length / per)); agentPage = Math.min(agentPage, pages - 1);
    const shown = all.slice(agentPage * per, agentPage * per + per); const tier = tierOf(all.length);
    const count = k => all.filter(a => a.state === k).length;
    const summary = `<div class="agents-summary"><span class="t">${all.length} agent${all.length === 1 ? '' : 's'}</span>${st('working', count('working') + ' working')}${st('waiting-igor', count('waiting-igor') + ' waiting for Igor')}${st('waiting-ci', count('waiting-ci') + ' waiting for CI')}${count('failed') ? st('failed', count('failed') + ' failed') : ''}${count('idle') ? st('idle', count('idle') + ' idle') : ''}<span class="muted t1">hosts awake ${DATA.hosts.filter(h => h.up).length} of ${DATA.hosts.length} · laptop not observed</span>${pages > 1 ? `<span class="pg">${agentPage * per + 1}–${agentPage * per + shown.length} of ${all.length} · page ${agentPage + 1}/${pages}</span>` : ''}</div>`;
    const step = item => { const s = safeStep(item); return `<span class="tool">${esc(s.tool)}</span><span class="tgt ell">${esc(s.target)}</span><span class="el num">${esc(s.age)}</span>`; };
    const tiles = shown.map(a => { const steps = a.steps || []; return `<section class="panel tile ${a.state}" data-fresh="${a.activityFreshness === 'live' ? 'live' : a.activityFreshness === 'nosource' ? 'nosource' : freshOf('t3thread', a.observed) === 'lost' ? 'lost' : 'stale'}"><header><h2 data-console="${esc(a.host.toUpperCase())}">${esc(a.title)}</h2><span class="fresh">${a.activityFreshness === 'live' ? ago(a.observed) : esc(a.activityFreshness || 'unknown') + ' · ' + ago(a.observed)}</span></header><div class="body">
      <div class="title two agrid-c24-only">${esc(a.title)}</div>
      <div class="state">${st(a.state, STATE_LABEL[a.state] + (a.state.startsWith('waiting') ? a.age == null ? ' · duration unknown' : ' · ' + dur(a.age) : ''))}</div>
      <div class="act ell">${step(steps[0])}</div>
      <div class="tail">${steps.slice(1).map(x => `<div class="ell">${step(x)}</div>`).join('')}</div>
      <div class="meta"><span class="host-name">${esc(a.host)}</span><span class="num">run ${dur(a.run)}</span><span class="model">${esc(a.model)} · ${esc(a.effortx || a.effort || 'high')}</span><span class="observed num">activity ${ago(a.observed)} ago · source ${ago(a.sourceObserved ?? a.observed)} ago</span></div></div></section>`; }).join('');
    return `<section class="panel p-summary"><header><h2 data-console="FLIGHT">Agents</h2><span class="fresh">${ago(DATA.demo ? 1 : DATA.agentSourceAge)}</span></header><div class="body">${summary}</div></section><div class="agrid c${tier}">${tiles}</div>`;
  };

  R.fleet = () => {
    const rel = { chaldea:'chaldea', host:'release', huyang:'Huyang', t3:'T3', cli:'agent CLI' };
    const config = budget(DATA.fleet, 4, f => { const drifts = Object.keys(rel).filter(r => f.releases[r][0] !== f.releases[r][1]); const canary = drifts.filter(r => /canary/.test(f.releases[r][1])); const real = drifts.filter(r => !/canary/.test(f.releases[r][1]));
      return `<div class="hostrow"><span class="name">${esc(f.host)}</span><span class="sum ell">${real.length ? st('warn', real.length + ' drifting') : st('ok', 'aligned')}${canary.length ? st('canary', 'canary') : ''}<span class="muted">converged ${f.converge.at} ${DATA.tz} · ${f.converge.outcome === 'ok' ? f.converge.changed + ' changed' : '<b class="warnc">' + esc(f.converge.outcome) + '</b>'}</span></span><span class="num muted t1">${f.releases.host[1]}</span>
      ${real.length ? `<span class="drift">${real.map(r => `${rel[r]} ${esc(f.releases[r][1])} → ${esc(f.releases[r][0])}`).join(' · ')}${f.held.length ? ' · <b>held:</b> ' + f.held.map(esc).join(' · ') : ''}</span>` : f.held.length ? `<span class="drift">held: ${f.held.map(esc).join(' · ')}</span>` : ''}
      ${canary.length ? `<span class="roles"><b>authorized canary</b> ${canary.map(r => `${rel[r]} ${esc(f.releases[r][1])}`).join(' · ')}</span>` : ''}
      <span class="roles"><b>roles</b> ${f.roles.map(esc).join(' · ')}</span></div>`; }, 'hosts')
      + `<div class="more">full version matrix on PC and iPad detail · source: fleet-config converge report per host</div>`;
    const roll = budget(DATA.rollouts.filter(r => r.missing.length), 4, r => `<div class="item"><div class="l1"><span class="t ell" style="font-size:var(--t2)">${st('warn')} ${esc(r.what)}</span></div><div class="l2"><span>not on <b>${r.missing.join(', ')}</b></span>${r.note ? `<span>${esc(r.note)}</span>` : ''}</div></div>`, 'rollouts')
      + `<div class="more">${DATA.rollouts.filter(r => !r.missing.length).map(r => esc(r.what)).join(', ')} · everywhere</div><div class="sub">held enablement</div>` + DATA.fleet.flatMap(f => f.held.map(h => `<div class="row" style="grid-template-columns:6em minmax(0,1fr)"><span class="muted">${esc(f.host)}</span><span class="warnc ell">${esc(h)}</span></div>`)).join('');
    const t = DATA.trust;
    const trust = `<div class="stats">${stat(t.expires, 'bundle expires in', 'warn')}${stat(`${lamp(t.publisher.ok ? 'ok' : 'fail', '', t.publisher.ok ? 'up' : 'down')}`, 'publisher · ' + t.publisher.age + ' ago', '')}</div><div class="hr"></div><dl class="kv"><dt>hosts verified</dt><dd>4 / 4 · 14:10 ${DATA.tz}</dd><dt>bundle sequence</dt><dd>${t.seq}</dd><dt>bundle age</dt><dd>${t.age}</dd><dt>tokens minted today</dt><dd>${t.minted}</dd><dt>anchor kid</dt><dd>${esc(t.kid)}</dd><dt>anchor rotation due</dt><dd>09 Nov · 22d</dd><dt>published by</dt><dd>homelab · trust-publisher</dd></dl>`;
    const timers = budget(DATA.fleet, 4, f => f.next === 'held' ? `<div class="row" style="grid-template-columns:7em minmax(0,1fr) auto"><span class="b">${esc(f.host)}</span><span class="warnc">held · waiting on decision</span><span class="num muted">—</span></div>` : f.next === 'asleep' ? `<div class="row" style="grid-template-columns:7em minmax(0,1fr) auto"><span class="b">${esc(f.host)}</span><span class="muted">not observed · runs on wake</span><span class="num muted">—</span></div>` : stacked(`<b>${esc(f.host)}</b>`, 100 - Math.max(0, secsUntil(f.next)) / 36, `in ${dur(Math.max(0, secsUntil(f.next)))} · ${f.next} ${DATA.tz}`, 'pri'), 'hosts') + `<div class="more">bar = share of the 60 min pull interval elapsed · source: systemd timer per host</div>`;
    const pres = DATA.presence;
    const expiring = expiringRows(4) + `<div class="more">bar = share of each item's own lifetime elapsed · soonest first</div><div class="hr"></div><div class="row" style="grid-template-columns:auto minmax(0,1fr)">${lamp('off', 'laptop', 'not observed')}<span class="muted t1">${esc(pres.laptop)}</span></div><div class="row" style="grid-template-columns:auto minmax(0,1fr)">${lamp('off', 'game gate', 'no source')}<span class="muted t1">host telemetry not connected</span></div>`;
    return panel('config', 'Fleet config · drift vs pins', config, 'fleet', 70) + panel('rollouts', 'Rollouts pending', roll, 'fleet', 70) + panel('trust', 'Trust', trust, 'gatus', 120) + panel('timers', 'Next pull timer', timers, 'fleet', 70) + panel('expiring', 'Expiring · presence', expiring, 'fleet', 60);
  };

  R.tokens = () => {
    const all = DATA.tokens.providers.flatMap(p => p.models);
    const rate = displayedRate(), today = all.reduce((a, m) => a + m.today, 0);
    const hero = `<div class="stats">${stat(rate.toLocaleString(), 'output tok/s · 60 s avg · all providers', '', true)}${stat(compact(today), 'output tokens today')}${DATA.tokens.providers.map(p => stat(compact(p.models.reduce((a, m) => a + m.today, 0)), p.label + ' today')).join('')}</div>`;
    const models = DATA.tokens.providers.map(p => `<div class="sub">${esc(p.label)}</div>${p.models.map(m => `<div class="row mrow ${m.rate == null ? 'nodata' : ''}"><span class="ell">${esc(m.label)}</span><span class="rate num">${m.rate == null ? '—' : m.rate}<span class="unit">${m.rate == null ? 'no data' : 'tok/s'}</span></span>${spark(m.spark)}<span class="today num">${compact(m.today)}</span></div>`).join('')}`).join('') + `<div class="more">rate = output tokens per second, 60 s average from provider-turn updates (2–33 s apart) · sparkline 30 min, each on its own scale · today = output tokens since 00:00 ${DATA.tz}</div>`;
    const hb = DATA.tokens.hourly.map((v, i) => i > 17 ? null : v); const max = Math.ceil(Math.max(...hb.filter(v => v != null)) / 100) * 100;
    const hourly = `<div class="grow" style="display:flex;flex-direction:column"><div class="grow">${colsChart(hb, { max, nowIdx:17, axis:['00', '06', '12', '18', '24'], yl: v => v + 'K' })}</div><div class="more">K output tokens per hour · 17 Oct ${DATA.tz} · hatched = current hour, partial</div></div>`;
    return panel('thero', 'Token rate', hero, 't3thread', 2) + panel('models', 'By model', models, 't3thread', 2) + panel('hourly', 'Today by hour', hourly, 't3thread', 60);
  };

  const hist = a => { let x = 0; return Array.from({ length: 14 }, (_, i) => { x = (x * 9301 + 49297 + i * a.id.length) % 233280; return i === 13 ? a.used : Math.round(20 + (x / 233280) * (a.cls === 'stopped' ? 80 : 60)); }); };
  R.quota = () => budget(DATA.accounts, 6, a => {
    const cls = classOf(a.cls) === 'pri' ? (sev(a.used) || 'pri') : classOf(a.cls);
    const measurable = a.used != null;
    if (!measurable) { const body = `<div class="acard compact"><div class="facts"><div>${st(a.cls, a.cls)}</div><div class="use">${a.cls === 'unlimited' ? '<b>Credit balance unlimited</b> · no usage window on this account' : '<b>Quota not applicable</b> · local model, no provider limit'}</div><dl class="kv"><dt>source</dt><dd>${a.fresh === 'live' ? 'chaldea quota · ' + ago(a.age) + ' ago' : 'none'}</dd><dt>manual resets</dt><dd>n/a</dd></dl></div></div>`; return panel('acct', a.id, body, 'quota', a.age, a.cls === 'unknown' ? 'unsupported' : undefined); }
    const g = gauge(a.used, cls, a.pace, a.used + '%', 'used · 5 h window');
    const body = `<div class="acard">${g}<div class="facts"><div>${st(a.cls, a.cls)}</div><div class="use"><b>${a.used}% used</b> · clock ${a.pace}% · <b class="${a.used - a.pace > 0 ? 'warnc' : 'okc'}">${a.used - a.pace > 0 ? '+' : ''}${a.used - a.pace} pp</b></div><div>Reset in <b class="num">${a.reset}</b> · weekly in <b class="num">${a.weekly.split(' · ')[1]}</b></div>
      ${a.credits ? `<div>Credits <b class="num">USD ${a.credits[0]}</b> remaining of ${a.credits[1]} · expire ${a.creditsExpire}</div>` : ''}<div class="t1 muted">${a.manualResets} manual reset${a.manualResets === 1 ? '' : 's'} available · governing limit: 5 h window · ${a.fresh === 'live' ? 'chaldea quota' : 'app-server'} ${ago(a.age)} ago</div></div>
      <div class="spacer"></div><div class="hist"><span class="cap">used % at window end · 13 past windows + current (hatched, partial)</span>${colsChart(hist(a), { max:100, nowIdx:13, axis:['−13 windows', '−7', 'now'], yl: v => v + '%' })}</div></div>`;
    return panel('acct', a.id, body, 'quota', a.age);
  }, 'accounts');

  R.events = () => {
    const evs = eventsIn6h(); const inc = incidents();
    const counts = `<div class="stats">${['merge','deploy','alert','canary','decision'].map(k => stat(evs.filter(e => e.type === k).length, k + ' events · 6 h', k === 'alert' ? 'fail' : k === 'decision' ? 'warn' : '')).join('')}${stat(inc.length, 'unresolved incidents', inc.length ? 'fail' : '')}${stat(DATA.waits.length, 'active waits now')}</div>`;
    const tl = `<div class="tl">${evs.slice(0, 10).map(e => `<div class="t">${e.t}</div><div class="g">${st(e.type)}</div><div class="x ${e.hot ? 'hot' : ''}"><b>${esc(e.type)}</b> ${esc(e.text)}<small>${esc(e.host)}</small></div>`).join('')}</div>${evs.length > 10 ? `<div class="more">showing 10 of ${evs.length} in the last 6 h · ${DATA.tz}</div>` : `<div class="more">${evs.length} events in the last 6 h · ${DATA.tz}</div>`}`;
    const waits = budget(DATA.waits, 4, w => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto auto"><span class="ell">${esc(w.what)}</span><span class="num muted t1">fires ${esc(w.at)} ${DATA.tz}</span><span class="num b">in ${esc(w.left)}</span></div>`, 'waits');
    return panel('ecount', 'Last 6 hours · ' + hhmm(new Date(now().getTime() - 6 * 3600e3)) + '–' + hhmm(now()) + ' ' + DATA.tz, counts, 'feed', 48) + panel('timeline', 'Timeline · fleet feed', tl, 'feed', 48) + panel('einbox', 'Waiting on Igor · by deadline', inboxList(3, false), 'feed', 6) + panel('waits', 'Chaldea waits', waits, 'feed', 9);
  };

  R.ops = () => {
    const inc = incidents(); const top = inc[0];
    const incBody = (top ? `<div class="item"><div class="l1"><span class="t two">${st(top.sev)} ${esc(top.what)}</span></div><div class="l2"><span>${esc(top.host)}</span><span>open for <b>${esc(top.age)}</b></span><span>offsite limit 26 h · observed 44m ago</span></div></div>` : '<div class="muted">No unresolved incidents</div>')
      + budget(inc.slice(1), 3, i => `<div class="row inc">${st(i.sev)}<span class="ell">${esc(i.what)}</span><span class="num muted t1">${esc(i.age)}</span><span class="meta">${esc(i.host)}</span></div>`, 'incidents') + `<div class="more">retention last night: ${esc(DATA.incidents.find(i => i.sev === 'ok').what)}</div>`;
    const prs = prRows(DATA.prs, 4) + `<div class="sub">shipped today · ${DATA.shipped.length}</div>` + budget(DATA.shipped, 3, s => `<div class="row" style="grid-template-columns:1fr">${st('merge', s)}</div>`, 'shipped');
    const ak = DATA.akashaMore;
    const backups = `<div class="item"><div class="l1"><span class="t two keep">${st('fail')} Offsite backup late</span></div><div class="l2"><span>last known age <b class="keep">31 h</b> · limit 26 h</span><span>observed 3m ago</span></div></div>
      <div class="sub">ages · fixed 0–48 h scale · threshold 26 h</div>${stacked('offsite age', 31 / 48 * 100, '31 h', 'fail', undefined, 26 / 48 * 100)}${stacked('local backup age', 15 / 48 * 100, '15 h · 02:10 · 1.2 GB', 'ok', undefined, 26 / 48 * 100)}
      <div class="sub">next parity check</div>${stacked('3-day parity clock', ak.parityPct, ak.parityLeft + ' left', 'pri')}<div class="hr"></div><div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span class="muted">Akasha ingest rate</span><span class="num muted">— no source</span></div><div class="t1 muted">ingest and backlog need the token-gated Akasha API · not connected</div>`;
    const svcs = DATA.services.map(([n, ok]) => ({ n, ok })).sort((a, b) => a.ok - b.ok);
    const health = `<div class="stats">${stat(`${svcs.filter(s => s.ok).length}<span class="unit">/ ${svcs.length}</span>`, 'services up · degraded', svcs.every(s => s.ok) ? 'ok' : 'warn')}${stat(DATA.gatus.filter(g => !g.ok).length, 'heartbeats late', 'fail')}</div><div class="svc">${DATA.gatus.map(g => lamp(g.ok ? 'ok' : 'fail', g.id, g.ok ? 'up' : 'late')).join('')}${svcs.filter(s => !DATA.gatus.some(g => g.id.startsWith(s.n))).map(s => lamp(s.ok ? 'ok' : 'fail', s.n, s.ok ? 'up' : 'down')).join('')}</div>`;
    const tree = budget(DATA.tasks, 6, t => `<div class="row d${t.d}"><span class="ell b">${esc(t.title)}</span>${st(/block|fail/.test(t.verdict) ? 'alert' : /accept|done/.test(t.verdict) ? 'merge' : 'canary', t.verdict)}<span class="meta">${esc(t.model)} · ${esc(t.repo)} · ${esc(t.dur)}${t.round ? ' · round ' + esc(t.round) : ''}</span></div>`, 'tasks');
    return panel('incidents', 'Unresolved incidents · ' + inc.length, incBody, 'gatus', 15) + panel('prs', 'PRs in flight · ' + DATA.prs.length, prs, 'gh', 22) + panel('backups', 'Backups · Akasha', backups, 'gatus', 15) + panel('health', 'Homelab health', health, 'gatus', 15) + panel('tasks', 'Delegated task lineage', `<div class="rows tree">${tree}</div>`, 'feed', 9);
  };

  R.lab = () => {
    const r = DATA.routing; const roles = ['builder', 'critical review', 'bulk read', 'general'];
    const cell = (prov, role) => { const c = r.byProvider[prov][role]; return c && c.model ? `<div class="cell"><span class="m">${esc(c.model)}</span><span class="eff">effort ${esc(c.effort)}</span></div>` : `<div class="cell"><span class="m warnc">Unavailable</span><span class="why">${esc(c && c.reason || 'not configured')}</span></div>`; };
    const routing = `<div class="tbl rmat"><span class="h">role</span><span class="h">Claude</span><span class="h">Codex</span>${roles.map(role => `<span class="b">${esc(role)}</span>${cell('claude', role)}${cell('codex', role)}`).join('')}</div><div class="more">${esc(r.scope)} · observed ${ago(r.observed)} ago · source: chaldea route --json byProvider</div>
      <div class="sub">recent changes</div>${budget(r.changes, 3, c => `<div class="row" style="grid-template-columns:5.5em minmax(0,1fr)"><span class="num faint t1">${esc(c[0])}</span><span class="ell"><b>${esc(c[1])} · ${esc(c[2])}</b> ${esc(c[3])} → ${esc(c[4])} <span class="muted">· ${esc(c[5])}</span></span></div>`, 'changes')}
      <div class="sub">in probation</div>${r.probation.map(([m, why]) => `<div class="row" style="grid-template-columns:auto minmax(0,1fr)">${st('warn', m)}<span class="muted ell">${esc(why)}</span></div>`).join('')}`;
    const board = `<div class="rows lb">${budget(DATA.leaderboard, 7, m => metric(esc(m.model), m.done, `${m.done}%<small>${m.fail}%</small><i>n ${m.n}</i>`, m.fail >= 7 ? 'warn' : 'pri', undefined, '', 90), 'models')}</div><div class="more">completed % · failed % in fail colour · n tasks · 11–17 Oct · remainder interrupted · fixed 0–100 % scale · tick = 90 % routing floor · task mixes differ, not a quality ranking</div>`;
    const e = DATA.evalRun;
    const ev = `<div class="stats">${stat(`${e.done}<span class="unit">/ ${e.total} tests</span>`, e.model + ' · suite slop-eval v3')}${stat(Math.round(e.done * e.pass / 100) + '<span class="unit">passed</span>', 'of ' + e.done + ' evaluated · ' + e.pass + ' %', e.pass < 85 ? 'warn' : '')}</div>${stacked('tests evaluated', e.done / e.total * 100, `${Math.round(e.done / e.total * 100)}% · batch 7 of 9`, 'pri')}<div class="t1 muted">ETA ~${e.eta} (estimated from batch pace) · host agent-b · job j-8e07</div>
      <div class="sub">pass rate by batch · fixed 0–100 %</div><div style="height:calc(var(--u) * 5)">${colsChart([92, 90, 91, 86, 89, 88, 88, null, null], { max:100, nowIdx:6, axis:['b1', 'b5', 'b9'], yl: v => v + '%' })}</div>`;
    const hh = budget(DATA.huyangHosts, 4, h => `<div class="row" style="grid-template-columns:7em 4.5em minmax(0,1fr)"><span class="b">${esc(h.host)}</span><span class="num muted">${esc(h.ver)}</span><span class="ell ${h.prov > 8 || h.ref > 4 ? 'warnc' : 'muted'}">${h.prov != null ? `provisional ${h.prov}% · ${h.ref} refusal${h.ref === 1 ? '' : 's'} today` : 'not observed'} <span class="faint">· ${h.ls.join(' ')}</span></span></div>`, 'hosts') + `<div class="hr"></div><div class="stats">${stat(DATA.huyang.edits, 'edits today')}${stat(DATA.huyang.provisional + '<span class="unit">%</span>', 'provisional')}${stat(DATA.huyang.refusals, 'refusals', 'warn')}</div><div class="more">source: Huyang diagnostics per host · today ${DATA.tz}</div>`;
    const a = DATA.audit;
    const audit = `<div class="stats">${stat(a.since, 'milestones since audit')}${stat(a.plan, 'plan revision')}</div><div class="t1 muted">last audit ${a.last} · next trigger: ${esc(a.next)}</div><div class="sub">roadmap lanes · current milestone</div>${a.lanes.map(l => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><span class="ell"><b>${esc(l[0])}</b></span><span class="muted">at ${esc(l[1])}${l[0] === 'mission control' ? ' · round 4' : ''}</span></div>`).join('')}<div class="more">source: Jocasta plan documents · no percentage, milestones are not telemetry</div>`;
    return panel('routing', 'Routing · selected model per role', routing, 'fleet', 40) + panel('board', 'Slopalytics leaderboard · this week', board, 'slop', 300) + panel('eval', 'Local model eval', ev, 'exec', 9) + panel('huyang', 'Huyang · per host', hh, 'fleet', 40) + panel('audit', 'Audit · roadmap', audit, 'jocasta', 600);
  };

  // ---------- navigation ----------
  const view = $('#view'), tabs = $('#tabs'), pick = $('#pick'), navstate = $('#navstate');
  const pinned = MODES.includes(Q.get('mode')) ? Q.get('mode') : (MODES.includes(document.body.dataset.defaultMode) ? document.body.dataset.defaultMode : null);
  const cycle = false; // PC canary modes stay explicitly selected.
  const seq = Q.get('more') === '0' ? MODES.filter(m => !MORE.has(m)) : MODES;
  let cur = pinned || seq[0], t0 = performance.now(), holdUntil = 0;
  tabs.innerHTML = MODES.map(m => `<button data-m="${m}">${LABEL[m]}<span class="bar"><i></i></span></button>`).join('');
  pick.innerHTML = MODES.map(m => `<option value="${m}">${LABEL[m]}</option>`).join('');
  const modeFromURL = () => { const m = new URLSearchParams(location.search).get('mode'); return MODES.includes(m) ? m : 'overview'; };
  const select = m => { show(m, true); hold(); };
  const hold = () => { holdUntil = performance.now() + 10 * 60e3; };
  tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; select(b.dataset.m); });
  pick.addEventListener('change', () => { select(pick.value); });
  document.addEventListener('keydown', e => { const i = parseInt(e.key, 10); if (i >= 1 && i <= MODES.length) { select(MODES[i - 1]); } if (e.key === 'ArrowRight' && cur === 'agents') { agentPage++; show('agents'); hold(); } if (e.key === 'ArrowLeft' && cur === 'agents') { agentPage = Math.max(0, agentPage - 1); show('agents'); hold(); } });
  function show(m, navigate = false) {
    if (!MODES.includes(m)) m = 'overview';
    if (navigate && m !== modeFromURL()) {
      const url = new URL(location.href); url.searchParams.set('mode', m);
      history.pushState(null, '', url.href);
    }
    cur = m; t0 = performance.now(); view.className = m === 'agent-summary' ? 'agents' : m; view.innerHTML = R[m]();
    for (const b of tabs.children) {
      const selected = b.dataset.m === m;
      b.classList.toggle('on', selected);
      b.querySelector('.bar i').style.width = selected && !cycle ? '100%' : '0%';
      if (selected) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    }
    pick.value = m; document.body.dataset.mode = m;
    document.dispatchEvent(new CustomEvent('mc:mode', { detail: m }));
  }
  addEventListener('popstate', () => show(modeFromURL()));
  function urgent() { const dec = decisionsSorted(), inc = incidents(); $('#urgent').innerHTML = `${dec.length ? st('decision', dec.length + ' for Igor · ' + dur(dec[0].left)) : ''}${inc.length ? st('alert', inc.length + ' incident' + (inc.length === 1 ? '' : 's')) : ''}`; }
  function globalFresh() { const s = DATA.sources; const stale = s.filter(x => freshOf(x.kind, x.age, x.state) === 'stale').length, lost = s.filter(x => freshOf(x.kind, x.age, x.state) === 'lost').length, unavailable = s.filter(x => ['nosource', 'unsupported'].includes(freshOf(x.kind, x.age, x.state))).length, asleep = s.filter(x => x.state === 'asleep').length;
    $('#globalfresh').innerHTML = `${st('ok', 'feed')}<span class="muted">${[[stale, 'stale'], [lost, 'lost'], [unavailable, 'n/a'], [asleep, 'asleep']].filter(x => x[0]).map(x => x[0] + ' ' + x[1]).join(' · ') || 'all sources live'}</span>`; if (DATA.demo && !$('#top .demo')) $('#top .brand').insertAdjacentHTML('beforeend', ' <span class="demo">DEMO DATA</span>'); }
  show('overview'); urgent(); globalFresh(); // Boot safely before canary renderers are installed.
  function tick() { const el = (performance.now() - t0) / 1000, d = DWELL[cur]; const b = tabs.querySelector('.on .bar i'); if (b) b.style.width = cycle ? Math.min(100, el / d * 100) + '%' : '100%';
    const holding = performance.now() < holdUntil; navstate.textContent = pinned ? '' : !cycle ? 'Auto off' : holding ? 'Pinned · ' + Math.ceil((holdUntil - performance.now()) / 60e3) + ' min' : 'Auto · next in ' + Math.max(0, Math.ceil(d - el)) + 's';
    if (cycle && el >= d && !holding) show(seq[(seq.indexOf(cur) + 1) % seq.length]); if (!reduceMotion) requestAnimationFrame(tick); }
  tick();
  addEventListener('resize', () => { setScale(); show(cur); });

  // ---------- clock (minutes, with timezone) and ages ----------
  const clock = $('#clock'); const setClock = () => { clock.textContent = hhmm(now()) + ' ' + DATA.tz; }; setClock();
  // Fixtures hold source timestamps and values until the next explicit sample.
  if (!reduceMotion && !still) setInterval(setClock, 1000);

  // ---------- display care: pixel shift unless reduced motion ----------
  const board = $('#board'); const shifts = [[0,0],[3,1],[1,3],[-2,2],[-3,-1],[-1,-3],[2,-2],[3,3]]; let si = 0;
  if (!reduceMotion && !still) setInterval(() => { si = (si + 1) % shifts.length; board.style.transform = `translate(${shifts[si][0]}px, ${shifts[si][1]}px)`; }, 60e3);
  window.MC = { show, modeFromURL, DATA, P, dir, paletteKey, MODES, SOURCES, safeStep, createDisplayState, R, UI: { panel, heroStat, gauge, st, budget } };
})();
