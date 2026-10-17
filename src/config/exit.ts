/** Shared process statuses. Remote exec command statuses pass through unchanged. */
export const EXIT = { ok: 0, failure: 1, usage: 64, unavailable: 69, config: 78, transport: 255 } as const;
