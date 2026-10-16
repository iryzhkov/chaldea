import * as fs from 'node:fs/promises';
import { join } from 'node:path';

export type Intent = { jobId: string; host: string; argv: string[]; started: string; pid?: number; outcome: 'uncertain' | 'finished'; exitCode?: number };
export const DAYS = 14 * 86400000;
export const KEEP = 1000;

async function syncDirectory(dir: string) {
  const fd = await fs.open(dir, 'r'); try { await fd.sync(); } finally { await fd.close(); }
}
export async function record(dir: string, entry: Intent, initial = true) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, entry.jobId + '.json');
  const path = initial ? target : target + '.new';
  const fd = await fs.open(path, initial ? 'wx' : 'w', 0o600);
  try { await fd.writeFile(JSON.stringify(entry) + '\n'); await fd.sync(); } finally { await fd.close(); }
  if (!initial) await fs.rename(path, target);
  await syncDirectory(dir);
}
export async function prune(dir: string, age = DAYS, keep = KEEP) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const entries = await Promise.all((await fs.readdir(dir)).map(async name => {
    const path = join(dir, name); return { path, stat: await fs.lstat(path) };
  }));
  const files = entries.filter(e => e.stat.isFile()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  let retained = 0;
  const active = new Set<string>();
  for (const entry of files) {
    try {
      const value: Intent = JSON.parse(await fs.readFile(entry.path, 'utf8'));
      if (value.outcome === 'uncertain' && value.pid && Number.isSafeInteger(value.pid) && value.pid > 0 &&
          entry.stat.mtimeMs > Date.now() - (6 * 3600 + 1200) * 1000) {
        try { process.kill(value.pid, 0); active.add(entry.path); } catch { /* exited client */ }
      }
    } catch { /* stale partial journal update */ }
  }
  retained = active.size;
  for (const entry of files) {
    if (active.has(entry.path)) continue;
    if (retained >= keep || entry.stat.mtimeMs < Date.now() - age) await fs.unlink(entry.path);
    else retained++;
  }
}
