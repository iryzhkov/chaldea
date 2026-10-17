import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, queueHost, type Transport } from './queue.ts';
import { manifest } from './manifest.ts';
import { cleanArtifacts, BOOT_ID } from './artifacts.ts';
import { record, prune, DAYS, type Intent } from './journal.ts';
import { send, json, safePath, VERSION, CHUNK, MAX_ARTIFACT, type Request } from './protocol.ts';

export function argumentsFor(args: string[]) {
  let host: string | undefined; let gpu = false; let noQueue = false; let queueTimeout = 3600; const artifacts: string[] = [];
  let i = args[0] === 'exec' ? 1 : -1;
  if (i < 0) throw new Error('usage: chaldea exec [--host H] [--queue-timeout 1h] [--no-queue] [--artifact PATH] [--gpu] -- CMD...');
  while (i < args.length && args[i] !== '--') {
    const flag = args[i++];
    if (flag === '--host') { host = args[i++]; if (!host) throw new Error('invalid exec arguments'); }
    else if (flag === '--artifact') { const path = args[i++]; safePath(path); artifacts.push(path); }
    else if (flag === '--gpu') gpu = true;
    else if (flag === '--no-queue') noQueue = true;
    else if (flag === '--queue-timeout') {
      const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(args[i++] ?? '');
      queueTimeout = match ? Number(match[1]) * (({ ms: .001, s: 1, m: 60, h: 3600 } as Record<string, number>)[match[2] ?? 's']!) : NaN;
      if (!Number.isFinite(queueTimeout) || queueTimeout <= 0 || queueTimeout > 86400) throw new Error('invalid queue timeout (0 < duration <= 24h)');
    }
    else throw new Error('unknown option: ' + flag);
  }
  const argv = args.slice(i + 1);
  if ((host !== undefined && !validHost(host)) || args[i] !== '--' || !argv.length ||
      argv.length > 256 || argv.some(x => x.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 16384 ||
      artifacts.length > 32 || new Set(artifacts).size !== artifacts.length) throw new Error('invalid exec arguments');
  return { host, gpu, artifacts, argv, noQueue, queueTimeout };
}

const validHost = (host: string) => /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(host);
export const EXIT_UNAVAILABLE = 69;

// Entries are fleet inventory names with existing chaldea-job-NAME aliases.
export function hostsFor(text: string) {
  const hosts = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  if (hosts.some(x => !validHost(x))) throw new Error('invalid host in exec-hosts');
  return hosts.filter((x, i) => hosts.findIndex(h => h.toLowerCase() === x.toLowerCase()) === i);
}
// Fleet config omits this host's inventory name; hostname matching is a backstop.
export function isLocalHost(host: string, local = hostname()) {
  return host.toLowerCase() === local.split('.')[0].toLowerCase();
}
class RetryableFailure extends Error {
  reason: string;
  busy: boolean;
  constructor(message: string, reason = message, busy = false) { super(message); this.reason = reason; this.busy = busy; }
}
export function fallbackAllowed(outcome: Intent['outcome'] | 'connection-failed', requestSent: boolean, started: boolean, interrupted = false) {
  return !interrupted && ((outcome === 'connection-failed' && !requestSent) || (outcome === 'refused' && !started));
}
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');

class RemoteFailure extends Error {
  outcome: Intent['outcome'];
  busy: boolean;
  constructor(data: Buffer) {
    const value = JSON.parse(data.toString());
    const outcome = ['refused', 'preempted'].includes(value.outcome) ? value.outcome : 'uncertain';
    super('host ' + outcome + ': ' + String(value.message).slice(0, 1024));
    this.outcome = outcome;
    this.busy = outcome === 'refused' && (value.busy === true || /^(host busy:|busy$)/.test(String(value.message)));
  }
}
export async function staleControl(config: string, host: string) {
  const options = execFileSync('ssh', ['-F', config, '-T', '-G', host], { maxBuffer: 128 * 1024 }).toString();
  const path = /^controlpath (.+)$/m.exec(options)?.[1];
  if (!path || path === 'none') return;
  let before;
  try { before = await fs.lstat(path); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  if (!before.isSocket()) throw new Error('SSH control path is not a socket');
  try { execFileSync('ssh', ['-F', config, '-O', 'check', host], { timeout: 1000, stdio: 'pipe' }); }
  catch (e: any) {
    if (e.status !== 255) throw new RetryableFailure('SSH control master did not answer; no job dispatched');
    try {
      const after = await fs.lstat(path);
      if (after.ino === before.ino && after.dev === before.dev) await fs.unlink(path);
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function configuredHosts() {
  const path = process.env.CHALDEA_EXEC_HOSTS ?? join(homedir(), '.config/chaldea/exec-hosts');
  try { return hostsFor(await fs.readFile(path, 'utf8')); }
  catch (e: any) {
    if (e.code === 'ENOENT') throw new Error(oneLine('missing exec host list ' + path + '; --host H works without it'));
    throw e;
  }
}

export async function run(args: string[]): Promise<number> {
  const options = argumentsFor(args);
  const automatic = options.host === undefined;
  const hosts = automatic ? await configuredHosts() : [options.host!];
  const failures: string[] = [];
  const busy: string[] = [];
  for (const host of hosts) {
    let reason: string;
    if (automatic && isLocalHost(host)) reason = 'local host';
    else {
      try {
        const code = await runOnHost({ ...options, host }, automatic || !options.noQueue);
        if (automatic) process.stderr.write('chaldea ran on ' + host + '\n');
        return code;
      } catch (e) {
        if (!(e instanceof RetryableFailure) || (!automatic && options.noQueue)) throw e;
        if (e.busy) busy.push(host);
        reason = oneLine(e.reason);
      }
    }
    failures.push(host + ' (' + reason + ')');
    process.stderr.write('chaldea skipped ' + host + ': ' + reason + '\n');
  }
  if (!options.noQueue && busy.length) {
    process.stderr.write('chaldea queued: all job slots busy on ' + busy.join(', ') + '\n');
    const config = process.env.CHALDEA_SSH_CONFIG ?? join(homedir(), '.ssh/chaldea-job.conf');
    try {
      const selected = await queueHost(config, busy, options.queueTimeout, host => staleControl(config, 'chaldea-job-' + host));
      if (selected) {
        process.stderr.write('chaldea selected ' + selected.host + '\n');
        try {
          const code = await runOnHost({ ...options, host: selected.host }, false, selected.transport);
          process.stderr.write('chaldea ran on ' + selected.host + '\n');
          return code;
        } finally { selected.transport.ssh.stdin.destroy(); selected.transport.ssh.kill('SIGTERM'); }
      }
    } catch (error) {
      if ((error as Error).message !== 'queue timeout') throw error;
      process.stderr.write('chaldea: queue timeout\n');
      return EXIT_UNAVAILABLE;
    }
  }
  process.stderr.write('chaldea: no available exec host: ' + (failures.join('; ') || 'empty host list') + '\n');
  return EXIT_UNAVAILABLE;
}

// Only local accounting is serialized. The remote server owns job admission.
async function withStateLock<T>(state: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const lock = await fs.open(join(state, 'accounting.lock'), 'a', 0o600);
  try {
    // Async wait also works for concurrent run() calls within one process.
    const child = spawn('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'pipe', lock.fd] });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    if (code !== 0) throw new Error('local accounting lock failed (flock exit ' + code + ')');
    return await action();
  } finally { await lock.close(); }
}

async function runOnHost(options: ReturnType<typeof argumentsFor> & { host: string }, automatic: boolean, queued?: Transport): Promise<number> {
  const snapshot = await manifest();
  const artifactRoot = join(snapshot.root, '.chaldea/artifacts');
  const state = process.env.CHALDEA_STATE_DIR ?? join(homedir(), '.local/state/chaldea/exec');
  const journal = join(state, 'journal');
  const controls = join(state, 'ssh');
  await fs.mkdir(controls, { recursive: true, mode: 0o700 });
  const config = process.env.CHALDEA_SSH_CONFIG ?? join(homedir(), '.ssh/chaldea-job.conf');
  try { await staleControl(config, 'chaldea-job-' + options.host); }
  catch (e) {
    if (!automatic || !(e instanceof RetryableFailure)) throw e;
    const refused: Intent = { jobId: randomUUID(), host: options.host, argv: options.argv,
      started: new Date().toISOString(), outcome: 'refused' };
    await withStateLock(state, async () => {
      await prune(journal, DAYS, 999);
      if ((await fs.readdir(journal)).filter(x => x.endsWith('.json')).length >= 1000) throw new Error('journal at its 1000-entry cap; inspect retained outcomes before dispatch');
      await record(journal, refused);
    });
    throw new RetryableFailure(e.message + '; inspect journal ' + join(journal, refused.jobId + '.json'), e.reason);
  }
  const jobId = randomUUID();
  const intent: Intent = { jobId, host: options.host, argv: options.argv,
    started: new Date().toISOString(), pid: process.pid, bootId: BOOT_ID, outcome: 'uncertain',
    worktree: snapshot.root, artifactDir: join(artifactRoot, jobId),
    artifactReserve: options.artifacts.length ? MAX_ARTIFACT : 0 };
  // This fsync completes before the first possible remote side effect. Nothing
  // ever automatically retries an uncertain intent, including on a later invocation.
  await withStateLock(state, async () => {
    await fs.mkdir(journal, { recursive: true, mode: 0o700 });
    await cleanArtifacts(journal, options.host, intent.artifactReserve);
    await prune(journal, DAYS, 999);
    if ((await fs.readdir(journal)).filter(x => x.endsWith('.json')).length >= 1000) throw new Error('journal at its 1000-entry cap; inspect retained outcomes before dispatch');
    await record(journal, intent);
  });
  process.stderr.write('chaldea job ' + jobId + '\n');
  const transport = queued ?? connect(config, options.host);
  const ssh = transport.ssh;
  const exit = transport.exit;
  void exit.catch(() => {}); // spawn errors can precede the first protocol read
  // Attach error handlers immediately: a host can refuse while input is uploading.
  let writeError: Error | undefined;
  ssh.stdin.on('error', e => { writeError = e; });
  const stop = () => { ssh.stdin.destroy(); ssh.kill('SIGTERM'); };
  let interrupted = false;
  const interrupt = () => { interrupted = true; stop(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let artifact: fs.FileHandle | undefined;
  let artifactRemaining = 0; let received = 0; const seen = new Set<string>();
  let result: number | undefined;
  let upload: Promise<void> | undefined;
  let requestSent = false; let started = false;
  const destination = join(artifactRoot, jobId);
  try {
    const incoming = transport.incoming;
    const hello = queued ? { done: false, value: { type: 'H', data: json({ version: VERSION }) } } : await incoming.next();
    if (hello.done && automatic) {
      await exit.catch(() => {});
      throw new RetryableFailure('connection closed before job request');
    }
    if (!hello.done && hello.value.type === 'R') throw new RemoteFailure(hello.value.data);
    if (hello.done || hello.value.type !== 'H' || JSON.parse(hello.value.data.toString()).version !== VERSION) {
      throw new Error('unsupported job protocol');
    }
    const request: Request = { version: VERSION, jobId, argv: options.argv, gpu: options.gpu,
      cwd: snapshot.cwd, artifacts: options.artifacts, files: snapshot.files.map(({ data, ...entry }) => entry) };
    upload = (async () => {
      requestSent = true; // any write attempt is uncertain, even if it fails
      if (queued) await send(ssh.stdin, 'G');
      await send(ssh.stdin, 'Q', json(request));
      for (const file of snapshot.files) for (let offset = 0; offset < file.size; offset += CHUNK) {
        if (writeError) throw writeError;
        await send(ssh.stdin, 'B', file.data.subarray(offset, offset + CHUNK));
      }
      await send(ssh.stdin, 'E');
      // Deliberately keep stdin open: EOF is the server's disconnect signal.
    })();
    let uploadError: unknown;
    void upload.catch(e => { uploadError = e; ssh.stdin.destroy(); });
    for (;;) {
      const item = await incoming.next(); if (item.done) break;
      const { type, data } = item.value;
      if (result !== undefined) throw new Error('frame after result');
      if (['O', 'S', 'A', 'B', 'X'].includes(type)) started = true;
      if (type === 'O' || type === 'S') {
        if (artifactRemaining) throw new Error('interrupted artifact');
        const output = type === 'O' ? process.stdout : process.stderr;
        if (!output.write(data)) await once(output, 'drain');
      } else if (type === 'A') {
        if (artifactRemaining) throw new Error('truncated artifact');
        if (artifact) { await artifact.close(); artifact = undefined; }
        const meta = JSON.parse(data.toString()); safePath(meta.path);
        if (!options.artifacts.includes(meta.path) || seen.has(meta.path) ||
            !Number.isSafeInteger(meta.size) || meta.size < 0 || (received += meta.size) > MAX_ARTIFACT) {
          throw new Error('invalid artifact metadata');
        }
        seen.add(meta.path);
        for (const directory of [dirname(artifactRoot), artifactRoot]) {
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const st = await fs.lstat(directory);
          if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('artifact directory must not be a symlink');
        }
        const target = join(destination, meta.path);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        artifact = await fs.open(target, 'wx', 0o600);
        artifactRemaining = meta.size;
      } else if (type === 'B') {
        if (!artifact || !data.length || data.length > artifactRemaining) throw new Error('invalid artifact data');
        await artifact.writeFile(data); artifactRemaining -= data.length;
      } else if (type === 'X') {
        if (artifactRemaining) throw new Error('truncated artifact');
        const code = JSON.parse(data.toString()).exitCode;
        if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error('invalid exit status');
        result = code;
        ssh.stdin.end();
      } else if (type === 'R') {
        throw new RemoteFailure(data);
      } else throw new Error('unexpected protocol frame');
    }
    if (uploadError) throw uploadError;
    await upload;
    const sshCode = await exit;
    if (result === undefined || sshCode !== 0) throw new Error('connection lost before a confirmed result');
    if (artifact) { await artifact.sync(); await artifact.close(); artifact = undefined; }
    intent.outcome = 'finished'; intent.exitCode = result;
    await withStateLock(state, () => record(journal, intent, false));
    return result;
  } catch (e) {
    stop();
    await exit.catch(() => {});
    const retry = automatic && fallbackAllowed(e instanceof RemoteFailure ? e.outcome :
      e instanceof RetryableFailure ? 'connection-failed' : 'uncertain', requestSent, started, interrupted);
    if (retry || (e instanceof RemoteFailure && e.outcome !== 'uncertain' && (!automatic || e.outcome === 'preempted'))) {
      intent.outcome = retry ? 'refused' : (e as RemoteFailure).outcome;
      await withStateLock(state, () => record(journal, intent, false));
    }
    const message = (e as Error).message + '; outcome ' + intent.outcome + '; inspect journal ' + join(journal, jobId + '.json');
    if (retry) throw new RetryableFailure(message, (e as Error).message, e instanceof RemoteFailure && e.busy);
    throw new Error(message);
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (artifact) await artifact.close();
    await withStateLock(state, async () => {
      await prune(journal);
      await cleanArtifacts(journal, options.host);
    });
  }
}
