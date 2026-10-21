import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validateManifest, sha256, RETENTION, blobConfig, BlobStore } from '../../src/exec/blob.ts';
import { cleanArtifacts, removeArtifacts } from '../../src/exec/artifacts.ts';
import { record, prune, type Intent } from '../../src/exec/journal.ts';

test('manifest binds job/principal/path and aggregate limits, expiry and unavailable names', () => {
  const id = randomUUID(), now = 1000;
  const value = { version: 1, jobId: id, principal: 'a', createdAt: now, expiresAt: now + RETENTION,
    requested: ['report.txt', 'missing'], artifacts: [{ path: 'report.txt', size: 2, sha256: sha256('ok') }] };
  const check = (v: unknown, job = id, principal = 'a', clock = now) => validateManifest(Buffer.from(JSON.stringify(v)), job, principal, clock);
  assert.deepEqual(check(value), value);
  assert.throws(() => check(value, randomUUID()), /binding/);
  assert.throws(() => check(value, id, 'b'), /binding/);
  assert.throws(() => check(value, id, 'a', now + RETENTION), /binding/);
  for (const artifacts of [
    [{ ...value.artifacts[0], path: '../escape' }], [{ ...value.artifacts[0], path: 'foreign' }],
    [{ ...value.artifacts[0], size: 64 * 1024 * 1024 + 1 }], [...value.artifacts, ...value.artifacts],
  ]) assert.throws(() => check({ ...value, artifacts }));
  assert.throws(() => check({ ...value, requested: Array(33).fill('report.txt') }));
});

test('pending custody survives age, journal eviction and cap pressure; confirmed custody releases normal pruning', async () => {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'blob-retention-'));
  try {
    const id = randomUUID(), journal = join(root, 'journal'), worktree = join(root, 'work');
    const artifactDir = join(worktree, '.chaldea/artifacts', id);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(join(artifactDir, 'report'), 'data');
    const entry: Intent = { jobId: id, host: 'target', argv: ['true'], started: '2000-01-01T00:00:00Z',
      outcome: 'finished', worktree, artifactDir, blob: { state: 'pending', store: sha256('store') } };
    await record(journal, entry);
    await assert.rejects(removeArtifacts(entry), /pending/);
    await cleanArtifacts(journal, 'target', 0, 4);
    await assert.rejects(cleanArtifacts(journal, 'target', 1, 4), /cap reached/);
    await prune(journal, 0, 0);
    assert.equal(await fs.readFile(join(artifactDir, 'report'), 'utf8'), 'data');
    assert.equal(JSON.parse(await fs.readFile(join(journal, id + '.json'), 'utf8')).blob.state, 'pending');
    const lockDir = join(root, 'publication', id);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(join(lockDir, 'accounting.lock'), '');
    entry.blob!.state = 'confirmed';
    await record(journal, entry, false);
    await cleanArtifacts(journal, 'target', 0, 4);
    await assert.rejects(fs.stat(artifactDir), /ENOENT/);
    await prune(journal, 0, 0);
    await assert.rejects(fs.stat(lockDir), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('blob configuration is opt-in, validates origin and reuses private credential reader', async () => {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'blob-config-'));
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    const dir = join(root, 'chaldea'); await fs.mkdir(dir);
    assert.equal(blobConfig(), undefined);
    const credentialFile = join(dir, 'key.json');
    await fs.writeFile(credentialFile, JSON.stringify({ accessKeyId: 'GKfixture', secretAccessKey: 'synthetic-only' }), { mode: 0o600 });
    const config = { version: 1, endpoint: 'https://store.example', bucket: 'artifact-a', principal: 'a', region: 'garage', credentialFile };
    const put = (value: object) => fs.writeFile(join(dir, 'blob.json'), JSON.stringify(value), { mode: 0o600 });
    await put(config);
    const valid = blobConfig()!;
    new BlobStore(valid);
    for (const endpoint of ['http://store.example', 'https://u:p@store.example', 'https://store.example/path', 'https://store.example?q=x']) {
      await put({ ...config, endpoint }); assert.throws(blobConfig, /Invalid blob/);
    }
    await put(config); await fs.chmod(credentialFile, 0o644);
    assert.throws(() => new BlobStore(valid), /Credential requires/);
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old;
    await fs.rm(root, { recursive: true, force: true });
  }
});
