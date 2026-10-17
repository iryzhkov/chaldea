import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { frame, frames, json, VERSION } from '../../src/exec/protocol.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const server = process.env.CHALDEA_JOB_SERVER;
if (!server) throw new Error('CHALDEA_JOB_SERVER must point to the reviewed role files/chaldea-job-server; no sibling checkout fallback');
const role = dirname(dirname(server));
const cli = join(repo, 'bin/chaldea');
const sshd = process.env.CHALDEA_SSHD ?? '/usr/bin/sshd';

async function collected(child: ChildProcess, timeoutMs = 10000) {
  let out = ''; let err = '';
  child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
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

test('unprivileged SSH forced command + real bubblewrap', { timeout: 65000 }, async t => {
  assert.notEqual(tmpdir(), '/tmp', 'set TMPDIR to a disk-backed scratch directory');
  assert.notEqual(userInfo().uid, 0, 'must run without root');
  const pasta = process.env.CHALDEA_PASTA ?? '/usr/bin/pasta';
  await fs.access(pasta).catch(() => { throw new Error('System pasta is absent: install passt through approved provisioning, or explicitly set CHALDEA_PASTA to an extracted distro package for compatibility testing'); });
  t.diagnostic('pasta binary: ' + pasta + (process.env.CHALDEA_PASTA ? ' (explicit override)' : ' (system)'));
  const scratch = await fs.mkdtemp(join(tmpdir(), 'chaldea-e2e-'));
  // Unix-domain socket paths are limited to 108 bytes, including %C's hash.
  const state = await fs.mkdtemp(join(tmpdir(), 's-')); const jobroot = join(scratch, 'jobs');
  const work = join(scratch, 'work'); const config = join(scratch, 'server.json');
  const sshConfig = join(scratch, 'ssh.conf');
  let daemon: ChildProcess | undefined;
  let daemonLog = '';
  const home = join(scratch, 'home');
  assert.ok(home.startsWith(scratch + '/'), 'fixture HOME must be scratch');
  const env = { ...process.env, HOME: home, CHALDEA_STATE_DIR: state, CHALDEA_SSH_CONFIG: sshConfig };
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
    await fs.writeFile(config, JSON.stringify({ state_root: jobroot, require_mount: false, pasta_binary: pasta, ...extra }));
  }
  try {
    await fs.mkdir(home); await fs.mkdir(work); await fs.mkdir(jobroot);
    execFileSync('git', ['-C', work, 'init', '-q']);
    await fs.writeFile(join(work, 'input'), 'dirty worktree');
    // Ephemeral fixture keys only; never touch ~/.ssh or the user's agent.
    for (const path of [hostKey, clientKey]) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { stdio: 'ignore' });
    const pub = (await fs.readFile(clientKey + '.pub', 'utf8')).trim();

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
    execFileSync(process.env.CHALDEA_TEST_PYTHON ?? 'python3', ['-I', join(repo, 'test/exec/render.py'), role, scratch,
      JSON.stringify({
        chaldea_job_host_port: port, chaldea_job_host_user: userInfo().username,
        chaldea_job_host_listen: ['127.0.0.1'], chaldea_job_host_pid_file: join(scratch, 'sshd.pid'),
        chaldea_job_host_host_key: hostKey, chaldea_job_host_authorized_keys: join(scratch, 'authorized_keys'),
        chaldea_job_host_log_level: 'VERBOSE',
        chaldea_job_host_command: '/usr/bin/python3 -I ' + server + ' --config ' + config,
        chaldea_job_host_sources: [{ ip: '127.0.0.1', public_key: pub }]
      })], { stdio: 'pipe' });
    execFileSync(sshd, ['-t', '-f', join(scratch, 'sshd.conf')], { stdio: 'pipe' });
    daemon = spawn(sshd, ['-D', '-e', '-f', join(scratch, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sshd startup: ' + daemonLog)), 5000);
      daemon!.stderr!.on('data', x => {
        daemonLog = (daemonLog + x).slice(-65536);
        if (daemonLog.includes('Server listening')) { clearTimeout(timeout); resolve(); }
      });
      daemon!.once('exit', () => { clearTimeout(timeout); reject(new Error('sshd exited: ' + daemonLog)); });
    });

    await t.test('apply-time smoke uses the exact installed pasta/bwrap launch', async () => {
      const result = execFileSync('/usr/bin/python3', ['-I', server, '--config', config, '--smoke-test'], { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.trim(), 'sandbox-smoke-ok');
      assert.deepEqual((await fs.readdir(jobroot)).filter(name => name !== 'admission.lock'), []);
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

    await t.test('full single-slot server reports a durable refusal', async () => {
      const first = run(['--', 'python3', '-c', 'import time; print("locked",flush=True); time.sleep(100)']);
      let stderr = ''; first.stderr!.on('data', x => { stderr += x; });
      await Promise.race([once(first.stdout!, 'data'), once(first, 'close').then(() => { throw new Error(stderr); })]);
      const result = await collected(run(['--', 'printf', 'must-not-run']));
      assert.equal(result.code, 255); assert.equal(result.out, '');
      assert.match(result.err, /host refused: host busy/);
      const entries = await Promise.all((await fs.readdir(join(state, 'journal'))).filter(x => x.endsWith('.json')).map(async x => JSON.parse(await fs.readFile(join(state, 'journal', x), 'utf8'))));
      assert.ok(entries.some(x => x.outcome === 'refused' && x.argv.includes('must-not-run')));
      const id = /chaldea job ([0-9a-f-]+)/.exec(stderr)![1];
      const removed = disappearance(jobroot, id);
      const exited = once(first, 'close'); first.kill('SIGKILL');
      await exited; await removed;
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
assert os.statvfs('/dev/shm').f_blocks * os.statvfs('/dev/shm').f_frsize == 64*1024**2
try:
    result=subprocess.run(['sudo','-n','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    assert result.returncode != 0
except FileNotFoundError: pass
print('isolation-ok')
`;
      const result = await collected(run(['--', 'python3', '-c', code]));
      assert.equal(result.code, 0, result.err); assert.match(result.out, /isolation-ok/);
      const gpu = await collected(run(['--gpu', '--', 'true']));
      assert.equal(gpu.code, 255); assert.match(gpu.err, /GPU unavailable/);
    });

    await t.test('cleanup survives unreadable job-created directories', async () => {
      const result = await collected(run(['--', 'python3', '-c',
        'import os; os.mkdir("locked"); os.chmod("locked",0); os.chmod(".",0); raise SystemExit(9)']));
      assert.equal(result.code, 9, result.err);
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
    });

    await t.test('lost client kills the entire job group and keeps durable outcome uncertain', async () => {
      const marker = 'chaldea-disconnect-' + randomUUID();
      const child = run(['--', 'python3', '-c', 'import subprocess,sys,time; subprocess.Popen(["python3","-c","import time; time.sleep(100)",sys.argv[1]+"-descendant"],start_new_session=True); print("started",flush=True); __import__("os").close(1); __import__("os").close(2); time.sleep(100)', marker]);
      let stderr = ''; child.stderr!.on('data', x => { stderr += x; });
      await Promise.race([once(child.stdout!, 'data'), once(child, 'close').then(() => { throw new Error('job exited before streaming: ' + stderr); })]);
      const id = /chaldea job ([0-9a-f-]+)/.exec(stderr)![1];
      const processList = execFileSync('ps', ['-u', userInfo().username, '-o', 'pid=,args=']).toString();
      const pids = processList.split('\n').filter(line => line.includes(marker)).map(line => Number(line.trim().split(/\s/)[0]));
      assert.ok(pids.length > 0);
      await new Promise(resolve => setTimeout(resolve, 100)); // pipes have closed, process still runs
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

    await t.test('target forced-server crash leaves uncertainty, kills the job and next startup recovers', async () => {
      const marker = 'chaldea-target-crash-' + randomUUID();
      const child = run(['--', 'python3', '-c', 'import time; print("ready",flush=True); time.sleep(100)', marker]);
      let stderr = ''; child.stderr!.on('data', x => { stderr += x; });
      const resultPromise = collected(child);
      await once(child.stdout!, 'data');
      const id = /chaldea job ([0-9a-f-]+)/.exec(stderr)![1];
      const table = execFileSync('ps', ['-u', userInfo().username, '-o', 'pid=,args=']).toString().split('\n');
      const serverPids = table.filter(line => line.includes('--config ' + config))
        .map(line => Number(line.trim().split(/\s/)[0]));
      const jobPids = table.filter(line => line.includes(marker))
        .map(line => Number(line.trim().split(/\s/)[0]));
      assert.equal(serverPids.length, 1);
      process.kill(serverPids[0], 'SIGKILL');
      const lost = await resultPromise;
      assert.equal(lost.code, 255); assert.match(lost.err, /uncertain/);
      assert.equal(JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8')).outcome, 'uncertain');
      const recovered = await collected(run(['--', 'printf', 'recovered']));
      assert.equal(recovered.code, 0, recovered.err); assert.equal(recovered.out, 'recovered');
      for (const pid of jobPids) {
        try { assert.match(await fs.readFile('/proc/' + pid + '/stat', 'utf8'), /\) Z /); }
        catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
    });

    await t.test('private network hides host TCP listeners, every host address and abstract sockets', async () => {
      const tcp = net.createServer(socket => socket.end('host-only'));
      await new Promise<void>(r => tcp.listen(0, '0.0.0.0', r));
      const tcpPort = (tcp.address() as net.AddressInfo).port;
      const abstractName = 'chaldea-host-only-' + randomUUID();
      const abstract = net.createServer(socket => socket.end('host-only'));
      await new Promise<void>(r => abstract.listen('\0' + abstractName, r));
      try {
        const addresses = JSON.parse(execFileSync('ip', ['-j', 'address', 'show']).toString())
          .flatMap((row: any) => row.addr_info.map((a: any) => a.local));
        const code = `import socket,json,errno
addresses=json.loads(${JSON.stringify(JSON.stringify(addresses))})
for address in addresses:
    sock=socket.socket(socket.AF_INET6 if ':' in address else socket.AF_INET)
    sock.settimeout(.3)
    try:
        sock.connect((address,${tcpPort}))
        raise AssertionError('host address reachable: '+address)
    except OSError: pass
    finally: sock.close()
sock=socket.socket(socket.AF_UNIX)
try:
    sock.connect('\\0${abstractName}')
    raise AssertionError('host abstract socket reachable')
except OSError: pass
finally: sock.close()
assert '${abstractName}' not in open('/proc/net/unix').read()
# The job's own loopback remains usable; it is not host loopback.
local=socket.socket()
local.bind(('127.0.0.1',0)); local.listen()
peer=socket.create_connection(('127.0.0.1',local.getsockname()[1]))
accepted,_=local.accept(); accepted.close(); peer.close(); local.close()
print('network-isolation-ok')
`;
        const result = await collected(run(['--', 'python3', '-c', code]));
        assert.equal(result.code, 0, result.err); assert.match(result.out, /network-isolation-ok/);
      } finally {
        await new Promise<void>(r => tcp.close(() => r()));
        await new Promise<void>(r => abstract.close(() => r()));
      }
    });

    await t.test('sandbox DNS has usable resolvers even when the host uses a loopback stub', async context => {
      const hostHasStub = execFileSync('/usr/bin/python3', ['-I', '-c',
        "import ipaddress,pathlib; print(any(ipaddress.ip_address(line.split()[1]).is_loopback for line in pathlib.Path('/etc/resolv.conf').read_text().splitlines() if line.split()[:1] == ['nameserver']))"
      ], { encoding: 'utf8' }).trim() === 'True';
      if (!hostHasStub) { context.skip('host /etc/resolv.conf has no loopback nameserver; loopback-stub regression requires one'); return; }
      const code = `import ipaddress,pathlib
addresses = [ipaddress.ip_address(line.split()[1]) for line in pathlib.Path('/etc/resolv.conf').read_text().splitlines() if line.split()[:1] == ['nameserver']]
assert addresses, 'sandbox must have a nameserver'
assert all(not address.is_loopback and not address.is_unspecified for address in addresses), addresses
print('dns-config-ok')
`;
      const result = await collected(run(['--', 'python3', '-c', code]));
      assert.equal(result.code, 0, result.err); assert.match(result.out, /dns-config-ok/);
      assert.doesNotMatch(result.err, /Couldn't get any nameserver address/);
    });

    await t.test('outbound DNS and HTTPS work when the host has internet', async context => {
      const code = "import socket,urllib.request; socket.getaddrinfo('example.com',443); assert urllib.request.urlopen('https://example.com',timeout=5).status == 200; print('https-ok')";
      try { execFileSync('python3', ['-I', '-c', code], { timeout: 7000, stdio: 'pipe' }); }
      catch { context.skip('host DNS/HTTPS unavailable; outbound check skipped'); return; }
      const result = await collected(run(['--', 'python3', '-c', code]));
      assert.equal(result.code, 0, result.err); assert.match(result.out, /https-ok/);
    });

    await t.test('mount absence is refused, startup leftovers are cleaned, and the next call works', async () => {
      await configure({ require_mount: true });
      const refused = await collected(run(['--', 'true']));
      assert.equal(refused.code, 255); assert.match(refused.err, /storage unavailable.*not mounted/);
      const id = /chaldea job ([0-9a-f-]+)/.exec(refused.err)![1];
      assert.equal(JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8')).outcome, 'refused');
      await configure();
      const leftover = join(jobroot, randomUUID()); await fs.mkdir(leftover);
      await fs.writeFile(join(leftover, 'interrupted'), 'reboot leftover');
      const result = await collected(run(['--', 'printf', 'after-reboot']));
      assert.equal(result.code, 0, result.err); assert.equal(result.out, 'after-reboot');
      assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
    });

    await t.test('stale control socket is replaced without rerunning an uncertain job', async () => {
      await collected(ssh(['-O', 'exit', 'chaldea-job-test']));
      execFileSync('python3', ['-I', '-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', controls]);
      const result = await collected(run(['--', 'printf', 'new-connection']));
      assert.equal(result.code, 0, result.err); assert.equal(result.out, 'new-connection');
    });

    await t.test('remote 125 stays finished and is distinct from local failure 255', async () => {
      const result = await collected(run(['--', 'python3', '-c', 'raise SystemExit(125)']));
      assert.equal(result.code, 125, result.err);
      const id = /chaldea job ([0-9a-f-]+)/.exec(result.err)![1];
      const entry = JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8'));
      assert.equal(entry.outcome, 'finished'); assert.equal(entry.exitCode, 125);
    });

    await t.test('idle host preempts with SIGTERM then SIGKILL after ten seconds', { timeout: 22000 }, async () => {
      const marker = 'chaldea-test-game-' + randomUUID();
      await configure({ policy: 'idle', desktop_user: userInfo().username,
        steam_game_pattern: marker, minecraft_pattern: 'a^' });
      const child = run(['--', 'python3', '-c',
        'import signal,pathlib,time; signal.signal(signal.SIGTERM,lambda *_:pathlib.Path(".term-signal").write_text("term")); print("ready",flush=True); time.sleep(100)']);
      let stderr = ''; child.stderr!.on('data', x => { stderr += x; });
      const resultPromise = collected(child, 20000);
      await once(child.stdout!, 'data');
      const id = /chaldea job ([0-9a-f-]+)/.exec(stderr)![1];
      let watcher: ReturnType<typeof watch>;
      let timer: ReturnType<typeof setTimeout>;
      const term = new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('job never received SIGTERM')), 18000);
        watcher = watch(join(jobroot, id), (_, name) => {
          if (name === '.term-signal') resolve(performance.now());
        });
      });
      const fakeGame = spawn('sleep', ['30'], { argv0: marker, stdio: 'ignore' });
      try {
        const termAt = await term;
        const result = await resultPromise;
        assert.equal(result.code, 255, result.err); assert.match(result.err, /preempted/);
        assert.ok(performance.now() - termAt >= 9500, 'SIGKILL must allow ten seconds of SIGTERM grace');
        const entry = JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8'));
        assert.equal(entry.outcome, 'preempted');
      } finally {
        clearTimeout(timer!); watcher!.close();
        fakeGame.kill('SIGTERM'); child.kill('SIGTERM');
        await resultPromise;
        await configure();
      }
    });

    await t.test('host refuses over-cap and disk-full admission; no workspace remains', async () => {
      for (const extra of [{ state_cap_bytes: 32 * 1024 ** 2 }, { min_free_bytes: Number.MAX_SAFE_INTEGER }]) {
        await configure(extra);
        const result = await collected(run(['--', 'true']));
        assert.equal(result.code, 255); assert.match(result.err, /over cap|image full/);
        assert.deepEqual(await fs.readdir(jobroot), ['admission.lock']);
      }
      await configure();
    });
    await t.test('two server slots run concurrently, third refuses, artifacts and cleanup stay isolated', { timeout: 15000 }, async () => {
      await configure({ slots: 2 });
      const children: ChildProcess[] = [];
      const results: Promise<Awaited<ReturnType<typeof collected>>>[] = [];
      try {
        for (const name of ['first', 'second']) {
          const child = run(['--artifact', 'result', '--', 'python3', '-c',
            'import pathlib,time; pathlib.Path("result").write_text("' + name + '"); print("ready",flush=True); time.sleep(5)']);
          children.push(child);
          const ready = once(child.stdout!, 'data');
          results.push(collected(child, 12000));
          await Promise.race([ready, results.at(-1)!.then(r => { throw new Error('job exited before ready: ' + r.err); })]);
        }
        const third = await collected(run(['--', 'printf', 'must-not-run']));
        assert.equal(third.code, 255, third.err);
        assert.match(third.err, /all job slots/);
        assert.equal(third.out, '');
        const smoke = await collected(spawn('/usr/bin/python3', ['-I', server!, '--config', config, '--smoke-test'],
          { env, stdio: ['ignore', 'pipe', 'pipe'] }));
        assert.equal(smoke.code, 0, smoke.err); assert.match(smoke.err, /deferred/);
        const finished = await Promise.all(results);
        for (const [index, result] of finished.entries()) {
          assert.equal(result.code, 0, result.err);
          const id = /chaldea job ([0-9a-f-]+)/.exec(result.err)![1];
          assert.equal(await fs.readFile(join(work, '.chaldea/artifacts', id, 'result'), 'utf8'),
            ['first', 'second'][index]);
        }
        for (const slot of [0, 1]) assert.deepEqual(await fs.readdir(join(jobroot, 'slot-' + slot)), []);
        const refusedId = /chaldea job ([0-9a-f-]+)/.exec(third.err)![1];
        assert.equal(JSON.parse(await fs.readFile(join(state, 'journal', refusedId + '.json'), 'utf8')).outcome, 'refused');
      } finally {
        for (const child of children) child.kill('SIGTERM');
        await Promise.all(results);
      }
    });
  } finally {
    await collected(ssh(['-O', 'exit', 'chaldea-job-test'])).catch(() => {});
    if (daemon) { const done = once(daemon, 'close'); daemon.kill('SIGTERM'); await done; }
    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  }
});
