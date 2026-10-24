import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { maintain, OperatorRuntime, removeResumePermit, type MaintenanceRuntime } from '../../src/exec/blob-maintenance.ts';

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('resume permit removal persists directory absence and fsync failure refuses', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'resume-permit-'));
  const path = join(root, '.resume-permit');
  const actualSync = fs.fsyncSync;
  let calls = 0;
  const sync = mock.method(fs, 'fsyncSync', (fd: number) => {
    assert.equal(fs.existsSync(path), false);
    assert(fs.fstatSync(fd).isDirectory());
    calls++;
    if (calls === 3) throw Error('injected directory sync failure');
    actualSync(fd);
  });
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(path, 'old success');
    removeResumePermit(path);
    removeResumePermit(path, true);
    fs.writeFileSync(path, 'new success');
    assert.throws(() => removeResumePermit(path), /directory sync failure/);
    assert.equal(calls, 3);
  } finally {
    sync.mock.restore(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(failure = '') {
  const calls: string[] = [];
  let fenceChecks = 0;
  const runtime = Object.fromEntries(['fence', 'verifyFence', 'stop', 'backup', 'start', 'health', 'cleanup', 'completed', 'resume']
    .map(name => [name, async () => {
      const event = name === 'verifyFence' ? name + ++fenceChecks : name;
      calls.push(event);
      if (event === failure || name === failure) throw Error('injected');
      if (name === 'cleanup') return [{ scanned: true, attempted: 0, objects: 0, uploads: 0, uncertain: false }];
    }])) as unknown as MaintenanceRuntime;
  return { calls, runtime };
}
test('successful run stays fenced and requires separate explicit resume', async () => {
  const { calls, runtime } = fixture();
  await maintain(runtime, 'run');
  assert.deepEqual(calls, ['fence', 'verifyFence1', 'stop', 'backup', 'start', 'verifyFence2',
    'health', 'cleanup', 'verifyFence3', 'health', 'completed']);
  calls.length = 0;
  await maintain(runtime, 'resume');
  assert.deepEqual(calls, ['verifyFence4', 'health', 'resume']);
});
for (const stage of ['fence', 'verifyFence1', 'stop', 'backup', 'start', 'verifyFence2', 'health', 'cleanup', 'verifyFence3']) {
  test('failure at ' + stage + ' never resumes or advances beyond failure', async () => {
    const { calls, runtime } = fixture(stage);
    await assert.rejects(maintain(runtime, 'run'));
    assert.equal(calls.at(-1), stage);
    assert(!calls.includes('resume') && !calls.includes('completed'));
    if (stage === 'stop') assert(!calls.includes('backup') && !calls.includes('start'));
  });
}
for (const result of [
  { scanned: false, uncertain: false }, { scanned: true, uncertain: true },
]) test('incomplete or uncertain cleanup cannot create completion receipt', async () => {
  const { calls, runtime } = fixture();
  runtime.cleanup = async () => [{ ...result, attempted: 1, objects: 0, uploads: 0 }];
  await assert.rejects(maintain(runtime, 'run'));
  assert(!calls.includes('completed'));
});


test('apparent unit stop cannot pass while the exact old process still lives', async () => {
  class StillAlive extends RPCFixture {
    inactive = false;
    override async health() {}
    override properties(): Record<string, string> {
      return this.inactive
        ? { ActiveState: 'inactive', MainPID: '0', ControlPID: '0' }
        : { MainPID: String(process.pid) };
    }
    override system(...args: string[]) {
      assert.deepEqual(args, ['stop', '--no-block']);
      this.inactive = true; return '';
    }
  }
  await assert.rejects(new StillAlive().stop());
});
test('stop deadline fails with no signal escalation or backup', async () => {
  class Stuck extends RPCFixture {
    override async health() {}
    override properties() { return { ActiveState: 'deactivating', MainPID: String(process.pid), ControlPID: '0' }; }
    override system(...args: string[]) { assert.deepEqual(args, ['stop', '--no-block']); return ''; }
  }
  let elapsed = 0;
  const clock = mock.method(performance, 'now', () => elapsed += 40000);
  try { await assert.rejects(new Stuck().stop()); } finally { clock.mock.restore(); }
});

const publisher = 'GK' + 'a'.repeat(24), second = 'GK' + 'b'.repeat(24);
const cleanup = 'GK' + 'c'.repeat(24), reader = 'GK' + 'd'.repeat(24), stranger = 'GK' + 'e'.repeat(24);
const bucketId = '1'.repeat(64);
class RPCFixture extends OperatorRuntime {
  calls: { endpoint: string; payload: any }[] = [];
  keys = new Map([publisher, second, reader, cleanup].map(id => [id, {
    read: true, write: id !== reader, owner: false,
  }]));
  failRevoke = '';
  constructor() {
    super({ bindings: [{ bucket: 'fixture', bucketId, principal: 'a',
      publishers: [publisher, second], readers: [reader], cleanupKey: cleanup }] } as any, '', '');
  }
  override assertService() {}
  override api(endpoint: string, payload: any = null) {
    this.calls.push({ endpoint, payload });
    if (endpoint === 'ListBuckets') return [{ id: bucketId, globalAliases: ['fixture'] }];
    if (endpoint === 'ListKeys') return [...this.keys.keys()].map(id => ({ id, name: id }));
    if (endpoint === 'GetKeyInfo') {
      assert(!('showSecretKey' in payload));
      return { buckets: [{ id: bucketId, permissions: this.keys.get(payload.id) }] };
    }
    if (endpoint === 'DenyBucketKey') {
      assert.deepEqual(payload.permissions, { read: false, write: true, owner: false });
      if (payload.accessKeyId === this.failRevoke) throw Error('unknown result');
      this.keys.get(payload.accessKeyId)!.write = false;
      return {};
    }
    throw Error('unexpected RPC');
  }
}
test('all publishers fenced, readers preserved, cleanup is the sole writer', async () => {
  const r = new RPCFixture();
  await r.fence(); await r.verifyFence();
  assert.equal(r.keys.get(publisher)!.write, false);
  assert.equal(r.keys.get(second)!.write, false);
  assert.equal(r.keys.get(reader)!.read, true);
  assert.equal(r.keys.get(cleanup)!.write, true);
});
test('uncertain revocation still attempts every configured publisher', async () => {
  const r = new RPCFixture(); r.failRevoke = publisher;
  await assert.rejects(r.fence());
  assert.equal(r.keys.get(second)!.write, false);
  assert.equal(r.calls.filter(x => x.endpoint === 'DenyBucketKey').length, 2);
});
for (const permission of [
  { read: true, write: true, owner: false }, { read: true, write: false, owner: true },
]) test('unreviewed writer or owner refuses after known publishers are fenced', async () => {
  const r = new RPCFixture(); r.keys.set(stranger, permission);
  await r.fence(); await assert.rejects(r.verifyFence());
  assert.equal(r.keys.get(publisher)!.write, false);
});
test('key-local aliases cannot redirect the trusted global bucket', async () => {
  const r = new RPCFixture(); await r.fence();
  const original = r.api.bind(r);
  r.api = (endpoint: string, payload: any = null) => {
    const value: any = original(endpoint, payload);
    if (endpoint === 'GetKeyInfo') value.buckets[0].localAliases = ['fixture'];
    return value;
  };
  await assert.rejects(r.verifyFence());
});
test('missing known key and publisher owner permission refuse', async () => {
  const r = new RPCFixture(); await r.fence(); r.keys.delete(reader);
  await assert.rejects(r.verifyFence());
  r.keys.set(reader, { read: true, write: false, owner: false });
  r.keys.get(publisher)!.owner = true;
  await assert.rejects(r.verifyFence());
});
