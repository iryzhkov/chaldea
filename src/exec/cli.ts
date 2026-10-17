import { run, argumentsFor } from './client.ts';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
// execve preserves the PID: SIGKILL/reboot releases flock and closes job stdin.
// Remote statuses (including 125) pass through; local Chaldea failures use 255.
try {
  if (process.env.CHALDEA_ACCOUNT_LOCKED !== '1') {
    const { host } = argumentsFor(process.argv.slice(2));
    const state = process.env.CHALDEA_STATE_DIR ?? join(homedir(), '.local/state/chaldea/exec');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    if (!process.execve) throw new Error('Node 26.10.0 with execve support is required');
    process.execve('/usr/bin/flock', ['flock', '-n', '-E', '255', '-F',
      join(state, 'artifacts-' + host + '.lock'), process.execPath, import.meta.filename, ...process.argv.slice(2)],
      { ...process.env, CHALDEA_ACCOUNT_LOCKED: '1' } as Record<string, string>);
  }
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write('chaldea: ' + (error as Error).message + '\n');
  process.exitCode = 255;
}
