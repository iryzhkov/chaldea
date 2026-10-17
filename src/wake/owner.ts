// Linux flock follows the open file description inherited by the helper.
// Keeping our descriptor open retains the lock; process death releases it.
import { openSync, closeSync, fchmodSync, fstatSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
export function ownDatabase(path: string): () => void {
  const fd=openSync(path,constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,0o600);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Unsafe wake database owner");
    fchmodSync(fd,0o600);
    const result=spawnSync("flock",["--exclusive","--nonblock","3"],{stdio:["ignore","ignore","pipe",fd],timeout:5000});
    if (result.status === 1) throw new Error("Wake database already owned by another service");
    if (result.error || result.status !== 0) throw new Error("Cannot acquire wake database owner lock (Linux flock required)");
  } catch(error) { closeSync(fd); throw error; }
  let closed=false;
  return () => { if (!closed) { closed=true;closeSync(fd); } };
}
