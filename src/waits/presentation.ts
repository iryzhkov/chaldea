import type { Delivery, Item } from "../wake/store.ts";
import { waitDescription, type WaitInput } from "./types.ts";

export type WaitResponseMode = "compact" | "verbose";
export function waitResponseMode(value: unknown): WaitResponseMode {
  if (value === undefined || value === "verbose") return "verbose";
  if (value === "compact") return value;
  throw new Error("Invalid responseMode");
}
export interface CompactWait {
  id: string; waitId: string; threadId: string; requestId: string; description: string;
  condition: WaitInput["condition"]; deadline: string; state: Item["state"];
  lifecycle: "waiting" | "ready" | "delivering" | "delivered" | "cancelled" | "orphaned" | "needs_attention";
  deliveryDisposition: string; wakeMayStillArrive: boolean;
  disposition: string | null; cancelOutcome?: string;
}
/** Derived from durable evidence, including ambiguous attempts and orphaned wakes.
 * A sent wake may still be queued in T3; cancellation cannot retract it. */
export function compactWait(item: Item, deliveries: readonly Delivery[], cancelOutcome?: string): CompactWait {
  if (item.kind !== "wait") throw new Error("Only waits have compact responses");
  const input = JSON.parse(item.input) as WaitInput;
  const wake = deliveries.find(d => d.item === item.id && d.channel === "wake");
  const ambiguous = wake?.state === "sending" || wake?.state === "uncertain"
    || (wake?.state === "pending" && wake.attempts > 0);
  const deliveryDisposition = wake?.state === "sent" ? "already_delivered"
    : ambiguous ? "uncertain_in_flight"
    : wake?.disposition ?? wake?.state ?? "none";
  const lifecycle = item.state === "orphaned" ? "orphaned"
    : item.state === "cancelled" ? "cancelled"
    : item.state === "needs_attention" || wake?.state === "blocked" || wake?.state === "uncertain" ? "needs_attention"
    : wake?.state === "sent" ? "delivered"
    : ambiguous ? "delivering" : item.state === "parked" ? "waiting" : "ready";
  return {
    id: item.id, waitId: item.id, threadId: item.parent, requestId: item.request_key,
    description: waitDescription(input, item.target_run),
    condition: input.condition.kind === "thread" && item.target_run
      ? {...input.condition, runId: item.target_run} : input.condition,
    deadline: new Date(item.deadline).toISOString(), state: item.state, lifecycle,
    deliveryDisposition, disposition: item.disposition,
    wakeMayStillArrive: ambiguous || wake?.state === "sent" || wake?.state === "pending"
      || (item.state === "parked" && !wake),
    ...(cancelOutcome === undefined ? {} : {cancelOutcome}),
  };
}
/** Default retains the complete persisted item and legacy presentation fields. */
export function formatWaitResponse(item: Item, deliveries: readonly Delivery[], mode: WaitResponseMode = "verbose") {
  if (mode === "compact") return compactWait(item, deliveries);
  return {...item, waitId:item.id, description:waitDescription(JSON.parse(item.input) as WaitInput,item.target_run),
    delivery:deliveries.filter(d=>d.item===item.id).map(d=>({
      channel:d.channel,state:d.state,disposition:d.disposition,attempts:d.attempts,nextAt:d.next_at,
    }))};
}
export function formatWaitCancellation(result: {item:Item;delivery:string}, deliveries: readonly Delivery[], mode: WaitResponseMode = "verbose") {
  return mode === "compact" ? compactWait(result.item, deliveries, result.delivery) : result;
}
