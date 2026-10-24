/** Isolated real-Garage adapter for the production finite sequencing/RPC/cleanup code.
 * Service-manager and mount qualification are separately covered by infra contracts.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { OperatorRuntime, maintain } from '../../src/exec/blob-maintenance.ts';
import { BlobStore, sha256 } from '../../src/exec/blob.ts';
import assert from 'node:assert/strict';

const f = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const binding = f.binding;
const cfg = { bindings: [binding], backupRoot: f.root, minFreeBytes: 2 * 1024 ** 3,
  minFreeInodes: 4096, limits: { maxRequests: 128, maxRequestBytes: 65536,
    maxResponseBytes: 1024 ** 2, maxPageBytes: 65536, maxCandidates: 32,
    maxElapsedMs: 10000, maxMutations: 32, pageSize: 16 } } as any;
let server: ChildProcess | undefined;
const events: string[] = [];
let identity = '', rpc = '';
const metaIdentity = lstatSync(f.meta).ino;
const pair = join(f.root, 'pair');
class Fixture extends OperatorRuntime {
  override assertService() {}
  override api(endpoint: string, payload: unknown = null) {
    return JSON.parse(execFileSync(f.binary, ['-c', f.config, 'json-api', endpoint, '-'],
      { input: JSON.stringify(payload), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000, maxBuffer: 1024 ** 2 }));
  }
  override async health() {
    assert(server && server.exitCode === null && server.signalCode === null);
    const cluster = this.api('GetClusterStatus');
    assert.equal(cluster.nodes[0].isUp, true);
    const current = cluster.nodes[0].id;
    if (identity) assert.equal(identity, current); else identity = current;
    assert.equal(metaIdentity, lstatSync(f.meta).ino);
    const currentRPC = sha256(readFileSync(f.rpc));
    if (rpc) assert.equal(rpc, currentRPC); else rpc = currentRPC;
  }
  override async start() {
    events.push('start');
    server = spawn(f.binary, ['-c', f.config, 'server'], { stdio: 'ignore' });
    const end = Date.now() + 15000;
    for (;;) {
      try { await this.health(); return; }
      catch { assert(Date.now() < end); }
      await new Promise(r => setTimeout(r, 50));
    }
  }
  override async stop() {
    events.push('stop');
    const exact = server!;
    const exited = once(exact, 'exit');
    exact.kill('SIGTERM');
    const timer = setTimeout(() => {}, 5000);
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer.unref(); setTimeout(() => reject(Error('graceful stop timeout')), 5000).unref();
      })]);
      assert(exact.exitCode !== null || exact.signalCode !== null);
      assert.equal(exact.signalCode, null); assert.equal(exact.exitCode, 0);
    } finally { clearTimeout(timer); }
    server = undefined;
  }
  override async backup() {
    events.push('backup');
    assert.equal(server, undefined);
    execFileSync('/usr/bin/python3', ['-I', '-B', 'src/exec/blob_pair.py'], {
      input: JSON.stringify({ meta: f.meta, data: f.data, backup: pair,
        metadataOwner: [process.getuid!(), process.getgid!()], dataOwner: [process.getuid!(), process.getgid!()],
        minFreeBytes: 2 * 1024 ** 3, minFreeInodes: 4096 }), timeout: 125000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  override store() {
    return new BlobStore({ endpoint: f.endpoint, bucket: binding.bucket, principal: binding.principal,
      region: 'garage', credentialFile: binding.credentialFile });
  }
  override async completed() { events.push('complete'); }
}
const runtime = new Fixture(cfg, '', pair);
let passed = false;
try {
  await runtime.start();
  await maintain(runtime, 'run');
  assert.deepEqual(events, ['start', 'stop', 'backup', 'start', 'complete']);
  await runtime.verifyFence();
  assert.equal(runtime.api('GetKeyInfo', { id: binding.publishers[0] }).buckets[0].permissions.write, false);
  assert.equal(runtime.api('GetKeyInfo', { id: binding.publishers[1] }).buckets[0].permissions.write, false);
  // The same cleanup principal reached the existing double-scan cleanup contract.
  const result = JSON.parse(readFileSync(join(pair, 'cleanup-' + binding.bucket + '.json'), 'utf8'));
  assert.equal(result.completed, true); assert.equal(result.result.scanned, true);
  execFileSync('/usr/bin/python3', ['-I', '-B', 'src/exec/blob_pair.py'], {
    input: JSON.stringify({ verify: pair }), timeout: 125000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  passed = true;
} finally {
  if (server) {
    const exact = server;
    const exit = once(exact, 'exit');
    exact.kill('SIGTERM');
    // Fixture-only teardown may kill its exact owned child after failure. Never backup after that.
    const timer = setTimeout(() => exact.kill('SIGKILL'), 5000);
    await exit; clearTimeout(timer);
  }
  writeFileSync(f.result, JSON.stringify({ passed, events, scope: 'isolated local synthetic keys; no systemd or NAS qualification' }));
}
