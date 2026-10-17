import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { record, prune, type Intent } from '../../src/exec/journal.ts';
import { BOOT_ID } from '../../src/exec/artifacts.ts';
import { JobLog, cleanLogs, openLog, logPath, LOG_CAP } from '../../src/exec/logs.ts';

const cli = fileURLToPath(new URL('../../bin/chaldea', import.meta.url));
const server = fileURLToPath(new URL('../../host/chaldea-job-server', import.meta.url));
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function collected(child: ChildProcess) {
  let out = '', err = '';
  child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
  const [code] = await once(child, 'close'); return { code, out, err };
}
async function fixture() {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'recovery-'));
  const home = join(root, 'home'), work = join(root, 'work'), state = join(root, 'state');
  assert.ok(home.startsWith(resolve(tmpdir()) + '/'));
  for (const path of [home, work, state, join(root, 'done')]) await fs.mkdir(path, { mode: 0o700 });
  execFileSync('git', ['init', '-q', work]);
  await fs.writeFile(join(work, 'input'), 'unprinted-snapshot-secret');
  // Exercise the actual server main/execute/fetch protocol. Substitute only the
  // namespace launcher; hosted exec E2E also covers real SSH/pasta/bubblewrap.
  const wrapper = join(root, 'server.py');
  await fs.writeFile(wrapper, [
    'import json,os,runpy,sys',
    'from pathlib import Path',
    's=runpy.run_path(sys.argv[1])',
    'root=Path(sys.argv[2]); command=sys.argv[3]',
    'os.environ["SSH_ORIGINAL_COMMAND"]=command',
    'if command == "chaldea-exec-fetch-v1" and os.environ.get("OLD_SERVER"):',
    '    s["send"]("R",s["encode"]({"outcome":"refused","message":"unsupported protocol"}));sys.exit(125)',
    'config=root/"config.json"',
    'def launch(request,workspace,config):',
    '    path=workspace.parent/(request["jobId"]+".launch");path.touch()',
    '    return ["/bin/sh","-c",\'cd "$1"; shift; exec "$@"\',"job",str(workspace),*request["argv"]],path',
    's["execute"].__globals__.update(prepare_launch=launch,launched=lambda path: True,job_signal=lambda *args: None)',
    'sys.argv=["server","--config",str(config)]',
    'try: s["main"]()',
    'except Exception as error:',
    '    try: s["send"]("R",s["encode"]({"outcome":"uncertain","message":type(error).__name__}))',
    '    except (BrokenPipeError,OSError): pass',
    '    sys.exit(125)',
    'finally:',
    '    for entry in (root/"jobs"/".retained").glob("*/metadata.json") if (root/"jobs"/".retained").exists() else []:',
    '        value=json.loads(entry.read_text())',
    '        if "ended" in value: (root/"done"/value["jobId"]).touch()',
  ].join('\n'));
  const python = process.env.CHALDEA_TEST_PYTHON ?? execFileSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
  await fs.writeFile(join(root, 'ssh'), '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "-G" ]; then echo "controlpath none"; exit 0; fi; done\nfor last do :; done\nexec ' +
    quote(python) + ' -I ' + quote(wrapper) + ' ' + quote(server) + ' ' + quote(root) + ' "$last"\n', { mode: 0o700 });
  await fs.writeFile(join(root, 'config.json'), JSON.stringify({ state_root: join(root, 'jobs'), require_mount: false }));
  const env = { ...process.env, HOME: home, PATH: root + ':' + process.env.PATH, CHALDEA_STATE_DIR: state, CHALDEA_SSH_CONFIG: join(root, 'ssh.conf') };
  const command = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawn(process.execPath, [cli, 'exec', ...args],
    { cwd: work, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    root, work, state,
    command,
    run: (code: string, artifact = true, extra: NodeJS.ProcessEnv = {}) => command(['--host', 'test', '--no-queue', ...(artifact ? ['--artifact', 'out/result'] : []), '--', python, '-c', code], extra),
    entries: async () => Promise.all((await fs.readdir(join(state, 'journal'))).filter(x => x.endsWith('.json')).map(async x => JSON.parse(await fs.readFile(join(state, 'journal', x), 'utf8')))),
    done: async (id: string) => {
      const dir = join(root, 'done');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error('host did not finalize recovery')); }, 10000);
        const watcher = watch(dir, async () => { if (await fs.access(join(dir, id)).then(() => true, () => false)) { clearTimeout(timer); watcher.close(); resolve(); } });
        void fs.access(join(dir, id)).then(() => { clearTimeout(timer); watcher.close(); resolve(); }, () => {});
      });
    },
    remove: () => fs.rm(root, { recursive: true, force: true }),
  };
}
test('failed job persists private marked log/journal; show tail/full and bounded newest-first list', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const result = await collected(f.run('import pathlib,sys; pathlib.Path("out").mkdir(); pathlib.Path("out/result").write_text("artifact"); print("\\n".join("line-%03d"%i for i in range(250))); print("stderr-value",file=sys.stderr); sys.exit(7)'));
    assert.equal(result.code, 7, result.err);
    const [entry] = await f.entries();
    assert.equal(entry.outcome, 'finished'); assert.equal(entry.exitCode, 7);
    assert.ok(entry.started && entry.ended);
    assert.deepEqual(entry.artifactPaths, [join(f.work, '.chaldea/artifacts', entry.jobId, 'out/result')]);
    assert.match(result.err.trim().split('\n').at(-1)!, new RegExp('chaldea job ' + entry.jobId + ' log '));
    const log = await fs.readFile(entry.logPath, 'utf8');
    assert.match(log, /\[stdout\]/); assert.match(log, /\[stderr\]/); assert.match(log, /stderr-value/);
    assert.equal((await fs.stat(entry.logPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.state)).mode & 0o777, 0o700);
    assert.equal(await fs.readFile(entry.artifactPaths[0], 'utf8'), 'artifact');
    const show = await collected(f.command(['show', entry.jobId]));
    assert.equal(show.code, 0, show.err); assert.match(show.out, /Outcome: finished\nExit code: 7\nHost: test/);
    assert.match(show.out, /line-249/); assert.doesNotMatch(show.out, /line-000/);
    const full = await collected(f.command(['show', entry.jobId, '--full']));
    assert.match(full.out, /line-000/); assert.ok(full.out.endsWith(log));
    const success = await collected(f.run('print("success")', false)); assert.equal(success.code, 0, success.err);
    const entries = await f.entries();
    const newer = entries.find(x => x.exitCode === 0)!;
    assert.equal(await fs.access(join(f.root, 'jobs/.retained', newer.jobId)).then(() => true, () => false), false);
    const list = await collected(f.command(['list']));
    assert.equal(list.code, 0, list.err); assert.ok(list.out.indexOf(newer.jobId) < list.out.indexOf(entry.jobId));
    const retained = await fs.readFile(join(f.root, 'jobs/.retained', entry.jobId, 'metadata.json'), 'utf8');
    assert.doesNotMatch(retained, /unprinted-snapshot-secret|argv/);
    // Fetch replaces the complete log and artifacts without replaying a command.
    await fs.writeFile(entry.logPath, 'damaged-local-log');
    await fs.writeFile(entry.artifactPaths[0], 'damaged-local-artifact');
    const fetch = await collected(f.command(['fetch', entry.jobId]));
    assert.equal(fetch.code, 0, fetch.err);
    assert.equal(await fs.readFile(entry.logPath, 'utf8'), log);
    assert.equal(await fs.readFile(entry.artifactPaths[0], 'utf8'), 'artifact');
    assert.equal((await f.entries()).length, 2);
  } finally { await f.remove(); }
});

test('SIGKILLed client leaves a host-fetchable job with output/artifacts and uncertain outcome', { timeout: 30000 }, async () => {
  const f = await fixture();
  const child = f.run('import pathlib,time; pathlib.Path("out").mkdir(); pathlib.Path("out/result").write_text("recover-me"); print("ready-before-loss",flush=True); time.sleep(100)');
  const closed = once(child, 'close'); let stderr = '';
  child.stderr!.on('data', data => { stderr += data; });
  try {
    await Promise.race([once(child.stdout!, 'data'), closed.then(() => { throw new Error(stderr); })]);
    const [entry] = await f.entries();
    child.kill('SIGKILL'); await closed;
    await f.done(entry.jobId);
    const result = await collected(f.command(['fetch', entry.jobId]));
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Outcome: uncertain/);
    assert.match(await fs.readFile(entry.logPath, 'utf8'), /ready-before-loss/);
    assert.equal(await fs.readFile(join(f.work, '.chaldea/artifacts', entry.jobId, 'out/result'), 'utf8'), 'recover-me');
    const updated = (await f.entries())[0];
    assert.equal(updated.outcome, 'uncertain'); assert.equal(updated.exitCode, undefined); assert.ok(updated.ended);
    assert.equal(await fs.access(join(f.root, 'jobs', entry.jobId)).then(() => true, () => false), false);
    const oldLog = await fs.readFile(entry.logPath);
    const oldServer = await collected(f.command(['fetch', entry.jobId], { OLD_SERVER: '1' }));
    assert.equal(oldServer.code, 255); assert.match(oldServer.err, /does not support exec fetch protocol v1; upgrade/);
    assert.deepEqual(await fs.readFile(entry.logPath), oldLog);
    assert.equal((await f.entries()).length, 1);
  } finally { child.kill('SIGKILL'); await closed; await f.remove(); }
});

test('log caps, age/count pruning, and active reservations use fake time and sparse files', async () => {
  assert.notEqual(tmpdir(), '/tmp');
  const state = await fs.mkdtemp(join(tmpdir(), 'logs-'));
  const journal = join(state, 'journal');
  const now = Date.now();
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, jobId] of ids.entries()) {
      const entry: Intent = { jobId, host: 'test', argv: [], started: new Date(now - (3 - index) * 1000).toISOString(), outcome: 'finished' };
      await record(journal, entry);
      const log = await openLog(state, jobId);
      const small = new JobLog(log.file, 32);
      await small.output('S', Buffer.alloc(100, 120));
      assert.equal(small.truncated, true); assert.equal(small.bytes, 32);
      await small.close();
    }
    await cleanLogs(state, 0, 64, now);
    await assert.rejects(fs.access(logPath(state, ids[0]!)), { code: 'ENOENT' });
    await fs.access(logPath(state, ids[1]!));
    const liveId = ids[2]!;
    await record(journal, { jobId: liveId, host: 'test', argv: [], started: new Date(now).toISOString(), outcome: 'uncertain', pid: process.pid, bootId: BOOT_ID }, false);
    await assert.rejects(cleanLogs(state, 1, LOG_CAP, now), /active logs protected/);
    await fs.access(logPath(state, liveId));
    await cleanLogs(state, 0, LOG_CAP, now + 15 * 86400000);
    // Live process age is bounded by active(); fake age pruning never reads a real home.
    await record(journal, { jobId: liveId, host: 'test', argv: [], started: new Date(now - 15 * 86400000).toISOString(), outcome: 'finished' }, false);
    await cleanLogs(state, 0, LOG_CAP, now);
    await assert.rejects(fs.access(logPath(state, liveId)), { code: 'ENOENT' });
    const id = randomUUID(); const entry: Intent = { jobId: id, host: 'test', argv: [], started: new Date(now).toISOString(), outcome: 'finished' };
    await record(journal, entry); const log = await openLog(state, id); await log.close();
    await prune(journal, 14 * 86400000, 0);
    await assert.rejects(fs.access(logPath(state, id)), { code: 'ENOENT' });
  } finally { await fs.rm(state, { recursive: true, force: true }); }
});

test('a final log fsync error preserves the confirmed exit code in the journal', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const injection = join(f.root, 'fail-log-sync.mjs');
    await fs.writeFile(injection, [
      "import * as fs from 'node:fs/promises';",
      "const file = await fs.open(process.env.INJECT_PROBE, 'w');",
      "const prototype = Object.getPrototypeOf(file);",
      "const sync = prototype.sync;",
      "prototype.sync = async function () {",
      "  const path = await fs.readlink('/proc/self/fd/' + this.fd);",
      "  if (path.endsWith('.log')) throw Object.assign(new Error('fixture ENOSPC'), {code: 'ENOSPC'});",
      "  return sync.call(this);",
      "};",
      "await file.close();",
    ].join('\n'));
    const result = await collected(f.run('import sys; print("delivered"); sys.exit(7)', false,
      { NODE_OPTIONS: '--import=' + injection, INJECT_PROBE: join(f.root, 'probe') }));
    assert.equal(result.code, 7, result.err);
    assert.match(result.err, /local output sync failed/);
    const [entry] = await f.entries();
    assert.equal(entry.outcome, 'finished'); assert.equal(entry.exitCode, 7);
    assert.match(await fs.readFile(entry.logPath, 'utf8'), /delivered/);
  } finally { await f.remove(); }
});
