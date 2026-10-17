import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import definition from '../../host/exec-protocol.json' with { type: 'json' };

export const VERSION = definition.version;
export const QUEUE_VERSION = definition.queueVersion;
export const FETCH_VERSION = definition.fetchVersion;
export const COMMANDS = definition.commands;
export const LIMITS = definition.limits;
export const PATHS = definition.paths;
export const FILE_MODES = definition.fileModes;
export const FRAME_TYPES = definition.frames;
export type FrameType = keyof typeof FRAME_TYPES;
export const MAX_FRAME = LIMITS.maxFrame;
export const MAX_SNAPSHOT = LIMITS.maxSnapshot;
export const MAX_ARTIFACT = LIMITS.maxArtifact;
export const CHUNK = LIMITS.chunk;
export type Refusal = { outcome: 'refused' | 'preempted' | 'uncertain'; message: string; busy?: boolean };
export type Entry = { path: string; size: number; mode: number; sha256: string };
export type Request = { version: number; jobId: string; argv: string[]; cwd: string; gpu: boolean; artifacts: string[]; files: Entry[] };

export function safePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || Buffer.byteLength(path) > LIMITS.maxPathBytes ||
      PATHS.forbiddenCharacters.some(c => path.includes(c)) ||
      path.split('/').some(p => PATHS.forbiddenComponents.includes(p) || PATHS.reservedPrefixes.some(prefix => p.startsWith(prefix)))) {
    throw new Error('unsafe relative path');
  }
}

export function frame(type: string, data: Uint8Array = Buffer.alloc(0)): Buffer {
  if (!Object.hasOwn(FRAME_TYPES, type) || data.length > MAX_FRAME) throw new Error('invalid frame');
  const header = Buffer.alloc(5);
  header.write(type); header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

export async function send(out: Writable, type: string, data: Uint8Array = Buffer.alloc(0)) {
  if (!out.write(frame(type, data))) await once(out, 'drain');
}
export const json = (value: unknown) => Buffer.from(JSON.stringify(value));

export async function* frames(input: Readable): AsyncGenerator<{ type: FrameType; data: Buffer }> {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1);
      const type = pending.toString('ascii', 0, 1);
      if (size > MAX_FRAME || !Object.hasOwn(FRAME_TYPES, type)) throw new Error('invalid frame');
      if (pending.length < size + 5) break;
      yield { type: type as FrameType, data: pending.subarray(5, 5 + size) };
      pending = pending.subarray(5 + size);
    }
  }
  if (pending.length) throw new Error('truncated frame');
}
