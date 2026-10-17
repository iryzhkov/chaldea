import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
  await fs.mkdir(work); await fs.mkdir(state);
  execFileSync('git', ['init', '-q', work]);
  await fs.writeFile(join(work, 'input'), 'snapshot');
  const script = join(root, 'fake-ssh.mjs'); const log = join(root, 'attempts');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'import { frame, frames, json, VERSION } from ' + JSON.stringify(protocol) + ';',
    'const args = process.argv.slice(2);',
    'if (args.includes("-G")) { console.log("controlpath none"); process.exit(0); }',
    'const host = args.at(-2).replace("chaldea-job-", "");',
    'const mode = JSON.parse(process.env.FAKE_MODES)[host] ?? "ok";',
    'const log = event => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({host,event})+"\\n");',
    'const send = (type, value) => process.stdout.write(frame(type, json(value)));',
    'log("connected");',
    'if (mode === "unreachable") process.exit(255);',
    'if (mode === "busy") { send("R", {outcome:"refused",message:"busy"}); process.exit(0); }',
    'send("H", {version: mode === "invalid" ? 2 : VERSION});',
    'let request;',
    'for await (const item of frames(process.stdin)) {',
    '  if (item.type === "Q") {',
    '    request = JSON.parse(item.data); log("requested");',
    '    if (mode === "disconnect") process.exit(255);',
    '    if (mode === "refused") { send("R", {outcome:"refused",message:"gated"}); process.exit(0); }',
    '  }',
    '  if (item.type !== "E") continue;',
    '  if (mode === "preempted") { send("R", {outcome:"preempted",message:"gaming"}); process.exit(0); }',
    '  log("started");',
    '  if (mode === "hold") { process.stdout.write(frame("O", Buffer.from("locked"))); continue; }',
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
  const env = { ...process.env, PATH: root + ':' + process.env.PATH, CHALDEA_STATE_DIR: state,
    CHALDEA_EXEC_HOSTS: hostFile, CHALDEA_SSH_CONFIG: join(root, 'ssh.conf'),
    FAKE_MODES: JSON.stringify(modes), FAKE_LOG: log };
  return {
    state, hostFile,
    run: (host?: string, code = 0) => spawn(process.execPath,
      [cli, 'exec', ...(host ? ['--host', host] : []), '--', process.execPath, '-e', 'console.log("ran");process.exit(' + code + ')'],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] }),
    events: async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)),
    intents: async () => Promise.all((await fs.readdir(join(state, 'journal'))).filter(x => x.endsWith('.json')).map(async x =>
      JSON.parse(await fs.readFile(join(state, 'journal', x), 'utf8')))),
    remove: () => fs.rm(root, { recursive: true, force: true }),
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
      assert.equal(events.some(e => e.host === 'fake-b'), retry);
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

test('target locks allow different hosts, auto skips a busy local target, SIGKILL releases the lock', { timeout: 20000 }, async () => {
  const f = await fixture({ 'fake-a': 'hold' });
  const holder = f.run('fake-a');
  const exited = once(holder, 'close'); let err = '';
  holder.stderr!.on('data', x => { err += x; });
  try {
    await Promise.race([once(holder.stdout!, 'data'), exited.then(() => { throw new Error(err); })]);
    const same = await collected(f.run('FAKE-A'));
    assert.equal(same.code, 255, same.err); assert.match(same.err, /another local chaldea exec/);
    const other = await collected(f.run('fake-b'));
    assert.equal(other.code, 0, other.err);
    const automatic = await collected(f.run());
    assert.equal(automatic.code, 0, automatic.err);
    assert.match(automatic.err, /skipped fake-a: another local/);
    assert.match(automatic.err, /ran on fake-b/);
    holder.kill('SIGKILL'); await exited;
    const lock = await fs.open(join(f.state, 'artifacts-fake-a.lock'), 'a');
    try { execFileSync('/usr/bin/flock', ['-n', '3'], { stdio: ['ignore', 'pipe', 'pipe', lock.fd] }); }
    finally { await lock.close(); }
  } finally {
    holder.kill('SIGKILL'); await exited; await f.remove();
  }
});
