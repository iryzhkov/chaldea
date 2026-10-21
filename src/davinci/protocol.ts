// One fixed operator definition. Webhooks carry no execution choices.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { object, name, field, requireMessage as check } from "../message.ts";
import type { SessionStatus } from "../session/lifecycle.ts";

export const WINDOW = 300_000;
export const RETENTION = 14 * 86400_000;
export const BODY = '{"job":"source-status"}';
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export interface Definition {
  id: string; worker: string; environment: string; epoch: string; preset: string;
  presetHash: string; source: string; notBefore: number; utc: string; enabled: boolean;
}
export interface Assignment {
  version: 1; id: string; definition: string; at: number; expires: number; requestId: string;
}
export interface Result {
  version: 1; id: string; hash: string; seq: number; closed: boolean;
  status: SessionStatus | null; disposition: "pending" | "uncertain" | "expired" | "session";
}
export function definition(v: unknown): Definition {
  const d = object(v, ["id","worker","environment","epoch","preset","presetHash","source","notBefore","utc","enabled"]);
  check(/^[a-f0-9]{64}$/.test(field(d.presetHash)) && /^[a-f0-9]{40}$/.test(field(d.source)), "davinci_pin");
  check(typeof d.enabled === "boolean" && Number.isSafeInteger(d.notBefore) &&
    Number(d.notBefore) >= 1e12 && Number(d.notBefore) < 9e12, "davinci_definition");
  check(/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(field(d.utc)), "davinci_utc_daily_only");
  return { id:name(d.id), worker:name(d.worker), environment:field(d.environment), epoch:name(d.epoch),
    preset:name(d.preset), presetHash:String(d.presetHash), source:String(d.source),
    notBefore:Number(d.notBefore), utc:String(d.utc), enabled:d.enabled };
}
export const binding = (d: Definition) => JSON.stringify({ ...d, enabled: false });
export const assignmentHash = (a: Assignment) => digest(JSON.stringify(a));
export function assignment(d: Definition, key: string, at: number): Assignment {
  const id = digest(binding(d) + "\n" + key);
  return { version:1, id, definition:digest(binding(d)), at, expires:at+WINDOW, requestId:at+":davinci-"+id };
}
export function decodeAssignment(bytes: string, d: Definition): Assignment {
  check(Buffer.byteLength(bytes) <= 2048, "davinci_assignment_size");
  const a = object(JSON.parse(bytes), ["version","id","definition","at","expires","requestId"]);
  check(a.version===1 && /^[a-f0-9]{64}$/.test(field(a.id)) && a.definition===digest(binding(d)) &&
    Number.isSafeInteger(a.at) && Number(a.at)>=d.notBefore && Number(a.at)<9e12 &&
    a.expires===Number(a.at)+WINDOW && a.requestId===a.at+":davinci-"+a.id, "davinci_assignment_binding");
  return {version:1,id:String(a.id),definition:String(a.definition),at:Number(a.at),expires:Number(a.expires),requestId:String(a.requestId)};
}
export interface ResultReceipt { version:1; kind:"result-receipt" | "receipt-confirmed"; id:string; hash:string; seq:number }
export function decodeReceipt(bytes: string,kind: ResultReceipt["kind"]="result-receipt"): ResultReceipt {
  check(Buffer.byteLength(bytes)<=512,"davinci_receipt_size");
  const r=object(JSON.parse(bytes),["version","kind","id","hash","seq"]);
  check(r.version===1 && r.kind===kind && /^[a-f0-9]{64}$/.test(field(r.id)) &&
    /^[a-f0-9]{64}$/.test(field(r.hash)) && Number.isSafeInteger(r.seq) && Number(r.seq)>0,"davinci_receipt");
  return r as unknown as ResultReceipt;
}
export function decodeResult(bytes: string): Result {
  check(Buffer.byteLength(bytes)<=16384, "davinci_result_size");
  const r=object(JSON.parse(bytes), ["version","id","hash","seq","closed","status","disposition"]);
  check(r.version===1 && /^[a-f0-9]{64}$/.test(field(r.id)) && /^[a-f0-9]{64}$/.test(field(r.hash)) &&
    Number.isSafeInteger(r.seq) && Number(r.seq)>0 && typeof r.closed==="boolean" &&
    ["pending","uncertain","expired","session"].includes(String(r.disposition)), "davinci_result");
  if(r.status!==null) {
    const s=object(r.status);
    check(typeof s.sessionId==="string" && typeof s.threadId==="string" &&
      ["held","released"].includes(String(s.occupancy)) &&
      ["parked","resolved","cancelled","orphaned","needs_attention"].includes(String(s.state)), "davinci_session_status");
    check(r.disposition==="session" && r.closed===(s.occupancy==="released" && s.state!=="parked"), "davinci_result_closed");
  } else check((r.disposition==="expired" && r.closed===true) ||
    (["pending","uncertain"].includes(String(r.disposition)) && r.closed===false), "davinci_result_closed");
  return r as unknown as Result;
}
export function signature(secret: Uint8Array, key: string, delivery: string, timestamp: string, body: string): string {
  return createHmac("sha256",secret).update(key+"\n"+delivery+"\n"+timestamp+"\n"+body).digest("hex");
}
export function authenticate(secret: Uint8Array, key: string, delivery: string, timestamp: string,
  body: string, signed: string, now: number): void {
  check(/^[A-Za-z0-9_-]{1,32}$/.test(key) && /^[0-9]{13}:[A-Za-z0-9_-]{1,80}$/.test(delivery) &&
    /^[0-9]{13}$/.test(timestamp) && timestamp===delivery.slice(0,13) &&
    Math.abs(now-Number(timestamp))<=WINDOW && Buffer.byteLength(body)<=4096 &&
    /^[a-f0-9]{64}$/.test(signed), "davinci_webhook_refused");
  check(timingSafeEqual(Buffer.from(signature(secret,key,delivery,timestamp,body),"hex"),Buffer.from(signed,"hex")),
    "davinci_webhook_refused");
}
