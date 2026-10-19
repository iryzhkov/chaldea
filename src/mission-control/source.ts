// Supervise event streams. Timers only retry disconnected streams, never poll projections.
import { setTimeout as delay } from "node:timers/promises";
import { connectShell, connectMissionThread, AuthenticationError, ProtocolIncompatibleError } from "../t3/adapter.ts";
import type { ConnectOptions, ShellSubscription, MissionDetailEvent } from "../t3/adapter.ts";
import { MissionModel } from "./model.ts";
export interface ReadSource {
  shell(options: ConnectOptions, subscription: ShellSubscription): Promise<void>;
  detail(options: ConnectOptions, id: string, cursor: number | undefined, emit: (event: MissionDetailEvent) => void): Promise<void>;
}
const official: ReadSource = { shell: connectShell, detail: connectMissionThread };
export async function runSource(model: MissionModel, resolve: () => Omit<ConnectOptions,"signal">,
  signal: AbortSignal, source: ReadSource = official, retryMs = 1000): Promise<void> {
  const children = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const cursors = new Map<string, number>();
  let endpoint = "";
  let shellCursor: number | undefined;
  let generation = 0;
  const pause = () => delay(retryMs, undefined, { signal }).catch(() => {});
  const stopChildren = async () => {
    generation++;
    const active = [...children.values()]; children.clear();
    for (const child of active) child.controller.abort();
    await Promise.all(active.map(c => c.done));
  };
  const reconcile = (options: ConnectOptions) => {
    const ids = new Set(model.ids());
    for (const id of cursors.keys()) if (!ids.has(id)) cursors.delete(id);
    for (const [id, child] of children) if (!ids.has(id)) { child.controller.abort(); children.delete(id); cursors.delete(id); }
    for (const id of ids) if (!children.has(id)) {
      const controller = new AbortController(), current = generation;
      const done = (async () => {
        while (!signal.aborted && !controller.signal.aborted && current === generation) {
          try {
            await source.detail({ ...options, signal: controller.signal }, id, cursors.get(id), event => {
              if (controller.signal.aborted || current !== generation) return;
              if (event.kind === "cursor") { cursors.set(id, event.sequence); return; }
              model.detail(id, event);
            });
          } catch (error) {
            if (error instanceof AuthenticationError || error instanceof ProtocolIncompatibleError) { model.detailDisconnected(id); return; }
          }
          model.detailDisconnected(id);
          if (!controller.signal.aborted) await delay(retryMs, undefined, { signal: controller.signal }).catch(() => {});
        }
      })();
      children.set(id, { controller, done });
    }
  };
  const abort = () => { for (const c of children.values()) c.controller.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      try {
        const options = { ...resolve(), signal };
        if (options.serverUrl !== endpoint) { endpoint = options.serverUrl; cursors.clear(); shellCursor = undefined; }
        await source.shell(options, { onProviderCatalog:providers=>model.setProviderCatalog(providers), onResources:resources=>model.setResources(resources), ...(shellCursor === undefined ? {} : { afterSequence: shellCursor }),
          onEvent(event) { if (event.kind !== "synchronized") shellCursor = event.sequence; model.shell(event); if (event.kind === "synchronized" || event.kind === "thread" || event.kind === "removed" || event.kind === "snapshot") reconcile(options); } });
      } catch (error) {
        if (error instanceof AuthenticationError || error instanceof ProtocolIncompatibleError) { model.disconnected(); return; }
      } finally { await stopChildren(); model.disconnected(); }
      if (!signal.aborted) await pause();
    }
  } finally { signal.removeEventListener("abort", abort); await stopChildren(); }
}
