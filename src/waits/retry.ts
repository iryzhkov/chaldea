// A caller-selected retry receipt, not a second wait journal.
import { constants, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync, fchmodSync } from "node:fs";
import { dirname } from "node:path";
import { object, validate, type WaitInput } from "./types.ts";

export interface WaitReceipt {version:1;method:"chaldea_wait";input:WaitInput}
/** O_EXCL refuses overwrite. No transport may start until file and directory sync. */
export function saveWaitReceipt(path: string, value: unknown, now = Date.now()): WaitReceipt {
  const input=validate("wait",value,now).input as WaitInput;
  const receipt:WaitReceipt={version:1,method:"chaldea_wait",input};
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { fchmodSync(fd,0o600);writeFileSync(fd,JSON.stringify(receipt)+"\n");fsyncSync(fd); }
  finally { closeSync(fd); }
  const parent=openSync(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return receipt;
}
/** Replay persisted normalized bytes without regenerating keys or deadlines.
 * Retention and changed-payload refusals remain the service's responsibility. */
export function readWaitReceipt(path: string): WaitReceipt {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.uid!==process.getuid?.() || (stat.mode&0o777)!==0o600 || stat.nlink!==1 || stat.size>4096)
      throw new Error("Unsafe wait receipt");
    const value=object(JSON.parse(readFileSync(fd,"utf8")));
    if (value.version!==1 || value.method!=="chaldea_wait") throw new Error("Invalid wait receipt");
    const input=object(value.input);
    // Validate at the original key epoch so an old receipt reaches the service's
    // actual replay fence, rather than acquiring fresh intent at retry time.
    const checked=validate("wait",input,Number(String(input.requestId).slice(0,13))).input as WaitInput;
    if (JSON.stringify(checked)!==JSON.stringify(input)) throw new Error("Wait receipt is not normalized");
    return {version:1,method:"chaldea_wait",input:checked};
  } finally { closeSync(fd); }
}
