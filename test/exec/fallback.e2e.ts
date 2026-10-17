import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/chaldea', import.meta.url));
const protocol = new URL('../../src/exec/protocol.ts', import.meta.url).href;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function collected(child: ChildProcess) {
  let out = ''; let err = '';
  child.stdout!.on('data', x => { out += x; });
  child.stderr!.on('data', x => { err += x; });
  const [code] = await once(child, 'close');
  return { code, out, err };
}
async function fixture(modes: Record<string, string>, hosts = ['fake-a', 'fake-b']) {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'fallback-'));
  const work = join(root, 'work'); const state = join(root, 'state');
  const home = join(root, 'home');
  assert.ok(home.startsWith(resolve(tmpdir()) + '/'), 'fixture HOME must be scratch');
  await fs.mkdir(home); await fs.mkdir(work); await fs.mkdir(state);
  execFileSync('git', ['init', '-q', work]);
  await fs.writeFile(join(work, 'input'), 'snapshot');
  const script = join(root, 'fake-ssh.mjs'); const log = join(root, 'attempts');
  const control = join(root, 'control');
  const sockets = new Set<net.Socket>();
  let receivedBanner = '';
  const listener = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', data => { receivedBanner += data.toString(); }); // Never answer SSH setup.
    socket.on('close', () => sockets.delete(socket));
  });
  let port = 0;
  if (Object.values(modes).includes('connect-hang')) {
    await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    port = (listener.address() as net.AddressInfo).port;
  } else if (Object.values(modes).includes('stuck-control')) {
    await new Promise<void>(r => listener.listen(control, r));
  }
  const sshConfig = join(root, 'ssh.conf');
  await fs.writeFile(sshConfig, 'Host *\n  HostName 127.0.0.1\n  Port ' + port + '\n  ControlPath none\n');
  const realSsh = execFileSync('sh', ['-c', 'command -v ssh'], { encoding: 'utf8' }).trim();
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "import { dirname } from 'node:path';",
    'import { frame, frames, json, VERSION } from ' + JSON.stringify(protocol) + ';',
    'const args = process.argv.slice(2);',
    'const host = (args.includes("-G") || args.includes("-O") ? args.at(-1) : args.at(-2)).replace("chaldea-job-", "");',
    'const mode = JSON.parse(process.env.FAKE_MODES)[host] ?? "ok";',
    'const log = event => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({host,event,args})+"\\n");',
    'const send = (type, value) => process.stdout.write(frame(type, json(value)));',
    'if (args.includes("-G")) { console.log("controlpath " + (mode === "stuck-control" ? process.env.FAKE_CONTROL : "none")); process.exit(0); }',
    'if (args.includes("-O") && mode === "stuck-control") { log("control-check"); await new Promise(r => setTimeout(r, 30000)); process.exit(0); }',
    'const probe = args.at(-1) === "chaldea-exec-queue-v1";',
    'log(probe ? "probed" : "connected");',
    'if (mode === "connect-hang") { process.execve(process.env.FAKE_REAL_SSH, [process.env.FAKE_REAL_SSH, ...args], process.env); }',
    'if (mode === "unreachable") process.exit(255);',
    'if (probe && mode === "probe-barrier") {',
    '  const watcher = fs.watch(dirname(process.env.FAKE_LOG));',
    '  await new Promise(resolve => {',
    '    const check = () => { if (fs.readFileSync(process.env.FAKE_LOG, "utf8").trim().split("\\n").map(JSON.parse).filter(e => e.event === "probed").length === 2) resolve(); };',
    '    watcher.on("change", check); check();',
    '  }); watcher.close();',
    '}',
    'if (mode === "busy") { send("R", {outcome:"refused",message:"busy",busy:true}); process.exit(0); }',
    'send("H", {version: mode === "invalid" ? 2 : VERSION});',
    'let request;',
    'for await (const item of frames(process.stdin)) {',
    '  if (probe) { log("probe-input"); process.exit(2); }',
    '  if (item.type === "Q") {',
    '    request = JSON.parse(item.data); log("requested");',
    '    if (mode === "disconnect") process.exit(255);',
    '    if (mode === "refused") { send("R", {outcome:"refused",message:"gated"}); process.exit(0); }',
    '  }',
    '  if (item.type !== "E") continue;',
    '  if (mode === "preempted") { send("R", {outcome:"preempted",message:"gaming"}); process.exit(0); }',
    '  log("started");',
    '  if (mode === "hold" && request.argv.at(-1) === "hold") { process.stdout.write(frame("O", Buffer.from("locked"))); continue; }',
    '  if (mode === "late-refusal") { process.stdout.write(frame("O", Buffer.from("started"))); send("R", {outcome:"refused",message:"too late"}); process.exit(0); }',
    '  const result = spawnSync(request.argv[0], request.argv.slice(1));',
    '  if (result.stdout?.length) process.stdout.write(frame("O", result.stdout));',
    '  if (result.stderr?.length) process.stdout.write(frame("S", result.stderr));',
    '  send("X", {exitCode:result.status ?? 255});',
    '}',
  ].join('\n'));
  await fs.writeFile(join(root, 'ssh'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n', { mode: 0o700 });
  const hostFile = join(root, 'hosts');
  await fs.writeFile(hostFile, hosts.join('\n') + '\n');
  const env = { ...process.env, HOME: home, PATH: root + ':' + process.env.PATH, CHALDEA_STATE_DIR: state,
    CHALDEA_EXEC_HOSTS: hostFile, CHALDEA_SSH_CONFIG: sshConfig,
    FAKE_MODES: JSON.stringify(modes), FAKE_LOG: log, FAKE_CONTROL: control, FAKE_REAL_SSH: realSsh };
  return {
    state, hostFile, banner: () => receivedBanner,
    run: (host?: string, code: number | 'hold' = 0) => spawn(process.execPath,
      [cli, 'exec', '--no-queue', ...(host ? ['--host', host] : []), '--', process.execPath, '-e', 'console.log("ran");process.exit(' + (code === 'hold' ? 0 : code) + ')', ...(code === 'hold' ? ['hold'] : [])],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] }),
    events: async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)),
    intents: async () => Promise.all((await fs.readdir(join(state, 'journal'))).filter(x => x.endsWith('.json')).map(async x =>
      JSON.parse(await fs.readFile(join(state, 'journal', x), 'utf8')))),
    remove: async () => {
      for (const socket of sockets) socket.destroy();
      if (listener.listening) await new Promise<void>((r, reject) => listener.close(e => e ? reject(e) : r()));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('two fake job hosts: busy first host falls through to exactly one execution', { timeout: 15000 }, async () => {
  const f = await fixture({ 'fake-a': 'busy' });
  try {
    const r = await collected(f.run());
    assert.equal(r.code, 0, r.err); assert.equal(r.out, 'ran\n');
    assert.match(r.err, /skipped fake-a: host refused: busy/);
    assert.match(r.err, /ran on fake-b/);
    assert.deepEqual((await f.events()).filter(e => e.event === 'started').map(e => e.host), ['fake-b']);
    const intents = await f.intents();
    assert.equal(new Set(intents.map(i => i.jobId)).size, 2);
    assert.deepEqual(intents.map(i => [i.host, i.outcome]).sort(), [['fake-a', 'refused'], ['fake-b', 'finished']]);
  } finally { await f.remove(); }
});

test('concurrent probe barrier preserves preference and sends job bytes to one host', { timeout: 15000 }, async () => {
  const f = await fixture({ 'fake-a': 'probe-barrier', 'fake-b': 'probe-barrier' });
  try {
    const r = await collected(f.run());
    assert.equal(r.code, 0, r.err);
    const events = await f.events();
    assert.deepEqual(events.filter(e => e.event === 'probed').map(e => e.host).sort(), ['fake-a', 'fake-b']);
    assert.equal(events.some(e => e.event === 'probe-input'), false);
    assert.deepEqual(events.filter(e => e.event === 'requested').map(e => e.host), ['fake-a']);
    assert.deepEqual(events.filter(e => e.event === 'started').map(e => e.host), ['fake-a']);
    assert.deepEqual((await f.intents()).map(i => [i.host, i.outcome]), [['fake-a', 'finished']]);
  } finally { await f.remove(); }
});

test('connection and protocol boundaries do not replay dispatched work', { timeout: 30000 }, async t => {
  for (const [mode, retry, outcome] of [
    ['unreachable', true, 'refused'], ['refused', true, 'refused'],
    ['disconnect', false, 'uncertain'], ['invalid', false, 'uncertain'],
    ['preempted', false, 'preempted'], ['late-refusal', false, 'uncertain'],
  ] as const) await t.test(mode, async () => {
    const f = await fixture({ 'fake-a': mode });
    try {
      const r = await collected(f.run());
      assert.equal(r.code, retry ? 0 : 255, r.err);
      const events = await f.events();
      assert.equal(events.some(e => e.host === 'fake-b' && e.event === 'connected'), retry);
      const first = (await f.intents()).find(i => i.host === 'fake-a');
      assert.equal(first.outcome, outcome);
    } finally { await f.remove(); }
  });
});

test('exhaustion is immediate, explicit targets never fall back, and remote codes pass through', { timeout: 20000 }, async () => {
  const f = await fixture({ 'fake-a': 'busy', 'fake-b': 'unreachable' });
  try {
    const r = await collected(f.run());
    assert.equal(r.code, 69, r.err);
    assert.match(r.err.split('\n').filter(Boolean).at(-1)!, /no available exec host: fake-a \(host refused: busy\); fake-b \(connection closed before job request\)/);
    assert.equal((await f.intents()).length, 2);
    await fs.writeFile(f.hostFile, 'invalid config must not be read');
    const explicit = await collected(f.run('fake-a'));
    assert.equal(explicit.code, 255, explicit.err);
    assert.doesNotMatch(explicit.err, /skipped|no available|invalid host/);
    assert.equal((await f.events()).filter(e => e.host === 'fake-b').length, 1);
  } finally { await f.remove(); }
  const good = await fixture({});
  try {
    for (const code of [7, 69, 125, 255]) {
      const r = await collected(good.run(undefined, code));
      assert.equal(r.code, code, r.err);
      assert.match(r.err, /ran on fake-a/); assert.doesNotMatch(r.err, /skipped/);
    }
    assert.ok((await good.intents()).every(i => i.outcome === 'finished'));
  } finally { await good.remove(); }
});

test('auto skips self without SSH or an intent', { timeout: 10000 }, async () => {
  const local = hostname().split('.')[0];
  const f = await fixture({}, [local, 'other-target']);
  try {
    const r = await collected(f.run());
    assert.equal(r.code, 0, r.err); assert.match(r.err, /local host/);
    assert.deepEqual((await f.events()).filter(e => e.event === 'started').map(e => e.host), ['other-target']);
    assert.equal((await f.intents()).length, 1);
  } finally { await f.remove(); }
});

test('same target accepts overlapping local execs; accounting lock is released during jobs', { timeout: 20000 }, async () => {
  const f = await fixture({ 'fake-a': 'hold' });
  const holder = f.run('fake-a', 'hold');
  const exited = once(holder, 'close'); let err = '';
  holder.stderr!.on('data', x => { err += x; });
  try {
    await Promise.race([once(holder.stdout!, 'data'), exited.then(() => { throw new Error(err); })]);
    const same = await collected(f.run('FAKE-A'));
    assert.equal(same.code, 0, same.err); assert.equal(same.out, 'ran\n');
    const other = await collected(f.run('fake-b'));
    assert.equal(other.code, 0, other.err);
    const automatic = await collected(f.run());
    assert.equal(automatic.code, 0, automatic.err);
    assert.match(automatic.err, /ran on fake-a/);
    assert.doesNotMatch(automatic.err, /skipped/);
    const intents = await f.intents();
    assert.equal(intents.filter(i => i.outcome === 'uncertain').length, 1);
    assert.equal(intents.filter(i => i.outcome === 'finished').length, 3);
    holder.kill('SIGKILL'); await exited;
    const lock = await fs.open(join(f.state, 'accounting.lock'), 'a');
    try { execFileSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', lock.fd] }); }
    finally { await lock.close(); }
  } finally {
    holder.kill('SIGKILL'); await exited; await f.remove();
  }
});

test('SSH setup to two silent hosts shares the probe window and falls through', { timeout: 60000 }, async () => {
  const f = await fixture({ 'fake-a': 'connect-hang', 'fake-b': 'connect-hang' }, ['fake-a', 'fake-b', 'fake-c']);
  const child = f.run();
  try {
    const r = await collected(child);
    assert.equal(r.code, 0, r.err);
    // Completion is driven by real OpenSSH's setup failure. Check its configured
    // timeout directly; process startup and runner scheduling are not the contract.
    const attempt = (await f.events()).find(e => e.host === 'fake-a' && e.event === 'probed');
    assert.ok(attempt.args.includes('ConnectTimeout=10'));
    assert.match(f.banner(), /^SSH-2\.0-OpenSSH/);
    assert.match(r.err, /skipped fake-a: connection (timed out|closed) before job request/);
    assert.match(r.err, /skipped fake-b: connection (timed out|closed) before job request/);
    assert.match(r.err, /ran on fake-c/);
    const events = await f.events();
    assert.deepEqual(events.filter(e => e.event === 'probed').map(e => e.host).sort(), ['fake-a', 'fake-b', 'fake-c']);
    assert.deepEqual(events.filter(e => e.event === 'connected').map(e => e.host), ['fake-c']);
    assert.deepEqual(events.filter(e => e.event === 'requested').map(e => e.host), ['fake-c']);
    assert.deepEqual((await f.intents()).map(i => [i.host, i.outcome]).sort(), [['fake-a', 'refused'], ['fake-b', 'refused'], ['fake-c', 'finished']]);
  } finally { child.kill('SIGKILL'); await f.remove(); }
});

test('stuck ControlMaster journals non-dispatch and falls through only in auto mode', { timeout: 10000 }, async () => {
  const f = await fixture({ 'fake-a': 'stuck-control' });
  try {
    const automatic = await collected(f.run());
    assert.equal(automatic.code, 0, automatic.err);
    assert.match(automatic.err, /skipped fake-a: SSH control master did not answer; no job dispatched/);
    assert.match(automatic.err, /ran on fake-b/);
    assert.deepEqual((await f.intents()).map(i => [i.host, i.outcome]).sort(), [['fake-a', 'refused'], ['fake-b', 'finished']]);
    assert.deepEqual((await f.events()).filter(e => e.event === 'connected').map(e => e.host), ['fake-b']);
    const explicit = await collected(f.run('fake-a'));
    assert.equal(explicit.code, 255, explicit.err);
    assert.match(explicit.err, /SSH control master did not answer; no job dispatched/);
    assert.doesNotMatch(explicit.err, /skipped|ran on/);
    assert.equal((await f.intents()).length, 2);
  } finally { await f.remove(); }
});

test('missing host list names the path and explicit-host escape hatch in one line', { timeout: 10000 }, async () => {
  const f = await fixture({});
  try {
    await fs.unlink(f.hostFile);
    const r = await collected(f.run());
    assert.equal(r.code, 255); assert.equal(r.out, '');
    assert.equal(r.err, 'chaldea: missing exec host list ' + f.hostFile + '; --host H works without it\n');
    assert.deepEqual(await f.events(), []);
    await assert.rejects(fs.access(join(f.state, 'journal')), { code: 'ENOENT' });
    const explicit = await collected(f.run('fake-a'));
    assert.equal(explicit.code, 0, explicit.err); assert.equal(explicit.out, 'ran\n');
    assert.equal((await f.intents()).length, 1);
  } finally { await f.remove(); }
});
