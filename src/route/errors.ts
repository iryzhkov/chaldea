export type RouteErrorCode = "usage" | "config" | "catalog_unavailable" | "usage_unavailable" | "no_candidate";
export class RouteError extends Error {
  readonly code: RouteErrorCode;
  constructor(code: RouteErrorCode, message: string) { super(message); this.code = code; this.name = "RouteError"; }
}
export const routeFailure = (error: unknown) => error instanceof RouteError ? error
  : new RouteError("usage_unavailable", "Routing observations unavailable");
