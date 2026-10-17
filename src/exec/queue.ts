import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { frame, frames, send, json, VERSION, QUEUE_VERSION, COMMANDS } from './protocol.ts';
import { sshStderr } from './ssh-stderr.ts';

export type Transport = {
  ssh: ChildProcessWithoutNullStreams;
  incoming: ReturnType<typeof frames>;
  exit: Promise<number | null>;
};
export function connect(config: string, host: string, command = COMMANDS.exec): Transport {
  const ssh = spawn('ssh', ['-F', config, '-T', '-a', '-x',
    '-o', 'BatchMode=yes', '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', 'ConnectTimeout=10',
    'chaldea-job-' + host, command], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => {
    ssh.once('error', reject); ssh.once('close', resolve);
  });
  void exit.catch(() => {});
  ssh.stdin.on('error', () => {});
  ssh.stderr.pipe(sshStderr()).pipe(process.stderr, { end: false });
  return { ssh, incoming: frames(ssh.stdout), exit };
}
function stop(t: Transport) {
  // Cancel is best effort; closing stdin also cancels on every protocol path.
  if (!t.ssh.stdin.destroyed) t.ssh.stdin.end(frame('C'));
  const timer = setTimeout(() => t.ssh.kill('SIGTERM'), 1000);
  timer.unref();
  t.ssh.once('close', () => clearTimeout(timer));
}

// No Q/job bytes enter these connections. Even an ambiguous queue transport
// failure is definite non-execution, including against a pre-queue server.
export async function queueHost(config: string, hosts: string[], seconds: number,
  check: (host: string) => Promise<void>): Promise<{ host: string; transport: Transport } | undefined> {
  const active = new Set<Transport>();
  let chosen: Transport | undefined;
  let finished = false;
  let remaining = hosts.length;
  let timer: NodeJS.Timeout;
  let complete!: (value: { host: string; transport: Transport } | undefined) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<{ host: string; transport: Transport } | undefined>((resolve, reject) => {
    complete = resolve; fail = reject;
  });
  const deadline = performance.now() + seconds * 1000;
  const interrupt = () => { finished = true; fail(new Error('queue interrupted')); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  timer = setTimeout(() => { finished = true; fail(new Error('queue timeout')); }, seconds * 1000);
  for (const host of hosts) void (async () => {
    let transport: Transport | undefined;
    try {
      await check(host);
      if (finished) return;
      transport = connect(config, host, COMMANDS.queue);
      active.add(transport);
      const hello = await transport.incoming.next();
      if (hello.done || hello.value.type !== 'H') throw new Error('queue unsupported or host unavailable');
      const h = JSON.parse(hello.value.data.toString());
      if (h.version !== VERSION || h.queueVersion !== QUEUE_VERSION) throw new Error('queue unsupported');
      await send(transport.ssh.stdin, 'W', json({ version: QUEUE_VERSION, timeoutSeconds: Math.max(.001, (deadline - performance.now()) / 1000) }));
      const ready = await transport.incoming.next();
      if (ready.done || ready.value.type !== 'Y' || JSON.parse(ready.value.data.toString()).state !== 'ready') {
        throw new Error('queue refused');
      }
      if (finished) return;
      finished = true; chosen = transport;
      complete({ host, transport });
    } catch (error) {
      if (!finished) process.stderr.write('chaldea queue skipped ' + host + ': ' + (error as Error).message.replace(/[\r\n]+/g, ' ') + '\n');
    } finally {
      if (transport && transport !== chosen) stop(transport);
      if (--remaining === 0 && !finished) { finished = true; complete(undefined); }
    }
  })();
  try { return await result; }
  finally {
    clearTimeout(timer!);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    for (const transport of active) if (transport !== chosen) stop(transport);
  }
}
