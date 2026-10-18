// Read-only Codex app-server client. Never starts a model thread or accepts arbitrary RPCs.
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { claudeContexts, fleetConfig, type ClaudeContext, type FleetConfig } from "./fleet.ts";
import { quotaConfig } from "../config/quota.ts";

export interface CodexContext {
  readonly providers: ReadonlyArray<string>;
  readonly home: string;
  readonly codexHome: string;
  readonly command: string;
  readonly assertRuntimeHome?: boolean;
  readonly accountKey?: string;
}
export interface HeadroomConfig {
  readonly contexts: ReadonlyArray<CodexContext>;
  readonly lowHeadroomPercent: number;
  readonly claudeContexts?: ReadonlyArray<ClaudeContext>;
  readonly fleet?: FleetConfig;
}
export function headroomConfig(raw: unknown = {}, home = homedir()): HeadroomConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid quota reporting config");
  const c = raw as Record<string, unknown>;
  if (Object.keys(c).some(k => !["contexts", "claudeContexts", "fleet", "lowHeadroomPercent"].includes(k))) throw new Error("unknown quota reporting option");
  const contexts = c.contexts ?? [];
  if (!Array.isArray(contexts) || contexts.length > 16) throw new Error("quota contexts must contain at most 16 entries");
  const seen = new Set<string>();
  const parsed = contexts.map((entry): CodexContext => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid quota credential context");
    const v = entry as Record<string, unknown>;
    if (Object.keys(v).some(k => !["providers", "home", "codexHome", "command", "assertRuntimeHome", "accountKey"].includes(k))) throw new Error("unknown credential context option");
    if (!Array.isArray(v.providers) || v.providers.length === 0 || v.providers.length > 64 ||
        !v.providers.every(p => typeof p === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(p) && !seen.has(p))) {
      throw new Error("credential context needs unique provider aliases");
    }
    for (const p of v.providers) { if (seen.has(p)) throw new Error("duplicate provider alias"); seen.add(p); }
    for (const key of ["home", "codexHome"] as const) {
      if (typeof v[key] !== "string" || !isAbsolute(v[key]) || v[key].includes("\0")) throw new Error("credential homes must be absolute paths");
    }
    if (v.command !== undefined && (typeof v.command !== "string" || !isAbsolute(v.command) || v.command.includes("\0"))) {
      throw new Error("Codex command must be an absolute installed executable");
    }
    if (v.assertRuntimeHome !== undefined && typeof v.assertRuntimeHome !== "boolean") {
      throw new Error("assertRuntimeHome must be a boolean");
    }
    if (v.accountKey !== undefined && (typeof v.accountKey !== "string" || !/^[a-f0-9]{64}$/.test(v.accountKey))) throw new Error("invalid account key");
    return { ...(v.accountKey ? { accountKey: v.accountKey as string } : {}), assertRuntimeHome: v.assertRuntimeHome === true, providers: v.providers, home: resolve(v.home as string), codexHome: resolve(v.codexHome as string),
      command: v.command as string | undefined ?? "codex" };
  });
  const low = c.lowHeadroomPercent ?? 10;
  if (typeof low !== "number" || !Number.isFinite(low) || low < 0 || low > 100) throw new Error("invalid low headroom percentage");
  // The same effective context has one collector even when listed in several entries.
  const grouped = new Map<string, CodexContext>();
  for (const ctx of parsed) {
    const key = JSON.stringify([contextKey(ctx), ctx.assertRuntimeHome, ctx.accountKey]), previous = grouped.get(key);
    grouped.set(key, { ...ctx, providers: [...(previous?.providers ?? []), ...ctx.providers] });
  }
  const claude = claudeContexts(c.claudeContexts);
  if (claude.some(ctx => seen.has(ctx.providerInstanceId))) throw new Error("duplicate provider alias");
  return { contexts: [...grouped.values()], lowHeadroomPercent: low, claudeContexts: claude,
    fleet: fleetConfig(c.fleet, home) };
}
/** Missing default config leaves balance unknown; explicit paths and malformed files fail closed. */
export function loadHeadroomConfig(home: string, path?: string): HeadroomConfig {
  const c = quotaConfig(home, path);
  return headroomConfig({ contexts: c.contexts, claudeContexts: c.claudeContexts, fleet: c.fleet, lowHeadroomPercent: c.lowHeadroomPercent }, home);
}
export const contextKey = (c: CodexContext): string => JSON.stringify([c.home, c.codexHome, c.command]);

export class BalanceReadError extends Error {
  readonly code: "spawn_failed" | "unavailable" | "timeout" | "protocol" | "rate_limited" | "aborted";
  constructor(code: BalanceReadError["code"]) { super(code); this.code = code; }
}

/** A strict, bounded, short-lived stdio exchange; provider output is never logged. */
export function readCodexBalance(context: CodexContext, signal: AbortSignal, timeoutMs = 10_000): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new BalanceReadError("aborted"));
  return new Promise((resolveResult, reject) => {
    // Deliberately do not inherit shell auth tokens, endpoints, T3 tokens or account selectors.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: "C.UTF-8", HOME: context.home, CODEX_HOME: context.codexHome,
      XDG_CACHE_HOME: context.home + "/.cache",
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    };
    const child = spawn(context.command, ["app-server", "--listen", "stdio://"],
      { env, cwd: context.home, stdio: ["pipe", "pipe", "ignore"], detached: true });
    let buffer = "", bytes = 0, result: unknown, received = false, stopping = false, done = false;
    let failure: BalanceReadError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch {} };
    const stop = (error?: BalanceReadError) => {
      if (stopping) return;
      stopping = true; failure = error;
      child.stdin.end(); kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 200);
    };
    const abort = () => stop(new BalanceReadError("aborted"));
    const timer = setTimeout(() => stop(new BalanceReadError("timeout")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      kill("SIGKILL"); // Reap any remaining descendants even if the parent closed first.
      signal.removeEventListener("abort", abort);
      if (failure || !received) reject(failure ?? new BalanceReadError("unavailable"));
      else resolveResult(result);
    };
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.stdin.on("error", () => stop(new BalanceReadError("unavailable")));
    child.once("error", () => { failure = new BalanceReadError("spawn_failed"); finish(); });
    child.once("close", finish);
    let initialized = false;
    let account: unknown;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return stop(new BalanceReadError("protocol"));
      buffer += chunk.toString("utf8");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0 && !stopping) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { stop(new BalanceReadError("protocol")); break; }
        if (!message || typeof message !== "object") { stop(new BalanceReadError("protocol")); break; }
        if (message.id !== 1 && message.id !== 2 && message.id !== 3) continue; // unsolicited notifications are not full observations
        if (message.error) {
          stop(new BalanceReadError(message.error.code === 429 ? "rate_limited" : "protocol")); break;
        }
        if (message.id === 1 && !initialized && Object.hasOwn(message, "result")) {
          initialized = true;
          send({ method: "initialized" });
          send({ id: 3, method: "account/read", params: { refreshToken: false } });
        } else if (message.id === 3 && initialized && Object.hasOwn(message, "result")) {
          account = message.result?.account;
          send({ id: 2, method: "account/rateLimits/read",
            params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
        } else if (message.id === 2 && initialized && Object.hasOwn(message, "result")) {
          const a = account as Record<string, unknown> | null;
          result = { ...message.result, accountId: a?.accountId ?? a?.id ?? message.result?.accountId };
          received = true; stop();
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "chaldea_quota", version: "0.1.0" } } });
  });
}
