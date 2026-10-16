import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { frame, frames, json, VERSION } from '../../src/exec/protocol.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const server = process.env.CHALDEA_JOB_SERVER ?? resolve(repo, '../fleet-config-jobhost/roles/chaldea_job_host/files/chaldea-job-server');
const cli = join(repo, 'bin/chaldea');

async function collected(child: ChildProcess) {
  let out = ''; let err = '';
  child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  const [code, signal] = await once(child, 'close');
  clearTimeout(timeout);
  return { code, signal, out, err };
}
function disappearance(root: string, jobId: string) {
  let watcher: ReturnType<typeof watch>;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { watcher.close(); reject(new Error('workspace not deleted after disconnect')); }, 5000);
    watcher = watch(root, async (_, name) => {
      if (name !== jobId) return;
      try { await fs.stat(join(root, jobId)); }
      catch (e: any) { if (e.code === 'ENOENT') { clearTimeout(timeout); watcher.close(); resolve(); } }
    });
  });
}

test('unprivileged SSH forced command + real bubblewrap', { timeout: 45000 }, async t => {
  assert.notEqual(tmpdir(), '/tmp', 'set TMPDIR to a disk-backed scratch directory');
  assert.notEqual(userInfo().uid, 0, 'must run without root');
  const scratch = await fs.mkdtemp(join(tmpdir(), 'chaldea-e2e-'));
  // Unix-domain socket paths are limited to 108 bytes, including %C's hash.
  const state = await fs.mkdtemp(join(tmpdir(), 's-')); const jobroot = join(scratch, 'jobs');
  const work = join(scratch, 'work'); const config = join(scratch, 'server.json');
  const sshConfig = join(scratch, 'ssh.conf');
  let daemon: ChildProcess | undefined;
  let daemonLog = '';
  const env = { ...process.env, CHALDEA_STATE_DIR: state, CHALDEA_SSH_CONFIG: sshConfig };
  let port: number;
  const listener = net.createServer();
  await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
  port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>(r => listener.close(() => r()));
  const hostKey = join(scratch, 'host_key'); const clientKey = join(scratch, 'client_key');
  const controls = join(state, 'mux');
  function ssh(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    return spawn('ssh', ['-F', sshConfig, '-o', 'BatchMode=yes', '-o', 'IdentityAgent=' + (overrides.SSH_AUTH_SOCK ?? 'none'), ...args], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const run = (args: string[]) => spawn(process.execPath, [cli, 'exec', '--host', 'test', ...args], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  async function configure(extra: object = {}) {
    await fs.writeFile(config, JSON.stringify({ state_root: jobroot, ...extra }));
  }
  try {
    await fs.mkdir(work); await fs.mkdir(jobroot);
    execFileSync('git', ['-C', work, 'init', '-q']);
    await fs.writeFile(join(work, 'input'), 'dirty worktree');
    // Ephemeral fixture keys only; never touch ~/.ssh or the user's agent.
    for (const path of [hostKey, clientKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { stdio: 'ignore' });
    const pub = (await fs.readFile(clientKey + '.pub', 'utf8')).trim();
    await fs.writeFile(join(scratch, 'authorized_keys'),
      'restrict,from="127.0.0.1",command="/usr/bin/python3 ' + server + ' --config ' + config + '" ' + pub + '\n');
    const hostPub = execFileSync('ssh-keygen', ['-y', '-f', hostKey]).toString().trim();
    await fs.writeFile(join(scratch, 'known_hosts'), '[127.0.0.1]:' + port + ' ' + hostPub + '\n');
    await fs.writeFile(sshConfig, `Host chaldea-job-test
  HostName 127.0.0.1
  Port ${port}
  User ${userInfo().username}
  IdentityFile ${clientKey}
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile ${join(scratch, 'known_hosts')}
  ControlMaster auto
  ControlPersist 60
  ControlPath ${controls}
`);
    await configure();
    await fs.writeFile(join(scratch, 'sshd.conf'), `Port ${port}
ListenAddress 127.0.0.1
HostKey ${hostKey}
PidFile ${join(scratch, 'sshd.pid')}
AuthorizedKeysFile ${join(scratch, 'authorized_keys')}
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers ${userInfo().username}
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
LogLevel VERBOSE
`);
    execFileSync('/usr/bin/sshd', ['-t', '-f', join(scratch, 'sshd.conf')], { stdio: 'pipe' });
    daemon = spawn('/usr/bin/sshd', ['-D', '-e', '-f', join(scratch, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sshd startup: ' + daemonLog)), 5000);
      daemon!.stderr!.on('data', x => {
        daemonLog = (daemonLog + x).slice(-65536);
        if (daemonLog.includes('Server listening')) { clearTimeout(timeout); resolve(); }
      });
      daemon!.once('exit', () => { clearTimeout(timeout); reject(new Error('sshd exited: ' + daemonLog)); });
    });

    await t.test('live stdout/stderr, exit status, artifacts, cleanup, multiplexed start under 2 seconds', async () => {
      const first = run(['--artifact', 'out/result', '--', 'python3', '-c',
        'import pathlib,sys,time; print("live",flush=True); print("stderr-live",file=sys.stderr,flush=True); time.sleep(.6); pathlib.Path("out").mkdir(); pathlib.Path("out/result").write_text(pathlib.Path("input").read_text()); sys.exit(7)']);
      let live = 0; first.stdout!.once('data', () => { live = performance.now(); });
      const result = await collected(first); const ended = performance.now();
      assert.equal(result.code, 7, result.err); assert.match(result.out, /live/); assert.match(result.err, /stderr-live/);
      assert.ok(ended - live > 400, 'stdout must arrive while command is still running');
      const id = /chaldea job ([0-9a-f-]+)/.exec(result.err)![1];
      assert.equal(await fs.readFile(join(work, '.chaldea/artifacts', id, 'out/result'), 'utf8'), 'dirty worktree');
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
      const started = performance.now(); let latency = 0;
      const second = run(['--', 'printf', 'second-live']);
      second.stdout!.once('data', () => { latency = performance.now() - started; });
      const again = await collected(second);
      assert.equal(again.code, 0, again.err); assert.equal(again.out, 'second-live');
      assert.ok(latency < 2000, 'multiplexed start latency ' + latency);
      t.diagnostic('multiplexed start latency: ' + latency.toFixed(1) + ' ms (client spawn to first remote stdout)');
      const master = await collected(ssh(['-O', 'check', 'chaldea-job-test']));
      assert.equal(master.code, 0, master.err);
      assert.equal(JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8')).exitCode, 7);
    });

    await t.test('SSH shell, command injection, PTY, remote/local forwarding and agent are refused', async () => {
      for (const args of [
        ['chaldea-job-test'], ['chaldea-job-test', 'sh', '-c', 'echo escaped'],
        ['-tt', 'chaldea-job-test', 'sh'],
        ['-N', '-o', 'ExitOnForwardFailure=yes', '-R', '0:127.0.0.1:22', 'chaldea-job-test'],
        ['-W', '127.0.0.1:22', 'chaldea-job-test'],
      ]) {
        const result = await collected(ssh(args));
        assert.notEqual(result.code, 0); assert.doesNotMatch(result.out, /escaped/);
      }
      // Request an agent explicitly with a disposable listening socket. The
      // forced server rejects any SSH_AUTH_SOCK before its protocol handshake.
      const fakeAgent = net.createServer(socket => socket.destroy());
      const sock = join(scratch, 'agent.sock');
      await new Promise<void>(r => fakeAgent.listen(sock, r));
      try {
        const child = ssh(['-S', 'none', '-o', 'ControlMaster=no', '-o', 'ControlPersist=no', '-A', 'chaldea-job-test', 'chaldea-exec-v0'], { SSH_AUTH_SOCK: sock });
        const incoming = frames(child.stdout!)[Symbol.asyncIterator]();
        const hello = await incoming.next();
        assert.equal(hello.value!.type, 'H', 'agent must not reach forced server environment');
        child.stdin!.end(Buffer.concat([frame('Q', json({ version: VERSION, jobId: randomUUID(), argv: ['true'], cwd: '', gpu: false, artifacts: [], files: [] })), frame('E')]));
        // Closing the protocol input deliberately cancels this disposable job.
        const done = once(child, 'close');
        while (!(await incoming.next()).done) { /* drain the protocol before awaiting pipe closure */ }
        await done;
      } finally { await new Promise<void>(r => fakeAgent.close(() => r())); }
    });

    await t.test('host sockets, credentials, original HOME, GPU, and sudo are inaccessible', async () => {
      const code = `import glob,os,pathlib,subprocess
assert not glob.glob('/run/user/*/huyang*')
assert not pathlib.Path('/run/user').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/run/docker.sock').exists()
assert 'SSH_AUTH_SOCK' not in os.environ
assert 'DBUS_SESSION_BUS_ADDRESS' not in os.environ
assert not pathlib.Path(os.path.expanduser('~/.ssh')).exists()
assert not pathlib.Path('/home/${userInfo().username}/.ssh').exists()
assert not pathlib.Path('/etc/shadow').exists()
assert not glob.glob('/dev/nvidia*') and not glob.glob('/dev/dri/*')
# Invalid empty-name ioctl payloads cannot create anything even if this guard
# regresses; without seccomp they return EINVAL/ENOTTY rather than EPERM.
import fcntl,errno
fd=os.open('/work',os.O_RDONLY)
try:
    for request in (0x50009401,0x5000940e,0x50009417,0x50009418,0x4008941a):
        try:
            fcntl.ioctl(fd,request,bytearray(4096),True)
            raise AssertionError('Btrfs quota escape ioctl accepted')
        except OSError as error: assert error.errno == errno.EPERM, error
finally: os.close(fd)
try:
    result=subprocess.run(['sudo','-n','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    assert result.returncode != 0
except FileNotFoundError: pass
print('isolation-ok')
`;
      const result = await collected(run(['--', 'python3', '-c', code]));
      assert.equal(result.code, 0, result.err); assert.match(result.out, /isolation-ok/);
      const gpu = await collected(run(['--gpu', '--', 'true']));
      assert.equal(gpu.code, 125); assert.match(gpu.err, /GPU unavailable/);
    });

    await t.test('cleanup survives unreadable job-created directories', async () => {
      const result = await collected(run(['--', 'python3', '-c',
        'import os; os.mkdir("locked"); os.chmod("locked",0); os.chmod(".",0); raise SystemExit(9)']));
      assert.equal(result.code, 9, result.err);
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
    });

    await t.test('lost client kills the entire job group and keeps durable outcome uncertain', async () => {
      const marker = 'chaldea-disconnect-' + randomUUID();
      const child = run(['--', 'python3', '-c', 'import subprocess,sys,time; subprocess.Popen(["python3","-c","import time; time.sleep(100)",sys.argv[1]+"-descendant"],start_new_session=True); print("started",flush=True); time.sleep(100)', marker]);
      let stderr = ''; child.stderr!.on('data', x => { stderr += x; });
      await Promise.race([once(child.stdout!, 'data'), once(child, 'close').then(() => { throw new Error('job exited before streaming: ' + stderr); })]);
      const id = /chaldea job ([0-9a-f-]+)/.exec(stderr)![1];
      const processList = execFileSync('ps', ['-u', userInfo().username, '-o', 'pid=,args=']).toString();
      const pids = processList.split('\n').filter(line => line.includes(marker)).map(line => Number(line.trim().split(/\s/)[0]));
      assert.ok(pids.length > 0);
      const deleted = disappearance(jobroot, id);
      const closed = once(child, 'close');
      child.kill('SIGKILL'); await deleted; await closed;
      for (const pid of pids) {
        try { const status = await fs.readFile('/proc/' + pid + '/stat', 'utf8'); assert.match(status, /\) Z /); }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
      const intent = JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8'));
      assert.equal(intent.outcome, 'uncertain');
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
    });

    await t.test('host refuses over-cap and disk-full admission; no workspace remains', async () => {
      for (const extra of [{ state_cap_bytes: 32 * 1024 ** 2 }, { min_free_bytes: Number.MAX_SAFE_INTEGER }]) {
        await configure(extra);
        const result = await collected(run(['--', 'true']));
        assert.equal(result.code, 125); assert.match(result.err, /over cap|disk full/);
        assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
      }
      await configure();
    });
  } finally {
    await collected(ssh(['-O', 'exit', 'chaldea-job-test'])).catch(() => {});
    if (daemon) { const done = once(daemon, 'close'); daemon.kill('SIGTERM'); await done; }
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
});
