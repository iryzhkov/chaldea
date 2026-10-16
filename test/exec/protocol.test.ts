import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { frame, frames, MAX_FRAME, safePath } from '../../src/exec/protocol.ts';
import { argumentsFor } from '../../src/exec/client.ts';

test('framing handles every-byte fragmentation, coalescing, empty and binary frames', async () => {
  const data = Buffer.concat([frame('H', Buffer.from('{}')), frame('B', Buffer.from([0, 255])), frame('E')]);
  for (const parts of [[data], [...data].map(x => Buffer.from([x]))]) {
    const parsed = await Array.fromAsync(frames(Readable.from(parts)));
    assert.deepEqual(parsed.map(x => [x.type, [...x.data]]), [['H', [123, 125]], ['B', [0, 255]], ['E', []]]);
  }
});
test('framing fails closed on oversize, invalid type and truncated input', async () => {
  const oversized = Buffer.alloc(5); oversized.write('B'); oversized.writeUInt32BE(MAX_FRAME + 1, 1);
  for (const data of [oversized, Buffer.from('!\0\0\0\0'), frame('B', Buffer.from('x')).subarray(0, 5)]) {
    await assert.rejects(Array.fromAsync(frames(Readable.from([data]))));
  }
});
test('paths and CLI options cannot introduce SSH flags or traversal', () => {
  for (const name of ['../x', '/x', 'a//x', '.git/config', '.chaldea/artifacts/a', 'a/./x', 'a\\x']) assert.throws(() => safePath(name));
  assert.doesNotThrow(() => safePath('a space/output'));
  assert.throws(() => argumentsFor(['exec', '--host', '-F', '--', 'true']));
  assert.throws(() => argumentsFor(['exec', '--host', 'host', 'true']));
  assert.deepEqual(argumentsFor(['exec', '--host', 'agent-a', '--gpu', '--artifact', 'out', '--', 'echo', '$HOME']),
    { host: 'agent-a', gpu: true, artifacts: ['out'], argv: ['echo', '$HOME'] });
});
