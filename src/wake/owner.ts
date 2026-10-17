// Linux flock follows the open file description inherited by the helper.
// Keeping our descriptor open retains the lock; process death releases it.
import { openSync, closeSync, fchmodSync, fstatSync, constants } from "node:fs";
import { flockSync } from "../fs/flock.ts";
export function ownDatabase(path: string): () => void {
  const fd=openSync(path,constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,0o600);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("Unsafe wake database owner");
    fchmodSync(fd,0o600);
    if (flockSync(fd) === "busy") throw new Error("Wake database already owned by another service");
  } catch(error) { closeSync(fd); throw error; }
  let closed=false;
  return () => { if (!closed) { closed=true;closeSync(fd); } };
}
