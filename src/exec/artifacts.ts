import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Intent } from './journal.ts';
import { MAX_ARTIFACT } from './protocol.ts';
export const ARTIFACT_DAYS = 14 * 86400000;
export const HOST_CAP = 20 * 1024 ** 3;
export const BOOT_ID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

export function artifactLocation(entry: Intent): string | undefined {
  if (!entry.worktree || !entry.artifactDir || !/^[0-9a-f-]{36}$/.test(entry.jobId)) return;
  const expected = join(resolve(entry.worktree), '.chaldea/artifacts', entry.jobId);
  if (entry.artifactDir !== expected) throw new Error('invalid journal artifact location');
  return expected;
}
export function active(entry: Intent) {
  if (entry.bootId !== BOOT_ID || entry.outcome !== 'uncertain' || !entry.pid || Date.parse(entry.started) < Date.now() - 22800000) return false;
  try { process.kill(entry.pid, 0); return true; } catch { return false; }
}
async function parents(path: string) {
  for (const parent of [dirname(dirname(path)), dirname(path), path]) {
    try {
      const st = await fs.lstat(parent);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('artifact directory must not be a symlink');
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  }
}
export async function removeArtifacts(entry: Intent) {
  const path = artifactLocation(entry); if (!path) return;
  await parents(path);
  await fs.rm(path, { recursive: true, force: true });
}
async function size(path: string): Promise<number> {
  try {
    const st = await fs.lstat(path);
    if (st.isSymbolicLink()) throw new Error('artifact symlink refused');
    if (!st.isDirectory()) return st.size;
    return (await Promise.all((await fs.readdir(path)).map(name => size(join(path, name))))).reduce((a, b) => a + b, 0);
  } catch (e: any) { if (e.code === 'ENOENT') return 0; throw e; }
}
// The short state-wide accounting flock covers reservation, journal updates and
// cleanup across worktrees and targets. It is never held during remote execution.
export async function cleanArtifacts(journal: string, host: string, incoming = 0, cap = HOST_CAP, now = Date.now()) {
  const entries: { entry: Intent; bytes: number }[] = [];
  for (const name of await fs.readdir(journal)) {
    if (!name.endsWith('.json')) continue;
    const entry: Intent = JSON.parse(await fs.readFile(join(journal, name), 'utf8'));
    if (entry.host.toLowerCase() !== host.toLowerCase()) continue;
    const path = artifactLocation(entry); if (!path) continue;
    await parents(path);
    if (!active(entry) && Date.parse(entry.started) < now - ARTIFACT_DAYS) await removeArtifacts(entry);
    else entries.push({ entry, bytes: active(entry) ?
      Math.max(await size(path), entry.artifactReserve ?? MAX_ARTIFACT) : await size(path) });
  }
  let total = entries.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of entries.sort((a, b) => Date.parse(a.entry.started) - Date.parse(b.entry.started))) {
    if (total + incoming <= cap) break;
    if (active(row.entry)) continue;
    await removeArtifacts(row.entry); total -= row.bytes;
  }
  if (total + incoming > cap) throw new Error('per-host artifact cap reached; active artifacts protected');
  return total;
}
