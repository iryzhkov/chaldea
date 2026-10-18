import { createHash } from "node:crypto";

/** Hash a provider-returned account/organisation ID, never credential bytes. */
export function accountKey(id: unknown): string | undefined {
  return typeof id === "string" && id.length > 0 && id.length <= 512
    ? createHash("sha256").update(id).digest("hex") : undefined;
}
export const capacityKey = (driver: string, account: string) => driver + ":" + account;
