import { backup } from "node:sqlite";
import { constants, openSync, closeSync, lstatSync, unlinkSync, chmodSync, statSync, statfsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { EventStore } from "./store.ts";
import { ensure } from "./schema.ts";

export async function maintain(store: EventStore, now: number, stopped = () => false): Promise<void> {
  try {
    while (!stopped()) {
      if (!store.prune(now, 10)) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const h = store.health();
    if (Number(h.pending_bytes) >= store.budget.outbox * 0.8) store.alarm = "outbox_pressure";
    const oldest = store.db.prepare("SELECT min(expires)-? AS accepted FROM receipts WHERE state='pending'").get(180 * 86400) as { accepted: number | null };
    if (oldest.accepted !== null && now - oldest.accepted > 60) store.alarm = "backlog_over_60s";
  } catch { store.alarm = "maintenance_or_capacity_failure"; }
}
/** One rolling snapshot, no second full vacuum/backup copy. AccessState is deliberately separate. */
export async function snapshot(store: EventStore, destination: string): Promise<void> {
  ensure(isAbsolute(destination) && destination !== store.path, "invalid_backup_path");
  const dir = lstatSync(dirname(destination));
  ensure(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.geteuid!() && (dir.mode & 0o077) === 0, "unsafe_backup_directory");
  const fs = statfsSync(dirname(destination));
  ensure(fs.bavail * fs.bsize > store.budget.main + store.budget.wal, "backup_space", 503);
  try {
    const stat = lstatSync(destination);
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.geteuid!() && (stat.mode & 0o077) === 0, "unsafe_backup_file");
    unlinkSync(destination);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600); closeSync(fd);
  try {
    await backup(store.db, destination, { rate: Math.floor(store.budget.main / 4096) + 1 });
    chmodSync(destination, 0o600); ensure(statSync(destination).size <= store.budget.main, "backup_capacity", 503);
  } catch (e) { unlinkSync(destination); throw e; }
}
