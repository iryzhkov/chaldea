import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { active } from './artifacts.ts';
import type { Intent } from './journal.ts';
import { LIMITS } from './protocol.ts';
import { privateDirectory } from './state.ts';

export const LOG_CAP = LIMITS.maxOutput;
export const TOTAL_LOG_CAP = 2 * 1024 ** 3;
export const validJobId = (id: string) => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
export function logPath(state: string, id: string) {
  if (!validJobId(id)) throw new Error('invalid job id');
  return join(state, 'logs', id + '.log');
}
export async function removeLog(journal: string, entry: Intent) {
  if (!validJobId(entry.jobId)) return; // older/partial journal records
  await fs.unlink(logPath(join(journal, '..'), entry.jobId)).catch((e: any) => { if (e.code !== 'ENOENT') throw e; });
}
export class JobLog {
  bytes = 0;
  truncated = false;
  readonly file: fs.FileHandle;
  readonly cap: number;
  constructor(file: fs.FileHandle, cap = LOG_CAP) { this.file = file; this.cap = cap; }
  async raw(data: Buffer) {
    const remaining = Math.max(0, this.cap - this.bytes);
    if (data.length > remaining) this.truncated = true;
    const value = data.subarray(0, remaining);
    if (value.length) await this.file.writeFile(value);
    this.bytes += value.length;
  }
  async output(type: 'O' | 'S', data: Buffer) {
    await this.raw(Buffer.concat([Buffer.from(type === 'O' ? '\n[stdout]\n' : '\n[stderr]\n'), data]));
  }
  async close() { try { await this.file.sync(); } finally { await this.file.close(); } }
}
export async function openLog(state: string, id: string) {
  await privateDirectory(join(state, 'logs'));
  return new JobLog(await fs.open(logPath(state, id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
}
// Called under the state accounting lock. Reserve the full cap for live clients
// so concurrent streams cannot grow beyond the total cap between prune passes.
export async function cleanLogs(state: string, incoming = 0, cap = TOTAL_LOG_CAP, now = Date.now()) {
  const dir = join(state, 'logs');
  await privateDirectory(dir);
  const rows: { path: string; bytes: number; when: number; live: boolean }[] = [];
  for (const name of await fs.readdir(dir)) {
    if (/^[0-9a-f-]{36}\.log\.recovery$/.test(name)) { await fs.unlink(join(dir, name)); continue; }
    if (!/^[0-9a-f-]{36}\.log$/.test(name)) continue;
    const path = join(dir, name);
    const st = await fs.lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('log must be a regular file');
    let entry: Intent | undefined;
    try { entry = JSON.parse(await fs.readFile(join(state, 'journal', name.slice(0, -4) + '.json'), 'utf8')); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const live = entry ? active(entry) : false;
    const when = entry ? Date.parse(entry.started) : st.mtimeMs;
    if (!live && when < now - 14 * 86400000) await fs.unlink(path);
    else rows.push({ path, bytes: live ? Math.max(st.size, LOG_CAP) : st.size, when, live });
  }
  let total = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows.sort((a, b) => a.when - b.when)) {
    if (total + incoming <= cap) break;
    if (row.live) continue;
    await fs.unlink(row.path); total -= row.bytes;
  }
  if (total + incoming > cap) throw new Error('local log cap reached; active logs protected');
}
