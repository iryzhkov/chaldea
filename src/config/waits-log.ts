// Private, size/age bounded sink for the shared JSON logger.
import { openSync, readSync, statSync, closeSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./log.ts";

export function boundedLog(path: string): (event: string) => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const logger = createLogger(line => {
    const now = Date.now();
    try {
      const stat = statSync(path), fd = openSync(path, "r");
      const bytes = Buffer.alloc(512);
      try { readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
      // Retain age rotation across the old numeric and new ISO timestamp formats.
      const match = /"at":("[^"]+"|\d+)/.exec(bytes.toString());
      const at = match ? (match[1]!.startsWith('"') ? Date.parse(JSON.parse(match[1]!)) : Number(match[1])) : NaN;
      if (stat.size > 10 * 1024 * 1024 - 1024 || now - at > 14 * 86_400_000)
        writeFileSync(path, "", { mode: 0o600 });
    } catch {}
    appendFileSync(path, line, { mode: 0o600 });
  });
  return event => logger.info(event, { event });
}
