// Session-only grant codec. The separate access-JWT wire remains unchanged.
import { isDeepStrictEqual } from "node:util";
import { audienceName, exact, grants, identifier, object, requireAccess, seconds, subset } from "../access/token.ts";
import type { TokenGrant } from "../access/issuer.ts";

export type LegacyServiceGrant = Pick<TokenGrant, "audience" | "grants">;
export type HaScope = "ha.read" | "ha.control" | "ha.read ha.control" | "ha.control ha.read";
export interface HolonetGrant {
  audience: "holonet"; scope: "holonet.read"; holonet_server: string; holonet_libraries: string[];
  holonet_catalog_users: string[]; holonet_history_users: []; holonet_target_users: [];
  holonet_actions: ["catalog.read"]; holonet_namespace: string;
}
export type NewServiceGrant =
  | HolonetGrant
  | { audience: "ov"; scope: "ov.read"; ov_namespaces: string[] }
  | { audience: "homelab"; scope: "homelab.read"; homelab_services: string[]; homelab_hosts: string[] }
  | { audience: "ha"; scope: HaScope; ha_entities: string[]; ha_actions: Array<"state.read" | "light.control" | "switch.control"> };
export type SessionServiceGrant = LegacyServiceGrant | NewServiceGrant;
export const SERVICE_AUDIENCES = ["jocasta", "ov", "homelab", "ha", "holonet"] as const;
export type ServiceAudience = typeof SERVICE_AUDIENCES[number];
export const RESOURCES = { holonet: "https://media.mcp.ryzhkov.dev/mcp", ov: "https://ov.mcp.ryzhkov.dev/mcp", homelab: "https://homelab.mcp.ryzhkov.dev/mcp", ha: "https://ha.mcp.ryzhkov.dev/mcp" } as const;
const FIELDS = { holonet: ["holonet_server", "holonet_libraries", "holonet_catalog_users", "holonet_history_users", "holonet_target_users", "holonet_actions", "holonet_namespace"], ov: ["ov_namespaces"], homelab: ["homelab_services", "homelab_hosts"], ha: ["ha_entities", "ha_actions"] } as const;
const HA_SCOPES: readonly string[] = ["ha.read", "ha.control", "ha.read ha.control", "ha.control ha.read"];
export const READ_ONLY_ACTIONS: readonly string[] = ["get", "history", "list", "search"];
export function isNew(s: SessionServiceGrant): s is NewServiceGrant { return !("grants" in s); }
export function grantKeys(audience: unknown): string[] {
  requireAccess(typeof audience === "string" && Object.hasOwn(FIELDS, audience), "invalid_service");
  return ["audience", "scope", ...FIELDS[audience as keyof typeof FIELDS]];
}
function list(v: unknown, min: number, max: number, valid: (s: string) => boolean): string[] {
  requireAccess(Array.isArray(v) && v.length >= min && v.length <= max, "invalid_service_list");
  requireAccess(v.every(s => typeof s === "string" && valid(s)) && new Set(v).size === v.length, "invalid_service_list");
  return [...v] as string[];
}
const contains = (root: string, path: string) => path === root || path.startsWith(root + "/");
function root(s: string): boolean {
  return s.length <= 1024 && /^viking:\/\/resources\/(?:[A-Za-z0-9_@+.,=-]+\/)*[A-Za-z0-9_@+.,=-]+$/.test(s) &&
    s.slice("viking://resources/".length).split("/").every(p => p !== "." && p !== "..");
}
export function parseServiceGrant(value: unknown): SessionServiceGrant {
  const s = object(value);
  if (Object.hasOwn(s, "grants")) {
    exact(s, ["audience", "grants"]); audienceName(s.audience); grants(s.grants);
    // Preserve legacy normalized key and list ordering.
    return { audience: s.audience, grants: structuredClone(s.grants) };
  }
  exact(s, grantKeys(s.audience));
  if (s.audience === "holonet") {
    const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
    requireAccess(s.scope === "holonet.read" && hex(s.holonet_server) &&
      typeof s.holonet_namespace === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(s.holonet_namespace), "invalid_service_scope");
    const libraries = list(s.holonet_libraries, 1, 1, v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
    const users = list(s.holonet_catalog_users, 1, 1, hex);
    list(s.holonet_history_users, 0, 0, hex); list(s.holonet_target_users, 0, 0, hex);
    list(s.holonet_actions, 1, 1, v => v === "catalog.read");
    return { audience: "holonet", scope: "holonet.read", holonet_server: s.holonet_server,
      holonet_libraries: libraries, holonet_catalog_users: users, holonet_history_users: [], holonet_target_users: [],
      holonet_actions: ["catalog.read"], holonet_namespace: s.holonet_namespace };
  }
  if (s.audience === "ov") {
    requireAccess(s.scope === "ov.read", "invalid_service_scope");
    const roots = list(s.ov_namespaces, 1, 16, root);
    requireAccess(!roots.some((r, i) => roots.some((o, j) => i !== j && contains(r, o))), "overlapping_namespaces");
    return { audience: "ov", scope: "ov.read", ov_namespaces: roots };
  }
  if (s.audience === "homelab") {
    requireAccess(s.scope === "homelab.read", "invalid_service_scope");
    const id = (s: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s);
    return { audience: "homelab", scope: "homelab.read",
      homelab_services: list(s.homelab_services, 0, 128, id), homelab_hosts: list(s.homelab_hosts, 0, 128, id) };
  }
  requireAccess(s.audience === "ha" && HA_SCOPES.includes(s.scope as string), "invalid_service_scope");
  const entities = list(s.ha_entities, 1, 64, s => s.length <= 112 && /^(light|switch|sensor|binary_sensor)\.[a-z0-9_]{1,96}$/.test(s));
  const actions = list(s.ha_actions, 1, 3, s => ["state.read", "light.control", "switch.control"].includes(s)) as Extract<NewServiceGrant, { audience: "ha" }>["ha_actions"];
  const scope = s.scope as HaScope;
  requireAccess(actions.every(a => scope.split(" ").includes(a === "state.read" ? "ha.read" : "ha.control")), "action_scope_mismatch");
  return { audience: "ha", scope, ha_entities: entities, ha_actions: actions };
}
export function enrollmentGrant(e: NewServiceGrant): NewServiceGrant {
  return parseServiceGrant(Object.fromEntries(grantKeys(e.audience).map(k => [k, (e as unknown as Record<string, unknown>)[k]]))) as NewServiceGrant;
}
export function issuable(s: SessionServiceGrant): boolean {
  return isNew(s) || (s.audience === "jocasta" && s.grants.every(g => g.actions.every(a => READ_ONLY_ACTIONS.includes(a))));
}
export function serviceSubset(s: SessionServiceGrant, c: SessionServiceGrant): boolean {
  if (s.audience !== c.audience || isNew(s) !== isNew(c)) return false;
  if (!isNew(s) && !isNew(c)) return subset(s.grants, c.grants);
  if (!isNew(s) || !isNew(c)) return false;
  if (s.audience === "holonet" && c.audience === "holonet") return isDeepStrictEqual(s, c);
  if (s.audience === "ov" && c.audience === "ov") return s.ov_namespaces.every(r => c.ov_namespaces.some(o => contains(o, r)));
  const included = (a: string[], b: string[]) => a.every(v => b.includes(v));
  if (s.audience === "homelab" && c.audience === "homelab")
    return included(s.homelab_services, c.homelab_services) && included(s.homelab_hosts, c.homelab_hosts);
  return s.audience === "ha" && c.audience === "ha" && included(s.scope.split(" "), c.scope.split(" ")) &&
    included(s.ha_entities, c.ha_entities) && included(s.ha_actions, c.ha_actions);
}
export interface RunAdmission { runId: string; profile: string; project: string; expiresAt: number; services: SessionServiceGrant[] }
export function validateAdmission(value: RunAdmission, now: number): void {
  exact(object(value), ["runId", "profile", "project", "expiresAt", "services"]);
  identifier(value.runId); identifier(value.profile); identifier(value.project); seconds(value.expiresAt);
  requireAccess(value.expiresAt > now && value.expiresAt <= now + 86400, "invalid_run_deadline");
  requireAccess(Array.isArray(value.services) && value.services.length > 0 && value.services.length <= 7, "invalid_services");
  const parsed = value.services.map(parseServiceGrant);
  requireAccess(new Set(parsed.map(s => s.audience)).size === parsed.length, "duplicate_audience");
  requireAccess(parsed.every(issuable) && (!parsed.some(isNew) || parsed.length === 1), "unsupported_service");
}
export function narrowing(next: RunAdmission, old: RunAdmission): boolean {
  return next.runId === old.runId && next.profile === old.profile && next.project === old.project &&
    next.expiresAt <= old.expiresAt && next.services.every(s => old.services.some(c => serviceSubset(s, c)));
}
/** Signed arrays equal the full admitted grant, including order. Never intersect or sort. */
export function claimsEqual(c: Record<string, unknown>, service: NewServiceGrant): boolean {
  // Match the server's canonical claim-key boundary, including Unicode simple-fold aliases.
  if (service.audience === "holonet") {
    const canonical = ["iss", "aud", "sub", "iat", "exp", "nbf", "scope", ...FIELDS.holonet];
    const fold = (key: string) => key.toLowerCase().replaceAll("\u017f", "s");
    if (Object.keys(c).some(key => canonical.some(k => key !== k && fold(key) === k) ||
      (fold(key).startsWith("holonet_") && !(FIELDS.holonet as readonly string[]).includes(key)))) return false;
  }
  const own = FIELDS[service.audience];
  const foreign = ["jocasta_projects", "grants", "project", "source", ...Object.values(FIELDS).flat().filter(k => !(own as readonly string[]).includes(k))];
  if (foreign.some(k => Object.hasOwn(c, k))) return false;
  try {
    const parsed = parseServiceGrant(Object.fromEntries(grantKeys(service.audience).map(k => [k, k === "audience" ? service.audience : c[k]])));
    if (!isNew(parsed)) return false;
    if (parsed.audience === "ha" && service.audience === "ha")
      return serviceSubset(parsed, service) && serviceSubset(service, parsed) &&
        isDeepStrictEqual(parsed.ha_entities, service.ha_entities) && isDeepStrictEqual(parsed.ha_actions, service.ha_actions);
    return isDeepStrictEqual(parsed, service);
  } catch { return false; }
}
