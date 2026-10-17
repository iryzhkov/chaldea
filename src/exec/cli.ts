import { run, argumentsFor, refuseConcurrent } from './client.ts';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
// execve preserves the PID: SIGKILL/reboot releases flock and closes job stdin.
// Remote statuses (including 125) pass through; local Chaldea failures use 255.
try {
  if (process.env.CHALDEA_ACCOUNT_REFUSED === '1') await refuseConcurrent(process.argv.slice(2));
  if (process.env.CHALDEA_ACCOUNT_LOCKED !== '1') {
    const { host } = argumentsFor(process.argv.slice(2));
    const state = process.env.CHALDEA_STATE_DIR ?? join(homedir(), '.local/state/chaldea/exec');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    if (!process.execve) throw new Error('Node 26.10.0 with execve support is required');
    // The static shell only acquires an inherited fd lock and execs Node.
    // Client argv is positional data, never shell text. Every exec keeps our PID.
    process.execve('/bin/sh', ['sh', '-c',
      'exec 9>>"$1"; shift; if /usr/bin/flock -n 9; then export CHALDEA_ACCOUNT_LOCKED=1; else export CHALDEA_ACCOUNT_REFUSED=1; fi; exec "$@"',
      'chaldea-lock', join(state, 'artifacts-' + host + '.lock'),
      process.execPath, import.meta.filename, ...process.argv.slice(2)],
      process.env as Record<string, string>);
  }
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write('chaldea: ' + (error as Error).message + '\n');
  process.exitCode = 255;
}
