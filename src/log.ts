// One JSON line per event on stderr (journald under systemd).
//
// Callers pass identifiers only; no credentials, URLs with tokens or
// transcript text ever reach a log call. Volume is bounded in process: at
// most `MAX_LINES_PER_MINUTE` info and warn lines per minute, after which they
// are counted and summarised once the minute ends. Error lines are not capped.
export const MAX_LINES_PER_MINUTE = 120;

export type Fields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  let windowStart = Date.now();
  let written = 0;
  let suppressed = 0;
  const emit = (level: string, message: string, fields?: Fields) => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      if (suppressed > 0) {
        write(`${JSON.stringify({ at: new Date(now).toISOString(), level: "warn", message: "log lines suppressed", count: suppressed })}\n`);
      }
      windowStart = now;
      written = 0;
      suppressed = 0;
    }
    // Errors are rare and always worth keeping, so the cap applies to info and warn only.
    if (level !== "error" && written >= MAX_LINES_PER_MINUTE) {
      suppressed += 1;
      return;
    }
    written += 1;
    write(`${JSON.stringify({ at: new Date(now).toISOString(), level, message, ...fields })}\n`);
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
