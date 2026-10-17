import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../bin/chaldea', import.meta.url));
const protocol = new URL('../../src/exec/protocol.ts', import.meta.url).href;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
async function fixture(mode = 'race', hosts = ['a', 'b']) {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'q-'));
  const home = join(root, 'home');
  assert.ok(home.startsWith(resolve(tmpdir()) + '/'), 'HOME must be scratch');
  await fs.mkdir(home);
  const work = join(root, 'work'); await fs.mkdir(work);
  execFileSync('git', ['init', '-q', work]);
  await fs.writeFile(join(work, 'input'), 'input');
  const log = join(root, 'events');
  await fs.writeFile(log, '');
  const script = join(root, 'ssh.mjs');
  await fs.writeFile(script, [
    "import fs from 'node:fs';",
    'import { frame, frames, json } from ' + JSON.stringify(protocol) + ';',
    'const args=process.argv.slice(2); if(args.includes("-G")) {console.log("controlpath none");process.exit(0)}',
    'const host=args.at(-2).replace("chaldea-job-",""), queued=args.at(-1)==="chaldea-exec-queue-v1";',
    'const log=e=>fs.appendFileSync(process.env.QLOG,JSON.stringify({host,event:e})+"\\n");',
    'const send=(t,v)=>process.stdout.write(frame(t,json(v))); const mode=process.env.QMODE;',
    'if(mode==="down") process.exit(255);',
    'if(!queued) {send("R",{outcome:"refused",message:"host busy: all job slots are in use",...(mode==="message-only"?{}:{busy:mode==="string-busy"?"true":mode!=="false-busy"})});process.exit(0)}',
    'if(mode==="old"){send("R",{outcome:"refused",message:"unsupported command"});process.exit(125)}',
    'send("H",{version:1,queueVersion:1}); let go=false; let timer;',
    'for await(const f of frames(process.stdin)){',
    'if(f.type==="W") log("pending");',
    'if(f.type==="W" && mode!=="hold") timer=setTimeout(()=>{log("ready");send("Y",{version:1,state:"ready"})}, mode==="tie"?50:host==="a"?500:50);',
    'if(f.type==="C"){log("cancel");clearTimeout(timer);process.exit(0)}',
    'if(f.type==="G"){go=true;log("go")}',
    'if(f.type==="Q"){if(!go)throw Error("job before go");log("request")}',
    'if(f.type==="E"){log("launch");process.stdout.write(frame("O",Buffer.from("ran\\n")));send("X",{exitCode:0})}',
    '} clearTimeout(timer);log("closed");',
  ].join('\n'));
  await fs.writeFile(join(root, 'ssh'), '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(script) + ' "$@"\n', { mode: 0o700 });
  const hostFile = join(root, 'hosts'); await fs.writeFile(hostFile, hosts.join('\n'));
  const events = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  async function until(event: string, count: number) {
    const watcher = watch(root);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { watcher.close(); reject(Error('missing ' + event)); }, 5000);
        const check = async () => {
          if ((await events()).filter(e => e.event === event).length >= count) { clearTimeout(timeout); resolve(); }
        };
        watcher.on('change', () => { void check(); }); void check();
      });
    } finally { watcher.close(); }
  }
  function run(extra: string[] = []) {
    const child = spawn(process.execPath, [cli, 'exec', ...extra, '--', 'true'], { cwd: work,
      env: { ...process.env, HOME: home, PATH: root + ':' + process.env.PATH, CHALDEA_EXEC_HOSTS: hostFile,
        CHALDEA_SSH_CONFIG: join(root, 'ssh.conf'), CHALDEA_STATE_DIR: join(root, 'state'), QLOG: log, QMODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    const done = once(child, 'close').then(([code, signal]) => ({ code, signal, out, err }));
    return { child, done };
  }
  return { run, events, until, remove: () => fs.rm(root, { recursive: true, force: true }) };
}

for (const mode of ['race', 'tie']) test('queue: ' + mode + ' selects exactly one host and cancels the other', { timeout: 10000 }, async () => {
  const f = await fixture(mode);
  try {
    const r = await f.run().done;
    assert.equal(r.code, 0, r.err); assert.equal(r.out, 'ran\n');
    assert.match(r.err, /queued: all job slots busy on a, b/);
    assert.match(r.err, /selected /);
    // Losing admission acknowledges cancellation before fixture cleanup.
    await f.until('cancel', 1);
    const events = await f.events();
    const launches = events.filter(e => e.event === 'launch');
    assert.equal(launches.length, 1);
    if (mode === 'race') assert.equal(launches[0].host, 'b');
    assert.equal(events.filter(e => e.event === 'go').length, 1);
    assert.equal(events.filter(e => e.event === 'request').length, 1);
  } finally { await f.remove(); }
});

test('queue timeout and unreachable hosts return 69 without launching', { timeout: 10000 }, async () => {
  for (const mode of ['hold', 'down', 'old']) {
    const f = await fixture(mode);
    try {
      const r = await f.run(['--queue-timeout', '200ms']).done;
      assert.equal(r.code, 69, r.err);
      if (mode === 'hold') assert.match(r.err, /queue timeout/);
      if (mode === 'down') assert.doesNotMatch(r.err, /queued/);
      assert.equal((await f.events()).filter(e => e.event === 'launch' || e.event === 'request').length, 0);
    } finally { await f.remove(); }
  }
});

test('SIGKILL while queued launches nothing; explicit --host queues only there', { timeout: 10000 }, async () => {
  const f = await fixture('hold');
  const r = f.run(['--host', 'b']);
  try {
    await f.until('pending', 1);
    r.child.kill('SIGKILL'); await r.done;
    await f.until('closed', 1);
    const events = await f.events();
    assert.ok(events.every(e => e.host === 'b'));
    assert.equal(events.filter(e => e.event === 'launch' || e.event === 'request').length, 0);
  } finally { r.child.kill('SIGKILL'); await f.remove(); }
});

for (const mode of ['message-only', 'string-busy', 'false-busy']) test('queue requires typed busy=true: ' + mode, async () => {
  const f = await fixture(mode, ['a']);
  try {
    const r = await f.run(['--queue-timeout', '200ms']).done;
    assert.equal(r.code, 69, r.err);
    assert.doesNotMatch(r.err, /queued:/);
    assert.deepEqual(await f.events(), []);
  } finally { await f.remove(); }
});
