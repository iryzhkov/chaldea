import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDb(path: string, pragmas = ""): DatabaseSync {
  const db = new DatabaseSync(path);
  try { if (pragmas) db.exec(pragmas); return db; }
  catch (error) { db.close(); throw error; }
}
/** Preserve each store's validation errors and hard-link policy. */
export function openPrivateDb(path: string, options: {
  initialize: boolean; directoryError: string; fileError: string; emptyError?: string; singleLink?: boolean;
}, check: (ok: unknown, reason: string) => void): DatabaseSync {
  if (options.initialize) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const dir = lstatSync(dirname(path));
  check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.geteuid!() &&
    (dir.mode & 0o077) === 0, options.directoryError);
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW |
    (options.initialize ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  closeSync(fd);
  const stat = lstatSync(path);
  check(stat.isFile() && (!options.singleLink || stat.nlink === 1) && stat.uid === process.geteuid!() &&
    (stat.mode & 0o077) === 0 && (options.emptyError !== undefined || options.initialize || stat.size > 0), options.fileError);
  if (options.emptyError) check(options.initialize || stat.size > 0, options.emptyError);
  return openDb(path);
}
export function tx<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = body(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function identifier(name: string): string {
  if (!/^[a-z_][a-z_0-9]*$/i.test(name)) throw new Error("invalid_sqlite_identifier");
  return '"' + name + '"';
}
export function meta(db: DatabaseSync, table = "meta", key = "name") {
  const tableName = identifier(table), keyName = identifier(key);
  return {
    get(name: string): string | undefined {
      return (db.prepare(`SELECT value FROM ${tableName} WHERE ${keyName}=?`).get(name) as { value: string } | undefined)?.value;
    },
    put(name: string, value: string): void {
      db.prepare(`INSERT INTO ${tableName} VALUES(?,?) ON CONFLICT(${keyName}) DO UPDATE SET value=excluded.value`).run(name, value);
    },
  };
}
/** Version zero adopts a validated legacy schema. Never repair it on reopen. */
export function migrate(db: DatabaseSync, upgrades: readonly (() => void)[]): void {
  tx(db, () => {
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > upgrades.length) throw new Error("unsupported_database_version");
    for (let n = version; n < upgrades.length; n++) {
      upgrades[n]!();
      db.exec("PRAGMA user_version=" + (n + 1));
    }
  });
}
