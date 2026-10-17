import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { removeArtifacts, active as liveIntent } from './artifacts.ts';
import { removeLog } from './logs.ts';

export type Intent = { jobId: string; host: string; argv: string[]; started: string; pid?: number; bootId?: string; outcome: 'uncertain' | 'finished' | 'refused' | 'preempted'; worktree?: string; artifactDir?: string; artifactReserve?: number; exitCode?: number; ended?: string; logPath?: string; logTruncated?: boolean; outputSyncFailed?: boolean; artifactPaths?: string[]; requestedArtifacts?: string[] };
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
      if (liveIntent(value)) active.add(entry.path);
    } catch { /* stale partial journal update */ }
  }
  retained = active.size;
  for (const entry of files) {
    if (active.has(entry.path)) continue;
    if (retained >= keep || entry.stat.mtimeMs < Date.now() - age) {
      try { const value = JSON.parse(await fs.readFile(entry.path, 'utf8')); await removeArtifacts(value); await removeLog(dir, value); } catch (e: any) { if (e instanceof SyntaxError) { /* partial update */ } else throw e; }
      await fs.unlink(entry.path);
    }
    else retained++;
  }
}
