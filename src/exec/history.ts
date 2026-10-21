import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execConfig } from '../config/exec.ts';
import { constants } from 'node:fs';
import { once } from 'node:events';
import { connect } from './queue.ts';
import { send, json, VERSION, FETCH_VERSION, COMMANDS, MAX_ARTIFACT, safePath } from './protocol.ts';
import { record, prune, type Intent } from './journal.ts';
import { active, artifactLocation, cleanArtifacts } from './artifacts.ts';
import { stateDir, withStateLock, privateDirectory } from './state.ts';
import { JobLog, cleanLogs, validJobId, logPath, LOG_CAP } from './logs.ts';

async function entryFor(state: string, id: string): Promise<Intent> {
  if (!validJobId(id)) throw new Error('invalid job id');
  try {
    const entry: Intent = JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8'));
    if (entry.jobId !== id || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(entry.host)) throw new Error('invalid journal entry');
    return entry;
  } catch (e: any) { if (e.code === 'ENOENT') throw new Error('unknown or expired job ' + id); throw e; }
}
export function summary(entry: Intent) {
  return [
    'Job: ' + entry.jobId, 'Outcome: ' + entry.outcome, 'Exit code: ' + (entry.exitCode ?? 'unknown'),
    'Host: ' + entry.host, 'Started: ' + entry.started, 'Ended: ' + (entry.ended ?? 'unknown'),
    'Log: ' + (entry.logPath ?? 'unavailable') + (entry.logTruncated ? ' (truncated at 64 MiB)' : '') + (entry.outputSyncFailed ? ' (local output sync failed)' : ''),
    'Artifacts: ' + (entry.artifactPaths?.join(', ') || 'none'),
    ...(entry.blob ? ['Artifact custody: ' + entry.blob.state] : []),
  ].join('\n') + '\n';
}
async function write(data: string | Buffer) {
  if (!process.stdout.write(data)) await once(process.stdout, 'drain');
}
export async function history(args: string[]): Promise<number> {
  const [command, id, flag] = args;
  if ((command === 'list' && args.length !== 1) ||
      (command !== 'list' && (!id || args.length > 3 || (flag !== undefined && (command !== 'show' || flag !== '--full'))))) {
    throw new Error('usage: chaldea exec list | show JOB-ID [--full] | fetch JOB-ID');
  }
  const state = stateDir();
  if (command === 'fetch') {
    if (!id || !validJobId(id)) throw new Error('invalid job id');
    // Match publication's job-lock -> accounting-lock order. Reload only after
    // both locks, so neither path can replace the other's newer journal state.
    return withStateLock(join(state, 'publication', id), () => withStateLock(state, async () => {
      await prune(join(state, 'journal')); await cleanLogs(state);
      return fetchJob(state, await entryFor(state, id));
    }));
  }
  return withStateLock(state, async () => {
    const journal = join(state, 'journal');
    await prune(journal);
    await cleanLogs(state);
    if (command === 'list') {
      const entries = await Promise.all((await fs.readdir(journal)).filter(name => name.endsWith('.json'))
        .map(async name => JSON.parse(await fs.readFile(join(journal, name), 'utf8')) as Intent));
      await write('JOB ID  OUTCOME  EXIT  HOST  STARTED\n');
      for (const entry of entries.sort((a, b) => Date.parse(b.started) - Date.parse(a.started)).slice(0, 100)) {
        await write([entry.jobId, entry.outcome, entry.exitCode ?? '?', entry.host, entry.started].join('  ') + '\n');
      }
      return 0;
    }
    const entry = await entryFor(state, id!);
    await write(summary(entry));
    if (!entry.logPath) { await write('Log unavailable for this older journal entry.\n'); return 0; }
    const path = logPath(state, entry.jobId);
    if (entry.logPath !== path) throw new Error('invalid journal log location');
    let file: fs.FileHandle;
    try { file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e: any) { if (e.code === 'ENOENT') { await write('Log expired or evicted; use exec fetch while host retention lasts.\n'); return 0; } throw e; }
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > LOG_CAP) throw new Error('invalid job log');
      const data = await file.readFile();
      if (flag === '--full') await write(data);
      else {
        let end = data.length;
        if (data[end - 1] === 10) end--;
        let start = end;
        for (let lines = 0; start > 0; start--) if (data[start - 1] === 10 && ++lines === 200) break;
        await write(data.subarray(start));
      }
    } finally { await file.close(); }
    return 0;
  });
}

// Check every directory below the worktree, including existing job directories.
export async function artifactTarget(root: string, id: string, name: string) {
  safePath(name);
  const base = join(root, '.chaldea');
  const parts = ['artifacts', id, ...name.split('/').slice(0, -1)];
  await privateDirectory(base);
  let dir = base;
  for (const part of parts) { dir = join(dir, part); await privateDirectory(dir); }
  return join(dir, name.split('/').at(-1)!);
}

async function fetchJob(state: string, entry: Intent): Promise<number> {
  if (active(entry)) throw new Error('job client is still active; fetch after it stops');
  const destination = artifactLocation(entry);
  if (!destination || !entry.worktree) throw new Error('journal has no recovery artifact location');
  const requested = entry.requestedArtifacts ?? [];
  requested.forEach(safePath);
  await cleanLogs(state, LOG_CAP); // includes the temporary replacement log
  await cleanArtifacts(join(state, 'journal'), entry.host, MAX_ARTIFACT);
  const config = execConfig().sshConfig;
  const transport = connect(config, entry.host, COMMANDS.fetch);
  const { ssh, incoming, exit } = transport;
  const path = logPath(state, entry.jobId);
  const temporary = path + '.recovery';
  const staging = join(destination, '.chaldea-fetch');
  let log: JobLog | undefined;
  let artifact: fs.FileHandle | undefined;
  let remaining = 0, received = 0;
  let complete = false;
  let stagingPrepared = false;
  let meta: any;
  const seen = new Set<string>();
  let timedOut = false;
  const stop = () => { ssh.stdin.destroy(); ssh.kill('SIGTERM'); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000);
  try {
    const hello = await incoming.next();
    if (hello.done || hello.value.type !== 'H' ||
        JSON.parse(hello.value.data.toString()).version !== VERSION ||
        JSON.parse(hello.value.data.toString()).fetchVersion !== FETCH_VERSION) {
      throw new Error('host does not support exec fetch protocol v' + FETCH_VERSION + '; upgrade the job server');
    }
    await send(ssh.stdin, 'F', json({ version: FETCH_VERSION, jobId: entry.jobId }));
    for await (const item of incoming) {
      const { type, data } = item;
      if (complete) throw new Error('frame after fetch result');
      if (type === 'R') throw new Error('host refused fetch: ' + String(JSON.parse(data.toString()).message).slice(0, 1024));
      if (type === 'M') {
        if (meta) throw new Error('duplicate recovery metadata');
        meta = JSON.parse(data.toString());
        if (meta.version !== FETCH_VERSION || meta.jobId !== entry.jobId ||
            !['finished', 'preempted', 'uncertain'].includes(meta.outcome) ||
            !(meta.exitCode === null || (Number.isInteger(meta.exitCode) && meta.exitCode >= 0 && meta.exitCode <= 255)) ||
            !Number.isFinite(meta.started) || !Number.isFinite(meta.ended) ||
            !Array.isArray(meta.artifacts) || meta.artifacts.length > requested.length) throw new Error('invalid recovery metadata');
        log = new JobLog(await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
        await artifactTarget(entry.worktree, entry.jobId, 'placeholder');
        await fs.rm(staging, { recursive: true, force: true });
        await privateDirectory(staging);
        stagingPrepared = true;
      } else if (!meta) throw new Error('missing recovery metadata');
      else if (type === 'L') {
        if (seen.size || remaining || log!.bytes + data.length > LOG_CAP) throw new Error('invalid recovery log');
        await log!.raw(data);
      } else if (type === 'A') {
        if (remaining) throw new Error('truncated artifact');
        if (artifact) { await artifact.sync(); await artifact.close(); artifact = undefined; }
        const item = JSON.parse(data.toString()); safePath(item.path);
        if (!requested.includes(item.path) || seen.has(item.path) ||
            !meta.artifacts.some((a: any) => a.path === item.path && a.size === item.size) ||
            !Number.isSafeInteger(item.size) || item.size < 0 || (received += item.size) > MAX_ARTIFACT) throw new Error('invalid recovery artifact');
        seen.add(item.path);
        const target = join(staging, item.path);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        artifact = await fs.open(target, 'wx', 0o600); remaining = item.size;
      } else if (type === 'B') {
        if (!artifact || !data.length || data.length > remaining) throw new Error('invalid recovery artifact data');
        await artifact.writeFile(data); remaining -= data.length;
      } else if (type === 'X') {
        if (remaining || seen.size !== meta.artifacts.length || JSON.parse(data.toString()).retrieved !== true) throw new Error('incomplete recovery');
        complete = true; ssh.stdin.end();
      } else throw new Error('unexpected fetch frame');
    }
    if (!complete || (await exit) !== 0) throw new Error(timedOut ? 'fetch timed out' : 'connection lost during fetch; local outcome unchanged');
    if (artifact) { await artifact.sync(); await artifact.close(); artifact = undefined; }
    await log!.close(); log = undefined;
    const retained = new Set(seen);
    if (entry.blob) for (const path of entry.artifactPaths ?? []) {
      const name = path.slice(destination.length + 1); safePath(name);
      if (path !== join(destination, name) || !requested.includes(name)) throw new Error('invalid prior artifact receipt');
      // Retention capture can omit a file already delivered to this client.
      // Keep every completed local receipt in the next publication set.
      retained.add(name);
    }
    // Persist the recovery barrier before replacing any local file. A crash or
    // partial rename cannot leave new bytes covered by an old confirmation.
    entry.artifactRecoveryPending = true;
    if (entry.blob) entry.blob.state = 'pending';
    await record(join(state, 'journal'), entry, false);
    for (const name of seen) {
      const target = await artifactTarget(entry.worktree, entry.jobId, name);
      await fs.rename(join(staging, name), target);
    }
    await fs.rename(temporary, path);
    entry.outcome = meta.outcome; entry.exitCode = meta.exitCode ?? undefined;
    entry.started = new Date(meta.started * 1000).toISOString(); entry.ended = new Date(meta.ended * 1000).toISOString();
    entry.logPath = path; entry.logTruncated = meta.logTruncated === true; entry.outputSyncFailed = false;
    if (meta.recoveryDegraded === true) await write('Host recovery storage was degraded; output or artifacts may be incomplete.\n');
    entry.artifactPaths = [...retained].map(name => join(destination, name));
    entry.artifactRecoveryComplete = true;
    delete entry.artifactRecoveryPending;
    // Recovery may change the artifact set. Retain the frozen manifest and
    // protect local bytes until publication verifies this recovered set too.
    if (entry.blob) entry.blob.state = 'pending';
    await record(join(state, 'journal'), entry, false);
    await write(summary(entry));
    for (const error of meta.artifactErrors ?? []) await write('Artifact unavailable: ' + String(error.path) + '\n');
    process.stderr.write('chaldea job ' + entry.jobId + ' log ' + path + '\n');
    return 0;
  } finally {
    clearTimeout(timer);
    stop(); await exit.catch(() => {});
    if (artifact) await artifact.close();
    if (log) await log.close();
    await fs.unlink(temporary).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
    if (stagingPrepared) await fs.rm(staging, { recursive: true, force: true });
  }
}
