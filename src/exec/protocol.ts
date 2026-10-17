import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export const VERSION = 1;
export const MAX_FRAME = 1024 * 1024;
export const MAX_SNAPSHOT = 64 * 1024 * 1024;
export const MAX_ARTIFACT = 64 * 1024 * 1024;
export const CHUNK = 64 * 1024;
export type Entry = { path: string; size: number; mode: number; sha256: string };
export type Request = { version: number; jobId: string; argv: string[]; cwd: string; gpu: boolean; artifacts: string[]; files: Entry[] };

export function safePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 ||
      path.includes('\\') || path.includes('\0') ||
      path.split('/').some(p => !p || ['.', '..', '.git', '.chaldea'].includes(p))) {
    throw new Error('unsafe relative path');
  }
}

export function frame(type: string, data: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!/^[A-Z]$/.test(type) || data.length > MAX_FRAME) throw new Error('invalid frame');
  const header = Buffer.alloc(5);
  header.write(type); header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

export async function send(out: Writable, type: string, data: Uint8Array = Buffer.alloc(0)) {
  if (!out.write(frame(type, data))) await once(out, 'drain');
}
export const json = (value: unknown) => Buffer.from(JSON.stringify(value));

export async function* frames(input: Readable): AsyncGenerator<{ type: string; data: Buffer }> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1);
      const type = pending.toString('ascii', 0, 1);
      if (size > MAX_FRAME || !/^[A-Z]$/.test(type)) throw new Error('invalid frame');
      if (pending.length < size + 5) break;
      yield { type, data: pending.subarray(5, 5 + size) };
      pending = pending.subarray(5 + size);
    }
  }
  if (pending.length) throw new Error('truncated frame');
}
