import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const stateDir = () => process.env.CHALDEA_STATE_DIR ?? join(homedir(), '.local/state/chaldea/exec');
export async function privateDirectory(path: string) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('state directory must not be a symlink');
  await fs.chmod(path, 0o700);
}
// flock inherits the parent's open file description; the lock stays held until
// this parent closes its descriptor, including after the flock child exits.
export async function withStateLock<T>(state: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(state);
  const lock = await fs.open(join(state, 'accounting.lock'), 'a', 0o600);
  try {
    const child = spawn('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'pipe', lock.fd] });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    if (code !== 0) throw new Error('local accounting lock failed (flock exit ' + code + ')');
    return await action();
  } finally { await lock.close(); }
}
