import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frame, frames, MAX_FRAME, safePath, VERSION, QUEUE_VERSION, LIMITS, PATHS, FILE_MODES, FRAME_TYPES } from '../../src/exec/protocol.ts';
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
  for (const data of [oversized, Buffer.from('!\0\0\0\0'), Buffer.from('Z\0\0\0\0'), frame('B', Buffer.from('x')).subarray(0, 5)]) {
    await assert.rejects(Array.fromAsync(frames(Readable.from([data]))));
  }
});
test('paths and CLI options cannot introduce SSH flags or traversal', () => {
  for (const name of ['../x', '/x', 'a//x', '.git/config', '.chaldea/artifacts/a', '.chaldea-home/private', 'out/.chaldea-tmp/key', 'a/./x', 'a\\x']) assert.throws(() => safePath(name));
  assert.doesNotThrow(() => safePath('a space/output'));
  assert.throws(() => argumentsFor(['exec', '--host', '-F', '--', 'true']));
  assert.throws(() => argumentsFor(['exec', '--host', 'host', 'true']));
  assert.deepEqual(argumentsFor(['exec', '--host', 'agent-a', '--gpu', '--artifact', 'out', '--', 'echo', '$HOME']),
    { host: 'agent-a', gpu: true, artifacts: ['out'], argv: ['echo', '$HOME'], noQueue: false, queueTimeout: 3600 });
});

test('Python server and TypeScript client share protocol limits, frames and safe paths', () => {
  const paths: unknown[] = [null, 1, '', 'out/file', 'a space/é', 'x'.repeat(LIMITS.maxPathBytes),
    'x'.repeat(LIMITS.maxPathBytes + 1), 'é'.repeat(LIMITS.maxPathBytes / 2 + 1),
    '../x', '/x', 'a//b', 'a/./b', '.git/config', 'nested/.chaldea/output',
    '.chaldea-home/key', 'out/.chaldea-resolv', 'out/.chaldea-tmp/key', 'a\\\\b', 'a\0b'];
  const script = [
    'import json,runpy,sys',
    'm=runpy.run_path(sys.argv[1])',
    'def accepts(path):',
    '    try: m["safe_path"](path); return True',
    '    except (ValueError, TypeError): return False',
    'print(json.dumps({"version":m["VERSION"],"queueVersion":m["QUEUE_VERSION"],"limits":m["LIMITS"],"paths":m["PATHS"],"frames":m["FRAME_TYPES"],"fileModes":m["FILE_MODES"],"accepted":[accepts(p) for p in json.load(sys.stdin)]}))',
  ].join('\n');
  const server = fileURLToPath(new URL('../../host/chaldea-job-server', import.meta.url));
  const python = JSON.parse(execFileSync(process.env.CHALDEA_TEST_PYTHON ?? 'python3',
    ['-I', '-c', script, server], { input: JSON.stringify(paths), encoding: 'utf8' }));
  assert.deepEqual(python, { version: VERSION, queueVersion: QUEUE_VERSION, limits: LIMITS,
    paths: PATHS, frames: FRAME_TYPES, fileModes: FILE_MODES, accepted: paths.map(path => {
      try { safePath(path); return true; } catch { return false; }
    }) });
  for (const type of ['W', 'Y', 'G', 'C']) assert.doesNotThrow(() => frame(type));
  assert.throws(() => frame('Z'), /invalid frame/);
});
