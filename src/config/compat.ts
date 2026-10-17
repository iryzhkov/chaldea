import { createLogger, type Logger } from "./log.ts";

/** Never log values, which can contain credentials or private paths. */
export function aliases(value: Record<string, unknown>, names: Record<string, string>, logger: Logger = createLogger()) {
  const result = { ...value };
  for (const [oldKey, key] of Object.entries(names)) if (Object.hasOwn(result, oldKey)) {
    logger.warn("deprecated configuration key", { oldKey, key });
    if (!Object.hasOwn(result, key)) result[key] = result[oldKey];
    delete result[oldKey];
  }
  return result;
}
const reported = new Set<string>();
export function legacyEnv(name: string, key: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined && !reported.has(name)) {
    reported.add(name);
    createLogger().warn("deprecated configuration environment variable", { oldKey: name, key });
  }
  return value;
}
