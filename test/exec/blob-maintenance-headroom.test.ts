import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { OperatorRuntime } from '../../src/exec/blob-maintenance.ts';

const STARTER = '/usr/local/libexec/garage-storage-native.py';
const PREFLIGHT = '/usr/local/libexec/garage-storage-preflight.py';
const STORAGE = '/etc/garage/storage.json';
const CONFIG = '/mnt/docker-data/swarm/objectstore/config/garage.toml';
const META = '/mnt/docker-data/swarm/objectstore/meta';
const DATA = '/mnt/nas/ml/garage-blobs';
const BACKUP = '/mnt/docker-data/swarm/objectstore-backups';
const BINARY = '/usr/local/lib/garage/2.4.1/garage';
const gates = ['full_volume', 'mount_loss', 'consistent_restore', 'fresh_client_roundtrip', 'last_copy_policy'];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fixture = (name: string) => fs.readFileSync(new URL('../fixtures/blob-headroom/' + name, import.meta.url));
const starter = fixture('garage-storage-native.py'), preflight = fixture('garage-storage-preflight.py');
const garage = 'metadata_dir = "' + META + '"\ndata_dir = "' + DATA + `"
db_engine = "lmdb"
metadata_fsync = true
data_fsync = true
replication_factor = 1
consistency_mode = "consistent"
compression_level = 1
rpc_bind_addr = "127.0.0.1:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret_file = "/etc/garage/rpc.secret"
[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:3900"
`;
function storageFixture(): any {
  const store = (path: string, mount: any, bytes: number) => ({
    path, mount, acceptance_mode: 'operational_budget',
    operational_budget: { bytes, risk_acceptance: 'test-only budget evidence, no operational authority' },
  });
  return { enabled: true, host: 'test-only', uid: 1000, gid: 1000, data_fsync: true, metadata_fsync: true,
    qualifications: Object.fromEntries(gates.map(g => [g, 'test-only ' + g])),
    data: { ...store(DATA, { target: '/mnt/nas/ml', source: 'fixture:/ml', fstype: 'nfs4',
      fsroot: '/', options: ['rw', 'soft', 'sec=sys'] }, 2e12),
      unknown_filecount_risk_acceptance: 'test-only UNKNOWN evidence, never operator approval' },
    metadata: store('/mnt/docker-data/swarm/objectstore', { target: '/mnt/docker-data',
      source: '/dev/fixture', fstype: 'ext4', fsroot: '/', options: ['rw'] }, 16 * 1024 ** 3) };
}
const known = () => ({ f_bavail: 16 * 1024 ** 4, f_frsize: 1, f_files: 50000, f_ffree: 20000, f_favail: 10000 });
function setup(t: any) {
  const storage = storageFixture();
  const telemetry: any = { data: { ...known(), f_files: 0, f_ffree: 0, f_favail: 0 }, metadata: known() };
  const config: any = { backupRoot: BACKUP, minFreeBytes: 2 * 1024 ** 3, minFreeInodes: 4096 };
  let commandCalls = 0, mountLoss = false, commandFailure = false;
  let response: string | undefined;
  let unsafeParent = false;
  const files = new Map<string, Buffer>([[STARTER, starter], [PREFLIGHT, preflight], [CONFIG, Buffer.from(garage)]]);
  const refresh = () => {
    const unqualified = { ...storage }; delete unqualified.qualifications;
    // Exact Python digest uses sorted keys recursively, compact JSON, ensure_ascii=True.
    const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
    storage.qualifications.configuration = 'sha256:' + hash(JSON.stringify(sorted(unqualified)));
    files.set(STORAGE, Buffer.from(JSON.stringify(storage)));
    for (const [path, key] of [[STARTER, 'starterSHA256'], [PREFLIGHT, 'preflightSHA256'],
      [STORAGE, 'storageSHA256'], [CONFIG, 'garageSHA256']]) config[key!] = hash(files.get(path!)!);
  };
  refresh();
  const originalExec = cp.execFileSync;
  const fds = new Map<number, { bytes: Buffer; offset: number }>();
  t.mock.method(fs, 'lstatSync', (path: string) => ({ isDirectory: () => true, uid: 0,
    mode: unsafeParent && path === '/usr/local' ? 0o40777 : 0o40755, dev: 1, ino: 1 }));
  t.mock.method(fs, 'openSync', (path: string) => {
    assert(files.has(path), 'unexpected trusted path ' + path);
    const fd = 10000 + fds.size; fds.set(fd, { bytes: files.get(path)!, offset: 0 }); return fd;
  });
  t.mock.method(fs, 'fstatSync', (fd: number) => ({ isFile: () => true, nlink: 1, uid: 0, mode: 0o100600,
    size: fds.get(fd)!.bytes.length }));
  t.mock.method(fs, 'readSync', (fd: number, out: Buffer, offset: number, length: number) => {
    const file = fds.get(fd)!;
    const n = file.bytes.copy(out, offset, file.offset, file.offset + length); file.offset += n; return n;
  });
  t.mock.method(fs, 'closeSync', () => {});
  t.mock.method(fs, 'statfsSync', (path: string) => {
    assert([DATA, META, BACKUP].includes(path));
    const value = path === DATA ? telemetry.data : local[path];
    if (value === 'OSError') throw Error('injected statfs failure');
    return value;
  });
  const local: any = Object.fromEntries([META, BACKUP].map(path => [path,
    { bavail: 16 * 1024 ** 4, bsize: 1, files: 50000, ffree: 10000 }]));
  // The old consumer sees the actual observed all-zero data counters.
  Object.assign(telemetry.data, { bavail: 16 * 1024 ** 4, bsize: 1, files: 0, ffree: 0 });
  t.mock.method(fs, 'readlinkSync', () => BINARY);
  t.mock.method(fs, 'readFileSync', (path: string) => {
    if (path.endsWith('/cmdline')) return Buffer.from(BINARY + '\0-c\0' + CONFIG + '\0server\0');
    if (path.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000';
    assert.fail('unexpected health read ' + path);
  });
  files.set('/etc/garage/rpc.secret', Buffer.from('a'.repeat(64)));
  // RPC custody uses owner1000 rather than root.
  const regularStat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd: number) => ({ ...regularStat(fd),
    uid: fds.get(fd)?.bytes === files.get('/etc/garage/rpc.secret') ? 1000 : 0 }));
  t.mock.method(cp, 'execFileSync', (program: string, args: string[], options: any) => {
    commandCalls++;
    assert.equal(program, '/usr/bin/python3');
    assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']);
    assert.equal(args.length, 4);
    assert(!args[3]!.includes('native.main(') && !args[3]!.includes('execGarage'));
    assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 16384);
    if (commandFailure) throw Error('injected command failure');
    if (response !== undefined) return response;
    return originalExec('/usr/bin/python3', ['-I', '-B', fileURLToPath(new URL('../fixtures/blob-headroom/run.py', import.meta.url))], {
      ...options, input: JSON.stringify({ snippet: args[3], pins: JSON.parse(options.input),
        storage, garage, telemetry, mount_loss: mountLoss }),
    });
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  class Runtime extends OperatorRuntime {
    override assertService() {} // Service process identity is independently exercised below through health().
    override properties() { return { ActiveState: 'active', SubState: 'running',
      ControlGroup: '/system.slice/garage-objectstore.service', MainPID: '123' }; }
    override api(endpoint: string) { assert.equal(endpoint, 'GetClusterStatus'); return { nodes: [{ isUp: true, id: 'fixture-node' }] }; }
  }
  const runtime = new Runtime(config, 'fixture-config-hash', '/fixture-pair');
  return { runtime, storage, telemetry, config, local, refresh, files,
    calls: () => commandCalls, mountLoss: () => { mountLoss = true; },
    failCommand: () => { commandFailure = true; }, response: (v: string) => { response = v; },
    unsafeParent: () => { unsafeParent = true; } };
}

test('health accepts observed all-zero NFS only as explicit UNKNOWN, never free inode capacity', async t => {
  const f = setup(t);
  await f.runtime.health();
  assert.equal(f.calls(), 1);
  assert.deepEqual((f.runtime as any).headroomReport.data, {
    available_bytes: 16 * 1024 ** 4, filecounts: 'UNKNOWN', available_inodes: null });
});

test('reviewed native and preflight fixture bytes are unchanged', () => {
  assert.equal(hash(starter), '9bce8cf779b7fe7eb8c66bf65e6894391d76c056d4fe0eff36799a38cb3a18ec');
  assert.equal(hash(preflight), '857bc50d85a711a3253ecfe762fc2d40e84cf5a82e5c24ab3a9b91fa5d5b98af');
});
for (const change of [
  (f: any) => { delete f.storage.data.unknown_filecount_risk_acceptance; },
  (f: any) => { f.storage.data.unknown_filecount_risk_acceptance = ''; },
  (f: any) => { f.storage.data.unknown_filecount_risk_acceptance = '   '; },
  (f: any) => { f.storage.data.unknown_filecount_risk_acceptance = true; },
  (f: any) => { delete f.storage.data.acceptance_mode; },
  (f: any) => { f.storage.data.mount.fstype = 'ext4'; },
  (f: any) => { f.storage.metadata.unknown_filecount_risk_acceptance = 'test-only'; },
]) test('default or invalid UNKNOWN policy refuses through health', async t => {
  const f = setup(t); change(f); f.refresh();
  await assert.rejects(f.runtime.health());
  assert.equal(f.calls(), 1); assert.equal(f.runtime.headroomReport, null);
});
test('nfs and nfs4 share the explicitly accepted UNKNOWN contract', async t => {
  const f = setup(t); f.storage.data.mount.fstype = 'nfs'; f.refresh();
  await f.runtime.headroom();
  assert.equal(f.runtime.headroomReport?.data.available_inodes, null);
});
for (const label of ['data', 'metadata']) for (const values of [
  { f_files: 0, f_ffree: 1, f_favail: 0 }, { f_files: 1, f_ffree: 0, f_favail: 0 },
  { f_files: 5000, f_ffree: 4096, f_favail: 4095 }, { f_files: 5000, f_ffree: 4000, f_favail: 4096 },
  { f_files: -1 }, { f_ffree: true }, { f_favail: null }, { f_files: '50000' },
  { f_favail: 4096.5 }, { f_favail: -1 }, { f_bavail: 0 }, { f_frsize: 0 },
  { f_bavail: true }, { f_frsize: -1 },
]) test(label + ' malformed, inconsistent or low telemetry refuses ' + JSON.stringify(values), async t => {
  const f = setup(t); f.telemetry[label] = { ...known(), ...values };
  await assert.rejects(f.runtime.health()); assert.equal(f.runtime.headroomReport, null);
});
for (const label of ['data', 'metadata']) test(label + ' statvfs OSError refuses', async t => {
  const f = setup(t); f.telemetry[label] = 'OSError'; await assert.rejects(f.runtime.headroom());
});
test('missing filecount member and unknown metadata refuse', async t => {
  const f = setup(t); delete f.telemetry.data.f_favail;
  await assert.rejects(f.runtime.headroom());
  f.telemetry.data = known();
  f.telemetry.metadata = { ...known(), f_files: 0, f_ffree: 0, f_favail: 0 };
  await assert.rejects(f.runtime.headroom());
});
test('known available inodes obey both native and stronger maintenance floors', async t => {
  const f = setup(t);
  for (const floor of [4096, 8192]) {
    f.config.minFreeInodes = floor;
    f.telemetry.data = { ...known(), f_favail: floor - 1 };
    await assert.rejects(f.runtime.health());
    f.telemetry.data.f_favail = floor;
    await f.runtime.health();
    assert.equal(f.runtime.headroomReport?.data.available_inodes, floor);
  }
  // Reserved slots are not available slots. f_ffree alone cannot pass.
  f.telemetry.data = { ...known(), f_favail: 8191, f_ffree: 20000 };
  await assert.rejects(f.runtime.headroom());
});
for (const label of ['data', 'metadata']) test(label + ' byte floor boundary is retained', async t => {
  const f = setup(t); const floor = (label === 'data' ? 1 : 2) * 1024 ** 3;
  f.telemetry[label].f_bavail = floor - 1; await assert.rejects(f.runtime.headroom());
  f.telemetry[label].f_bavail = floor; await f.runtime.headroom();
});
for (const path of [META, BACKUP]) test('local destination floors and failures remain strict ' + path, async t => {
  const f = setup(t);
  for (const bad of [
    { bavail: f.config.minFreeBytes - 1 }, { ffree: 4095 }, { files: 0, ffree: 0 },
    { ffree: NaN }, { bavail: -1 }, { bsize: 0 }, { files: 100, ffree: 10000 },
  ]) {
    const old = { ...f.local[path] }; Object.assign(f.local[path], bad);
    await assert.rejects(f.runtime.headroom()); f.local[path] = old;
  }
  f.config.minFreeBytes *= 2; f.local[path].bavail = f.config.minFreeBytes - 1;
  await assert.rejects(f.runtime.headroom());
  f.local[path] = 'OSError'; await assert.rejects(f.runtime.headroom());
});
for (const gate of gates) test('normal unqualified gate remains refused ' + gate, async t => {
  const f = setup(t); f.storage.qualifications[gate] = null; f.refresh();
  await assert.rejects(f.runtime.health());
});
test('normal policy digest, storage paths and current mount identity remain bound', async t => {
  const f = setup(t);
  f.storage.qualifications.configuration = 'sha256:' + '0'.repeat(64);
  f.files.set(STORAGE, Buffer.from(JSON.stringify(f.storage)));
  f.config.storageSHA256 = hash(f.files.get(STORAGE)!);
  await assert.rejects(f.runtime.health());
  f.storage.data.path = '/mnt/nas/ml/other'; f.refresh(); await assert.rejects(f.runtime.health());
  f.storage.data.path = DATA; f.refresh(); f.mountLoss(); await assert.rejects(f.runtime.health());
});
for (const key of ['starterSHA256', 'preflightSHA256', 'storageSHA256', 'garageSHA256'])
  test('mismatched protected input refuses before Python ' + key, async t => {
    const f = setup(t); f.config[key] = '0'.repeat(64);
    await assert.rejects(f.runtime.health()); assert.equal(f.calls(), 0);
  });
test('untrusted ancestor and service refusal cannot reach the native helper', async t => {
  const f = setup(t); f.unsafeParent(); await assert.rejects(f.runtime.headroom()); assert.equal(f.calls(), 0);
  f.runtime.assertService = () => { throw Error('fixture service mismatch'); };
  await assert.rejects(f.runtime.health()); assert.equal(f.calls(), 0);
});
test('child error, timeout or output overflow fails closed', async t => {
  const f = setup(t); f.failCommand(); await assert.rejects(f.runtime.health());
  assert.equal(f.runtime.headroomReport, null);
});
for (const value of [
  '', '{}', 'null', '[]', '{bad',
  JSON.stringify({ data: { available_bytes: 16 * 1024 ** 4, filecounts: 'UNKNOWN', available_inodes: 0 },
    metadata: { available_bytes: 16 * 1024 ** 4, filecounts: 'known', available_inodes: 10000 } }),
]) test('malformed helper response refuses ' + value.slice(0, 50), async t => {
  const f = setup(t); f.response(value); await assert.rejects(f.runtime.headroom());
});
for (const change of [
  (v: any) => { v.extra = 1; }, (v: any) => { delete v.metadata; },
  (v: any) => { v.data.extra = 1; }, (v: any) => { v.metadata.filecounts = 'UNKNOWN'; v.metadata.available_inodes = null; },
  (v: any) => { v.data.filecounts = 'unknown'; }, (v: any) => { v.data.available_bytes = 1024 ** 3 - 1; },
  (v: any) => { v.metadata.available_bytes = 2 * 1024 ** 3 - 1; },
  (v: any) => { v.data.available_bytes = Number.MAX_SAFE_INTEGER + 1; },
  (v: any) => { v.metadata.available_inodes = true; },
  (v: any) => { v.metadata.available_inodes = 4095; },
  (v: any) => { v.data.filecounts = 'known'; v.data.available_inodes = null; },
]) test('helper JSON result semantics are bounded', async t => {
  const f = setup(t);
  const v = { data: { available_bytes: 16 * 1024 ** 4, filecounts: 'UNKNOWN', available_inodes: null },
    metadata: { available_bytes: 16 * 1024 ** 4, filecounts: 'known', available_inodes: 10000 } };
  change(v); f.response(JSON.stringify(v)); await assert.rejects(f.runtime.headroom());
});
test('successful completion receipt records UNKNOWN as null without a capacity claim', async t => {
  const f = setup(t); await f.runtime.health();
  (f.runtime as any).pairHash = 'a'.repeat(64);
  const open = fs.openSync; const chunks: Buffer[] = [];
  t.mock.method(fs, 'openSync', (path: string, flags: string) => {
    if (path === '/fixture-pair/complete.json') { assert.equal(flags, 'wx'); return 20000; }
    if (path === '/fixture-pair') return 20001;
    return open(path, flags);
  });
  t.mock.method(fs, 'writeSync', (_fd: number, bytes: Buffer, offset: number, length: number) => {
    chunks.push(bytes.subarray(offset, offset + length)); return length;
  });
  t.mock.method(fs, 'fsyncSync', () => {});
  syncBuiltinESMExports();
  await f.runtime.completed();
  const receipt = JSON.parse(Buffer.concat(chunks).toString());
  assert.deepEqual(receipt.headroom, f.runtime.headroomReport);
  assert.equal(receipt.headroom.data.filecounts, 'UNKNOWN');
  assert.equal(receipt.headroom.data.available_inodes, null);
});
