import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { BlobStore, blobConfig, storeIdentity, sha256, validateManifest, RETENTION, jobId, type BlobManifest } from './blob.ts';
import { MAX_ARTIFACT, safePath } from './protocol.ts';
import { active, artifactLocation } from './artifacts.ts';
import { record, type Intent } from './journal.ts';
import { withStateLock, stateDir } from './state.ts';
import { syncDirectory } from '../fs/atomic.ts';

async function entryFor(state: string, id: string): Promise<Intent> {
  jobId(id);
  const entry: Intent = JSON.parse(await fs.readFile(join(state, 'journal', id + '.json'), 'utf8'));
  if (entry.jobId !== id) throw new Error('blob_journal_binding');
  return entry;
}
async function artifactBytes(root: string, name: string, remaining: number) {
  safePath(name);
  const path = join(root, name);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > remaining ||
        await fs.realpath('/proc/self/fd/' + file.fd) !== path) throw new Error('blob_local_artifact_refused');
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('blob_local_artifact_changed');
      offset += bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('blob_local_artifact_changed');
    return data;
  } finally { await file.close(); }
}

/** A separate job lock serializes publication/retry without holding the state
 * accounting lock across S3 traffic. Frozen manifest precedes the first PUT. */
export async function publishJob(state: string, id: string) {
  jobId(id);
  return withStateLock(join(state, 'publication', id), async () => {
    const entry = await entryFor(state, id), config = blobConfig();
    if (!config || !entry.blob || entry.blob.store !== storeIdentity(config)) throw new Error('blob_store_binding');
    if (entry.artifactRecoveryPending) throw new Error('blob_recovery_incomplete');
    if (entry.blob.state === 'confirmed') return entry.blob.manifestKey;
    if (active(entry) || (entry.outcome !== 'finished' && !entry.artifactRecoveryComplete) || entry.outputSyncFailed) throw new Error('blob_job_not_ready');
    const root = artifactLocation(entry);
    if (!root) throw new Error('blob_local_artifacts_missing');
    const requested = entry.requestedArtifacts ?? [];
    requested.forEach(safePath);
    const artifacts: BlobManifest['artifacts'] = [], values = new Map<string, Buffer>();
    let total = 0;
    for (const path of entry.artifactPaths ?? []) {
      const name = path.slice(root.length + 1);
      safePath(name);
      if (path !== join(root, name) || !requested.includes(name) || values.has(name)) throw new Error('blob_local_path_binding');
      const bytes = await artifactBytes(root, name, MAX_ARTIFACT - total);
      total += bytes.length; values.set(name, bytes);
      artifacts.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    }
    artifacts.sort((a, b) => a.path.localeCompare(b.path));
    if (!entry.blob.draft) {
      const createdAt = Math.floor(Date.now() / 1000);
      const manifest: BlobManifest = { version: 1, jobId: id, principal: config.principal,
        createdAt, expiresAt: createdAt + RETENTION, requested, artifacts };
      const body = JSON.stringify(manifest);
      validateManifest(Buffer.from(body), id, config.principal);
      entry.blob.draft = body;
      await withStateLock(state, () => record(join(state, 'journal'), entry, false));
    }
    const body = Buffer.from(entry.blob.draft), manifest = validateManifest(body, id, config.principal);
    if (JSON.stringify(manifest.artifacts) !== JSON.stringify(artifacts) ||
        JSON.stringify(manifest.requested) !== JSON.stringify(requested)) throw new Error('blob_frozen_manifest_conflict');
    const store = new BlobStore(config);
    for (const a of artifacts) {
      const key = 'v1/' + id + '/objects/' + a.sha256;
      const data = values.get(a.path)!;
      await store.request('PUT', key, data);
      const received = await store.request('GET', key, undefined, {}, a.size);
      if (received.length !== a.size || sha256(received) !== a.sha256) throw new Error('blob_custody_integrity');
    }
    const key = 'v1/' + id + '/manifests/' + sha256(body) + '.json';
    await store.request('PUT', key, body);
    const confirmed = await store.manifest(id);
    if (confirmed.key !== key || !confirmed.body.equals(body)) throw new Error('blob_custody_manifest_conflict');
    entry.blob = { state: 'confirmed', store: entry.blob.store, manifestKey: key, draft: body.toString('utf8') };
    await withStateLock(state, () => record(join(state, 'journal'), entry, false));
    return key;
  });
}

/** Fresh authorized context needs only its configured principal and original job
 * UUID, never the producer's worktree or local journal. Existing output refuses. */
export async function fetchArtifacts(id: string, destination: string) {
  jobId(id);
  const config = blobConfig(); if (!config) throw new Error('blob_store_not_configured');
  const store = new BlobStore(config), { value: manifest } = await store.manifest(id);
  const output = resolve(destination);
  if (await fs.realpath(dirname(output)) !== dirname(output)) throw new Error('blob_output_parent_symlink');
  await fs.mkdir(output, { mode: 0o700 });
  let committed = false;
  try {
    for (const a of manifest.artifacts) {
      const bytes = await store.request('GET', 'v1/' + id + '/objects/' + a.sha256, undefined, {}, a.size);
      if (bytes.length !== a.size || sha256(bytes) !== a.sha256) throw new Error('blob_artifact_integrity');
      const target = join(output, a.path);
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const file = await fs.open(target, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      syncDirectory(dirname(target));
    }
    const missing = manifest.requested.filter(path => !manifest.artifacts.some(a => a.path === path));
    const receipt = await fs.open(join(output, '.chaldea-blob-receipt.json'), 'wx', 0o600);
    try { await receipt.writeFile(JSON.stringify(manifest) + '\n'); await receipt.sync(); } finally { await receipt.close(); }
    syncDirectory(output); syncDirectory(dirname(output)); committed = true;
    return { jobId: id, destination: output, artifacts: manifest.artifacts.map(a => a.path), unavailable: missing };
  } finally { if (!committed) await fs.rm(output, { recursive: true, force: true }); }
}

export async function blobCommand(args: string[]) {
  const [operation, id, flag, output] = args;
  if (operation === 'publish' && id && args.length === 2) {
    const key = await publishJob(stateDir(), id);
    process.stdout.write(JSON.stringify({ jobId: id, custody: 'confirmed', manifestKey: key }) + '\n');
  } else if (operation === 'fetch' && id && flag === '--output' && output && args.length === 4) {
    process.stdout.write(JSON.stringify(await fetchArtifacts(id, output)) + '\n');
  } else throw new Error('usage: chaldea exec artifacts publish JOB-ID | artifacts fetch JOB-ID --output NEW-DIRECTORY');
  return 0;
}
