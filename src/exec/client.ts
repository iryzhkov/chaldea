import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { manifest } from './manifest.ts';
import { record, prune, DAYS, type Intent } from './journal.ts';
import { frames, send, json, safePath, VERSION, CHUNK, MAX_ARTIFACT, type Request } from './protocol.ts';

export function argumentsFor(args: string[]) {
  let host = ''; let gpu = false; const artifacts: string[] = [];
  let i = args[0] === 'exec' ? 1 : -1;
  if (i < 0) throw new Error('usage: chaldea exec --host H [--artifact PATH] [--gpu] -- CMD...');
  while (i < args.length && args[i] !== '--') {
    const flag = args[i++];
    if (flag === '--host') host = args[i++] ?? '';
    else if (flag === '--artifact') { const path = args[i++]; safePath(path); artifacts.push(path); }
    else if (flag === '--gpu') gpu = true;
    else throw new Error('unknown option: ' + flag);
  }
  const argv = args.slice(i + 1);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(host) || args[i] !== '--' || !argv.length ||
      argv.length > 256 || argv.some(x => x.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 16384 ||
      artifacts.length > 32 || new Set(artifacts).size !== artifacts.length) throw new Error('invalid exec arguments');
  return { host, gpu, artifacts, argv };
}

async function artifactCleanup(root: string, checkSpace = true) {
  for (const directory of [dirname(root), root]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('artifact directory must not be a symlink');
  }
  let total = 0;
  async function size(path: string): Promise<number> {
    const st = await fs.lstat(path);
    if (!st.isDirectory()) return st.size;
    return (await Promise.all((await fs.readdir(path)).map(n => size(join(path, n))))).reduce((a, b) => a + b, 0);
  }
  for (const name of await fs.readdir(root)) {
    const path = join(root, name); const st = await fs.lstat(path);
    if (st.mtimeMs < Date.now() - DAYS) await fs.rm(path, { recursive: true, force: true });
    else total += await size(path);
  }
  if (checkSpace && total + MAX_ARTIFACT > 20 * 1024 ** 3) throw new Error('local artifacts near 20 GiB cap; remove artifacts before dispatch');
}

export async function run(args: string[]): Promise<number> {
  const options = argumentsFor(args);
  const snapshot = await manifest();
  const artifactRoot = join(snapshot.root, '.chaldea/artifacts');
  await artifactCleanup(artifactRoot);
  const state = process.env.CHALDEA_STATE_DIR ?? join(homedir(), '.local/state/chaldea/exec');
  const journal = join(state, 'journal');
  await prune(journal, DAYS, 999);
  if ((await fs.readdir(journal)).length >= 1000) throw new Error('journal at its 1000-entry cap; inspect retained outcomes before dispatch');
  const jobId = randomUUID();
  const intent: Intent = { jobId, host: options.host, argv: options.argv,
    started: new Date().toISOString(), pid: process.pid, outcome: 'uncertain' };
  // This fsync completes before the first possible remote side effect. Nothing
  // ever automatically retries an uncertain intent, including on a later invocation.
  await record(journal, intent);
  process.stderr.write('chaldea job ' + jobId + '\n');
  const controls = join(state, 'ssh');
  await fs.mkdir(controls, { recursive: true, mode: 0o700 });
  const config = process.env.CHALDEA_SSH_CONFIG ?? join(homedir(), '.ssh/chaldea-job.conf');
  const ssh = spawn('ssh', ['-F', config, '-T', '-a', '-x',
    '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60',
    'chaldea-job-' + options.host, 'chaldea-exec-v0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => { ssh.once('error', reject); ssh.once('close', resolve); });
  // Attach error handlers immediately: a host can refuse while input is uploading.
  let writeError: Error | undefined;
  ssh.stdin.on('error', e => { writeError = e; });
  ssh.stderr.pipe(process.stderr, { end: false });
  const stop = () => { ssh.stdin.destroy(); ssh.kill('SIGTERM'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let artifact: fs.FileHandle | undefined;
  let artifactRemaining = 0; let received = 0; const seen = new Set<string>();
  let result: number | undefined;
  let upload: Promise<void> | undefined;
  const destination = join(artifactRoot, jobId);
  try {
    const incoming = frames(ssh.stdout)[Symbol.asyncIterator]();
    const hello = await incoming.next();
    if (!hello.done && hello.value.type === 'R') throw new Error('host refused job: ' + String(JSON.parse(hello.value.data.toString()).message).slice(0, 1024));
    if (hello.done || hello.value.type !== 'H' || JSON.parse(hello.value.data.toString()).version !== VERSION) {
      throw new Error('unsupported job protocol');
    }
    const request: Request = { version: VERSION, jobId, argv: options.argv, gpu: options.gpu,
      cwd: snapshot.cwd, artifacts: options.artifacts, files: snapshot.files.map(({ data, ...entry }) => entry) };
    upload = (async () => {
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
        const message = JSON.parse(data.toString()).message;
        throw new Error('host refused job: ' + String(message).slice(0, 1024));
      } else throw new Error('unexpected protocol frame');
    }
    if (uploadError) throw uploadError;
    await upload;
    const sshCode = await exit;
    if (result === undefined || sshCode !== 0) throw new Error('connection lost before a confirmed result');
    if (artifact) { await artifact.sync(); await artifact.close(); artifact = undefined; }
    intent.outcome = 'finished'; intent.exitCode = result;
    await record(journal, intent, false);
    return result;
  } catch (e) {
    stop();
    await exit.catch(() => {});
    // Partial artifacts have no success meaning; the durable intent stays uncertain.
    throw new Error((e as Error).message + '; outcome uncertain; inspect journal ' + join(journal, jobId + '.json'));
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (artifact) await artifact.close();
    await prune(journal);
    await artifactCleanup(artifactRoot, false);
  }
}
