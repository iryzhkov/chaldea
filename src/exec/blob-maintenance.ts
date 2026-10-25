import { execFileSync } from 'node:child_process';
import { mkdirSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readJson, readTrustedFile, onlyKeys } from '../config/files.ts';
import { BlobStore, sha256, type BlobConfig } from './blob.ts';
import { BlobCleanupError, cleanupBlobs, type CleanupLimits, type CleanupResult } from './blob-cleanup.ts';

const SERVICE = 'garage-objectstore.service';
const BINARY = '/usr/local/lib/garage/2.4.1/garage';
const BINARY_SHA = 'ae49f8de4aaee6b5ca305f7cbdccc8cd8a29b2804aac074649f18bfb83d0a2b6';
const UNIT = '/etc/systemd/system/' + SERVICE;
const STARTER = '/usr/local/libexec/garage-storage-native.py';
const PREFLIGHT = '/usr/local/libexec/garage-storage-preflight.py';
const STORAGE = '/etc/garage/storage.json';
const CONFIG = '/mnt/docker-data/swarm/objectstore/config/garage.toml';
const RPC = '/etc/garage/rpc.secret';
const META = '/mnt/docker-data/swarm/objectstore/meta';
const DATA = '/mnt/nas/ml/garage-blobs';
const CGROUP = '/sys/fs/cgroup/system.slice/' + SERVICE;
const fail = (): never => { throw new Error('blob_maintenance_refused'); };
const require = (value: unknown): void => { if (!value) fail(); };
// Fixed read-only consumer of the hash-bound native producer. check() includes the
// normal preflight gates, mount/custody checks and shared filecount policy.
// Importing under a non-main name never runs the starter's exec path.
const NATIVE_HEADROOM = `import hashlib, json, types
from pathlib import Path
import sys, tomllib
pins = json.load(sys.stdin)
starter = "/usr/local/libexec/garage-storage-native.py"
raw = Path(starter).read_bytes()
assert hashlib.sha256(raw).hexdigest() == pins["starterSHA256"]
native = types.ModuleType("garage_maintenance_headroom")
native.__file__ = starter
exec(compile(raw, starter, "exec"), native.__dict__)
def pinned(path, key, cap):
    raw = native.trusted(path, cap)
    native.require(hashlib.sha256(raw).hexdigest() == pins[key], "maintenance input hash mismatch")
    return raw
pinned("/usr/local/libexec/garage-storage-preflight.py", "preflightSHA256", 65536)
storage = json.loads(pinned("/etc/garage/storage.json", "storageSHA256", 65536))
garage = tomllib.loads(pinned("/mnt/docker-data/swarm/objectstore/config/garage.toml", "garageSHA256", 16384).decode())
native.require(storage["data"]["path"] == "/mnt/nas/ml/garage-blobs"
               and storage["metadata"]["path"] == "/mnt/docker-data/swarm/objectstore", "fixed maintenance paths required")
print(json.dumps(native.check(storage, garage)["startup_headroom"], allow_nan=False))
`;
type FileHeadroom = { available_bytes: number; filecounts: 'known' | 'UNKNOWN'; available_inodes: number | null };
type HeadroomReport = { data: FileHeadroom; metadata: FileHeadroom };
type Permission = { read: boolean; write: boolean; owner: boolean };
type KeyInfo = { id: string; name: string };
type Binding = { bucket: string; bucketId: string; principal: string; publishers: string[];
  readers: string[]; cleanupKey: string; credentialFile: string };
// Finite global maxima, repeated and enforced again by blob_pair.py. Capacity is checked
// against current local space at every backup; these are not allocation or target facts.
const TREE_MAXIMA = { maxEntries: 262144, maxAllocatedBytes: 256 * 1024 ** 3,
  maxReadBytes: 256 * 1024 ** 3, maxLogicalBytes: 2 * 1024 ** 4 } as const;
const MAX_BACKUP_ELAPSED_MS = 6 * 3600 * 1000;
const LEGACY_BACKUP_ELAPSED_MS = 120000;
type TreeLimits = Record<keyof typeof TREE_MAXIMA, number>;
export type BackupLimits = { maxElapsedMs: number; meta: TreeLimits; data: TreeLimits };
type Config = { version: 1; enabled: true; unitSHA256: string; starterSHA256: string;
  preflightSHA256: string; storageSHA256: string; garageSHA256: string;
  backupRoot: string; minFreeBytes: number; minFreeInodes: number;
  backupLimits?: BackupLimits; limits: CleanupLimits; bindings: Binding[] };
export interface MaintenanceRuntime {
  fence(): Promise<void>; verifyFence(): Promise<void>; stop(): Promise<void>;
  backup(): Promise<void>; start(): Promise<void>; health(): Promise<void>;
  cleanup(): Promise<CleanupResult[]>; completed(): Promise<void>; resume(): Promise<void>;
}

/** No compensation/retry/regrant on failure. Runtime owns the exclusive operator lock. */
export async function maintain(runtime: MaintenanceRuntime, action: 'run' | 'resume') {
  if (action === 'resume') {
    await runtime.verifyFence(); await runtime.health(); await runtime.resume();
    return;
  }
  await runtime.fence();
  await runtime.verifyFence();
  await runtime.stop();
  await runtime.backup();
  await runtime.start();
  await runtime.verifyFence();
  await runtime.health();
  const results = await runtime.cleanup();
  require(results.every(r => r.scanned && !r.uncertain));
  await runtime.verifyFence();
  await runtime.health();
  await runtime.completed();
}

function custody(path: string, directory = false) {
  require(resolve(path) === path && path.startsWith('/'));
  for (const part of [...parents(dirname(path)), ...(directory ? [path] : [])]) {
    const s = lstatSync(part);
    require(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022));
  }
}
function parents(path: string): string[] {
  return path === '/' ? ['/'] : [...parents(dirname(path)), path];
}
function trusted(path: string, cap = 65536) {
  custody(path);
  return readTrustedFile(path, { owners: [0], maxBytes: cap });
}
function syncDirectory(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durable(path: string, bytes: Buffer) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      require(written > 0); offset += written;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function removeResumePermit(path: string, optional = false) {
  try { unlinkSync(path); }
  catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Persist absence BEFORE any new revocation or publisher grant.
  syncDirectory(dirname(path));
}
// Fixed programs and fixed command families only. Suppress raw child diagnostics.
function command(program: string, argv: string[], input?: string, timeout = 10000, maxBuffer = 1024 * 1024) {
  try {
    return execFileSync(program, argv, { input, timeout, maxBuffer,
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', RUST_LOG: 'off' },
      stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch { return fail(); }
}
const exactKeys = (value: any, keys: readonly string[]) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const within = (value: unknown, maximum: number) =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
/** Protected per-tree backup limits: exact keys, positive safe integers, finite maxima. */
export function validateBackupLimits(value: any): BackupLimits {
  require(exactKeys(value, ['maxElapsedMs', 'meta', 'data']) && within(value.maxElapsedMs, MAX_BACKUP_ELAPSED_MS));
  for (const name of ['meta', 'data']) {
    const tree = value[name];
    require(exactKeys(tree, Object.keys(TREE_MAXIMA)) &&
      Object.entries(TREE_MAXIMA).every(([key, maximum]) => within(tree[key], maximum)));
  }
  return value;
}
function loadConfig(): { config: Config; hash: string } {
  require(process.geteuid?.() === 0);
  const raw = trusted('/etc/chaldea/blob-maintenance.json');
  const c = JSON.parse(raw.toString());
  onlyKeys(c, ['version', 'enabled', 'unitSHA256', 'starterSHA256', 'preflightSHA256', 'storageSHA256',
    'garageSHA256', 'backupRoot', 'minFreeBytes', 'minFreeInodes', 'backupLimits', 'limits', 'bindings']);
  require(c.version === 1 && c.enabled === true);
  for (const key of ['unitSHA256', 'starterSHA256', 'preflightSHA256', 'storageSHA256', 'garageSHA256'])
    require(typeof c[key] === 'string' && /^[a-f0-9]{64}$/.test(c[key]));
  require(c.backupRoot === '/mnt/docker-data/swarm/objectstore-backups' &&
    Number.isSafeInteger(c.minFreeBytes) && c.minFreeBytes >= 2 * 1024 ** 3 &&
    Number.isSafeInteger(c.minFreeInodes) && c.minFreeInodes >= 4096);
  // Omitted keeps the legacy fixture bounds; the config hash binds limits to every receipt.
  if (c.backupLimits !== undefined) validateBackupLimits(c.backupLimits);
  require(Array.isArray(c.bindings) && c.bindings.length > 0 && c.bindings.length <= 16);
  const buckets = new Set(), ids = new Set();
  for (const b of c.bindings) {
    onlyKeys(b, ['bucket', 'bucketId', 'principal', 'publishers', 'readers', 'cleanupKey', 'credentialFile']);
    require(typeof b.bucket === 'string' && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b.bucket) &&
      typeof b.bucketId === 'string' && /^[a-f0-9]{64}$/.test(b.bucketId) &&
      typeof b.principal === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.principal));
    require(!buckets.has(b.bucket) && !ids.has(b.bucketId));
    buckets.add(b.bucket); ids.add(b.bucketId);
    require(Array.isArray(b.publishers) && b.publishers.length > 0 && b.publishers.length <= 32 &&
      Array.isArray(b.readers) && b.readers.length <= 32);
    const keys = [...b.publishers, ...b.readers, b.cleanupKey];
    require(new Set(keys).size === keys.length && keys.every(k => typeof k === 'string' && /^GK[a-f0-9]{24}$/.test(k)));
    require(b.credentialFile === '/etc/chaldea/blob-cleanup-' + b.bucket + '.json');
  }
  const l = c.limits;
  require(l && Object.keys(l).sort().join(',') ===
    'maxCandidates,maxElapsedMs,maxMutations,maxPageBytes,maxRequestBytes,maxRequests,maxResponseBytes,pageSize' &&
    Object.values(l).every(v => Number.isSafeInteger(v) && Number(v) > 0));
  require(l.maxCandidates <= 4096 && l.maxRequests <= 32768 && l.maxMutations <= 4096 &&
    l.maxElapsedMs <= 120000 && l.maxResponseBytes <= 64 * 1024 ** 2 &&
    l.maxPageBytes <= 1024 ** 2 && l.maxRequestBytes <= 16 * 1024 ** 2 && l.pageSize <= 1000);
  return { config: c, hash: sha256(raw) };
}

export class OperatorRuntime implements MaintenanceRuntime {
  readonly config: Config;
  readonly hash: string;
  readonly pair: string;
  private before = '';
  private metadata = '';
  private rpcHash = '';
  private pairHash = '';
  headroomReport: HeadroomReport | null = null;
  constructor(config: Config, hash: string, pair: string) {
    this.config = config; this.hash = hash; this.pair = pair;
  }
  api(endpoint: string, payload: unknown = null): any {
    return JSON.parse(command(BINARY, ['-c', CONFIG, 'json-api', endpoint, '-'], JSON.stringify(payload)));
  }
  system(...args: string[]) { return command('/usr/bin/systemctl', [...args, SERVICE]); }
  properties() {
    const out = this.system('show', '--property=ActiveState,SubState,MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,NeedDaemonReload,SendSIGKILL,Restart,User,Group');
    return Object.fromEntries(out.trim().split('\n').map(line => {
      const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
    }));
  }
  assertService() {
    const c = this.config;
    for (const [path, expected, cap] of [
      [UNIT, c.unitSHA256, 16384], [STARTER, c.starterSHA256, 65536],
      [PREFLIGHT, c.preflightSHA256, 65536], [STORAGE, c.storageSHA256, 65536],
      [CONFIG, c.garageSHA256, 16384], [BINARY, BINARY_SHA, 128 * 1024 ** 2],
    ] as const) require(sha256(trusted(path, cap)) === expected);
    const p = this.properties();
    require(p.FragmentPath === UNIT && p.DropInPaths === '' && p.NeedDaemonReload === 'no' &&
      p.SendSIGKILL === 'no' && p.Restart === 'no' && p.User === '1000' && p.Group === '1000');
  }
  async headroom() {
    this.headroomReport = null;
    this.assertService();
    const c = this.config;
    // Recheck protected inputs at this seam as well as in the fixed Python call.
    for (const [path, expected, cap] of [
      [STARTER, c.starterSHA256, 65536], [PREFLIGHT, c.preflightSHA256, 65536],
      [STORAGE, c.storageSHA256, 65536], [CONFIG, c.garageSHA256, 16384],
    ] as const) require(sha256(trusted(path, cap)) === expected);
    const out = JSON.parse(command('/usr/bin/python3', ['-I', '-B', '-c', NATIVE_HEADROOM],
      JSON.stringify({ starterSHA256: c.starterSHA256, preflightSHA256: c.preflightSHA256,
        storageSHA256: c.storageSHA256, garageSHA256: c.garageSHA256 }), 10000, 16384));
    require(exactKeys(out, ['data', 'metadata']));
    for (const label of ['data', 'metadata'] as const) {
      const row = out[label];
      require(exactKeys(row, ['available_bytes', 'filecounts', 'available_inodes']) &&
        Number.isSafeInteger(row.available_bytes) &&
        row.available_bytes >= (label === 'data' ? 1024 ** 3 : c.minFreeBytes));
      require(row.filecounts === 'known'
        ? Number.isSafeInteger(row.available_inodes) && row.available_inodes >= c.minFreeInodes
        : label === 'data' && row.filecounts === 'UNKNOWN' && row.available_inodes === null);
    }
    // Local metadata and backup retain every stronger maintenance floor.
    for (const path of [META, c.backupRoot]) {
      const { statfsSync } = await import('node:fs');
      const fs = statfsSync(path);
      require(Number.isSafeInteger(fs.bavail) && fs.bavail >= 0 &&
        Number.isSafeInteger(fs.bsize) && fs.bsize > 0 &&
        Number.isSafeInteger(fs.bavail * fs.bsize) && fs.bavail * fs.bsize >= c.minFreeBytes &&
        Number.isSafeInteger(fs.files) && Number.isSafeInteger(fs.ffree) &&
        fs.files >= fs.ffree && fs.ffree >= c.minFreeInodes);
    }
    this.headroomReport = out;
  }
  async health() {
    this.assertService();
    const p = this.properties();
    require(p.ActiveState === 'active' && p.SubState === 'running' && p.ControlGroup === '/system.slice/' + SERVICE);
    const pid = Number(p.MainPID);
    require(Number.isSafeInteger(pid) && pid > 1);
    const { readlinkSync } = await import('node:fs');
    require(readlinkSync('/proc/' + pid + '/exe') === BINARY);
    const cmd = readFileSync('/proc/' + pid + '/cmdline').toString().split('\0').filter(Boolean);
    require(JSON.stringify(cmd) === JSON.stringify([BINARY, '-c', CONFIG, 'server']));
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    require(/^Uid:\s+1000\s+1000\s+1000\s+1000$/m.test(status) &&
      /^Gid:\s+1000\s+1000\s+1000\s+1000$/m.test(status));
    const cluster = this.api('GetClusterStatus');
    require(cluster.nodes?.length === 1 && cluster.nodes[0].isUp === true);
    if (this.before) require(cluster.nodes[0].id === this.before);
    else this.before = cluster.nodes[0].id;
    const s = lstatSync(META);
    const identity = s.dev + ':' + s.ino;
    if (this.metadata) require(identity === this.metadata); else this.metadata = identity;
    custody(RPC);
    const rpc = readTrustedFile(RPC, { owners: [1000], secret: true, maxBytes: 128 });
    const rpcHash = sha256(rpc);
    if (this.rpcHash) require(this.rpcHash === rpcHash); else this.rpcHash = rpcHash;
    await this.headroom();
  }
  async permissions(fenced: boolean) {
    const deadline = performance.now() + 30000;
    const buckets = this.api('ListBuckets');
    require(Array.isArray(buckets) && buckets.length <= 64);
    const keys: KeyInfo[] = this.api('ListKeys');
    require(Array.isArray(keys) && keys.length <= 64 && new Set(keys.map(k => k.id)).size === keys.length);
    for (const b of this.config.bindings) {
      require(buckets.filter((x: any) => x.id === b.bucketId && x.globalAliases?.includes(b.bucket)).length === 1);
      for (const id of [...b.publishers, ...b.readers, b.cleanupKey]) require(keys.some(k => k.id === id));
      for (const key of keys) {
        require(performance.now() < deadline);
        const info = this.api('GetKeyInfo', { id: key.id }); // NEVER showSecretKey.
        require(Array.isArray(info.buckets) && info.buckets.length <= 64);
        // Local aliases can shadow the global alias used by the S3 cleanup client.
        require(info.buckets.every((row: any) => Array.isArray(row.localAliases ?? []) &&
          (row.localAliases ?? []).length === 0));
        const rows = info.buckets.filter((x: any) => x.id === b.bucketId);
        require(rows.length <= 1);
        const p: Permission = rows[0]?.permissions ?? { read: false, write: false, owner: false };
        require(Object.keys(p).sort().join(',') === 'owner,read,write' &&
          Object.values(p).every(v => typeof v === 'boolean'));
        require(p.owner === false);
        if (key.id === b.cleanupKey) require(p.read && p.write);
        else if (b.publishers.includes(key.id)) require(p.read && p.write === !fenced);
        else if (b.readers.includes(key.id)) require(p.read && !p.write);
        else require(!p.write);
      }
    }
  }
  async fence() {
    this.assertService();
    // Attempt every configured publisher even when one revocation is uncertain.
    let failed = false;
    for (const b of this.config.bindings) for (const accessKeyId of b.publishers) {
      try { this.api('DenyBucketKey', { bucketId: b.bucketId, accessKeyId,
        permissions: { read: false, write: true, owner: false } }); }
      catch { failed = true; }
    }
    require(!failed);
  }
  async verifyFence() { await this.permissions(true); }
  async stop() {
    await this.health();
    const old = this.properties().MainPID!;
    const ticks = readFileSync('/proc/' + old + '/stat', 'utf8').split(') ')[1]!.split(' ')[19];
    this.system('stop', '--no-block');
    const end = performance.now() + 35000;
    for (;;) {
      const p = this.properties();
      if (['inactive', 'failed'].includes(p.ActiveState!) && p.MainPID === '0' && p.ControlPID === '0') {
        let alive = false;
        try { alive = readFileSync('/proc/' + old + '/stat', 'utf8').split(') ')[1]!.split(' ')[19] === ticks; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        let populated = false;
        try { populated = !/^populated 0$/m.test(readFileSync(CGROUP + '/cgroup.events', 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        require(!alive && !populated);
        return;
      }
      require(performance.now() < end);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  stopped() {
    this.assertService();
    const p = this.properties();
    require(p.ActiveState === 'inactive' && p.MainPID === '0' && p.ControlPID === '0');
  }
  /** Runs the trusted pair helper under the configured limits; returns the manifest hash it wrote or verified. */
  pairHelper(input: Record<string, unknown>) {
    const helper = fileURLToPath(new URL('./blob_pair.py', import.meta.url));
    trusted(helper);
    // The profile is derived from protected storage, never from maintenance config.
    // Native check's normal interface and every-start result fields stay unchanged.
    const storage = trusted(STORAGE);
    require(sha256(storage) === this.config.storageSHA256);
    const declared = JSON.parse(storage.toString());
    const managed = Object.hasOwn(declared.data ?? {}, 'access_profile');
    const boundInput = managed ? { ...input, storage: storage.toString(), storageSHA256: this.config.storageSHA256 } : input;
    const limits = this.config.backupLimits;
    const elapsed = limits?.maxElapsedMs ?? LEGACY_BACKUP_ELAPSED_MS;
    const out = JSON.parse(command('/usr/bin/python3', ['-I', '-B', helper],
      JSON.stringify(limits ? { ...boundInput, limits } : boundInput), elapsed + 5000));
    require(exactKeys(out, ['pairSHA256']) && typeof out.pairSHA256 === 'string' && /^[a-f0-9]{64}$/.test(out.pairSHA256));
    return out.pairSHA256 as string;
  }
  async backup() {
    this.stopped();
    this.pairHash = this.pairHelper({ meta: META, data: DATA, backup: this.pair, metadataOwner: [1000, 1000],
      dataOwner: [977, 988], minFreeBytes: this.config.minFreeBytes, minFreeInodes: this.config.minFreeInodes });
    this.stopped();
    // The pair retains the exact server config and RPC secret for future offline recovery.
    const copies = [
      ['garage.toml', trusted(CONFIG, 16384)],
      ['storage.json', trusted(STORAGE)],
      ['rpc.secret', readTrustedFile(RPC, { owners: [1000], secret: true, maxBytes: 128 })],
    ] as const;
    for (const [name, bytes] of copies) {
      durable(join(this.pair, name), bytes);
      require(sha256(trusted(join(this.pair, name))) === sha256(bytes));
    }
  }
  async start() {
    this.stopped();
    this.system('start', '--no-block');
    // RPC CLI has a bounded call; no mutation or bootstrap is retried.
    const end = performance.now() + 30000;
    for (;;) {
      try { await this.health(); return; } catch { require(performance.now() < end); }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  store(b: Binding) {
    custody(b.credentialFile);
    const credential = readJson(b.credentialFile, false, undefined, { secret: true, maxBytes: 4096 });
    require(credential.accessKeyId === b.cleanupKey);
    const config: BlobConfig = { endpoint: 'http://127.0.0.1:3900', bucket: b.bucket,
      principal: b.principal, region: 'garage', credentialFile: b.credentialFile };
    return new BlobStore(config);
  }
  async cleanup() {
    const results: CleanupResult[] = [];
    for (const b of this.config.bindings) {
      await this.verifyFence(); await this.health();
      const store = this.store(b);
      try {
        const result = await cleanupBlobs(store, { bucket: b.bucket, principal: b.principal,
          prefix: 'v1/', allowExpiredLastCopy: true, writersQuiesced: true, limits: this.config.limits });
        results.push(result);
        durable(join(this.pair, 'cleanup-' + b.bucket + '.json'), Buffer.from(JSON.stringify({ completed: true, result })));
      } catch (error) {
        durable(join(this.pair, 'cleanup-' + b.bucket + '.json'), Buffer.from(JSON.stringify({
          completed: false, result: error instanceof BlobCleanupError ? error.result : null,
        })));
        throw error;
      }
    }
    return results;
  }
  async completed() {
    require(this.pairHash && this.headroomReport);
    durable(join(this.pair, 'complete.json'), Buffer.from(JSON.stringify({
      version: 1, configSHA256: this.hash, node: this.before, metadata: this.metadata,
      rpcSHA256: this.rpcHash, pairSHA256: this.pairHash, headroom: this.headroomReport,
    })));
  }
  async resume() {
    const receipt = JSON.parse(trusted(join(this.pair, 'complete.json')).toString());
    require(receipt.version === 1 && receipt.configSHA256 === this.hash && receipt.node === this.before &&
      receipt.metadata === this.metadata && receipt.rpcSHA256 === this.rpcHash &&
      typeof receipt.pairSHA256 === 'string' && /^[a-f0-9]{64}$/.test(receipt.pairSHA256));
    require(!readdirSync(this.pair).includes('resumed.json'));
    require(sha256(trusted(join(this.pair, 'garage.toml'))) === this.config.garageSHA256 &&
      sha256(trusted(join(this.pair, 'storage.json'))) === this.config.storageSHA256 &&
      sha256(trusted(join(this.pair, 'rpc.secret'))) === this.rpcHash);
    const permit = join(this.config.backupRoot, '.resume-permit');
    require(trusted(permit).toString() === this.pair);
    // Rehash under the same config-bound limits; the verified manifest bytes must be the receipt's.
    require(this.pairHelper({ verify: this.pair }) === receipt.pairSHA256);
    // Consume before grants. A crash or later run cannot replay this permission.
    removeResumePermit(permit);
    // Caller requested this separate action. On any partial grant, refence ALL known writers.
    try {
      for (const b of this.config.bindings) for (const accessKeyId of b.publishers)
        this.api('AllowBucketKey', { bucketId: b.bucketId, accessKeyId,
          permissions: { read: false, write: true, owner: false } });
      await this.permissions(false);
      durable(join(this.pair, 'resumed.json'), Buffer.from(JSON.stringify({ configSHA256: this.hash })));
    } catch { await this.fence(); fail(); }
  }
}

export async function operatorMain(args: string[]) {
  require(args[0] === 'run' && args.length === 1 || args[0] === 'resume' && args.length === 2 &&
    /^[a-f0-9-]{36}$/.test(args[1]!));
  const { config, hash } = loadConfig();
  custody(config.backupRoot, true);
  require(!(lstatSync(config.backupRoot).mode & 0o077));
  const lock = join(config.backupRoot, '.maintenance-lock');
  mkdirSync(lock, { mode: 0o700 }); // Exclusive, no stale-lock takeover.
  const id = args[0] === 'run' ? randomUUID() : args[1]!;
  try {
    const runtime = new OperatorRuntime(config, hash, join(config.backupRoot, id));
    if (args[0] === 'run') {
      // Invalidate older success BEFORE any new revocation, even if this run then fails.
      removeResumePermit(join(config.backupRoot, '.resume-permit'), true);
    }
    await maintain(runtime, args[0] as 'run' | 'resume');
    if (args[0] === 'run')
      durable(join(config.backupRoot, '.resume-permit'), Buffer.from(runtime.pair));
    process.stdout.write(JSON.stringify({ completed: true, publication: args[0] === 'run' ? 'fenced' : 'resumed', backupId: id,
      headroom: runtime.headroomReport }) + '\n');
  } finally { rmdirSync(lock); }
}
