import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupBlobs, BlobCleanupError, type CleanupPolicy } from '../../src/exec/blob-cleanup.ts';
import { RETENTION, sha256, type BlobStore } from '../../src/exec/blob.ts';

const id = '11111111-1111-1111-1111-111111111111', base = 1700000000;
const now = base + RETENTION + 1, stamp = new Date(base * 1000).toISOString();
const objectKey = 'v1/' + id + '/objects/' + sha256('ok');
const manifest = Buffer.from(JSON.stringify({ version: 1, jobId: id, principal: 'a', createdAt: base,
  expiresAt: base + RETENTION, requested: ['report'], artifacts: [{ path: 'report', sha256: sha256('ok'), size: 2 }] }));
const manifestKey = 'v1/' + id + '/manifests/' + sha256(manifest) + '.json';
const policy: CleanupPolicy = { bucket: 'artifact-a', principal: 'a', prefix: 'v1/', allowExpiredLastCopy: true, writersQuiesced: true,
  limits: { maxRequests: 100, maxRequestBytes: 100000, maxResponseBytes: 100000, maxPageBytes: 10000,
    maxCandidates: 100, maxElapsedMs: 1000, maxMutations: 10, pageSize: 1 } };
const clock = { now: () => now, monotonic: () => 0 };
const tag = (name: string, text: string | number) => '<' + name + '>' + String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '</' + name + '>';
const object = (key: string, size: number, date = stamp) => '<Contents>' + tag('Key', key) + tag('LastModified', date) +
  tag('ETag', '"abc"') + tag('Size', size) + '</Contents>';
const upload = (uploadId: string) => '<Upload>' + tag('Key', objectKey) + tag('UploadId', uploadId) + tag('Initiated', stamp) + '</Upload>';
function fixture() {
  let objects = [{ key: manifestKey, body: object(manifestKey, manifest.length) }, { key: objectKey, body: object(objectKey, 2) }];
  let uploads = ['u1', 'u2'];
  const effects: string[] = [], requests: { method: string; path: string; query: Record<string, string> }[] = [];
  let transform = (body: string, _query: Record<string, string>) => body;
  let failure = '';
  const store = {
    config: { bucket: 'artifact-a', principal: 'a' } as BlobStore['config'],
    async exchange(method: string, path: string, _bytes?: Buffer, query: Record<string, string> = {}, cap = 10000, timeout = 1000) {
      assert.ok(cap > 0 && timeout > 0 && timeout <= policy.limits.maxElapsedMs);
      requests.push({ method, path, query });
      if (failure === 'timeout') throw new Error('timeout');
      if (method === 'DELETE') {
        effects.push(query.uploadId ?? path);
        if (failure === 'delete' && !query.uploadId || failure === 'abort' && query.uploadId) return { status: 503, body: Buffer.alloc(0) };
        if (failure === 'lost') throw new Error('lost_reply');
        if (query.uploadId) uploads = uploads.filter(u => u !== query.uploadId);
        else objects = objects.filter(o => o.key !== path);
        return { status: 204, body: Buffer.alloc(0) };
      }
      if (path) return { status: 200, body: manifest };
      const multipart = 'uploads' in query;
      const offset = multipart ? (query['upload-id-marker'] ? uploads.indexOf(query['upload-id-marker']) + 1 : 0)
        : Number(query['continuation-token'] ?? 0);
      const data = multipart ? uploads.map(upload) : objects.map(o => o.body);
      const more = offset + 1 < data.length;
      let body = multipart ? tag('Bucket', 'artifact-a') + tag('Prefix', 'v1/') + tag('KeyMarker', query['key-marker'] ?? '') +
        tag('UploadIdMarker', query['upload-id-marker'] ?? '') + tag('MaxUploads', 1)
        : tag('Name', 'artifact-a') + tag('Prefix', 'v1/') + tag('MaxKeys', 1) +
          (query['continuation-token'] ? tag('ContinuationToken', query['continuation-token']) : '') + tag('KeyCount', offset < data.length ? 1 : 0);
      body += tag('IsTruncated', String(more)) + (data[offset] ?? '');
      if (more) body += multipart ? tag('NextKeyMarker', objectKey) + tag('NextUploadIdMarker', uploads[offset]!)
        : tag('NextContinuationToken', String(offset + 1));
      const root = multipart ? 'ListMultipartUploadsResult' : 'ListBucketResult';
      body = transform('<' + root + '>' + body + '</' + root + '>', query);
      return { status: 200, body: Buffer.from(body) };
    },
  };
  return { store, effects, requests, setTransform: (f: typeof transform) => { transform = f; },
    setFailure: (f: string) => { failure = f; },
    replaceObjects: (values: typeof objects) => { objects = values; } };
}
async function refuses(f: ReturnType<typeof fixture>, expected: RegExp, p = policy, c = clock) {
  await assert.rejects(cleanupBlobs(f.store, p, c), (error: unknown) => {
    assert.ok(error instanceof BlobCleanupError);
    assert.match(error.message, expected); assert.equal(error.result.attempted, 0); return true;
  });
  assert.deepEqual(f.effects, []);
}

test('bounded two-page object and same-key multipart traversal, all scans before effects, idempotent repeat', async () => {
  const f = fixture();
  assert.deepEqual(await cleanupBlobs(f.store, policy, clock), { scanned: true, attempted: 4, objects: 2, uploads: 2, uncertain: false });
  assert.deepEqual(f.effects, ['u1', 'u2', objectKey, manifestKey]);
  assert.equal(f.requests.findIndex(r => r.method === 'DELETE'), 10);
  assert.deepEqual(await cleanupBlobs(f.store, policy, clock), { scanned: true, attempted: 0, objects: 0, uploads: 0, uncertain: false });
});

test('every configured resource limit refuses before effects when scan or batch cannot fit', async () => {
  for (const [name, value] of Object.entries({ maxRequests: 10, maxRequestBytes: 1, maxResponseBytes: 1,
    maxPageBytes: 1, maxCandidates: 7, maxMutations: 3 })) {
    await refuses(fixture(), /bound|xml/, { ...policy, limits: { ...policy.limits, [name]: value } });
  }
  const f = fixture(); let ticks = 0;
  await refuses(f, /elapsed/, policy, { now: () => now, monotonic: () => ticks++ * 100 });
  const outage = fixture(); outage.setFailure('timeout'); await refuses(outage, /timeout/);
});

test('malformed XML, wrong bucket/prefix/echo, duplicate fields, invalid rows and pagination fail closed', async () => {
  const transforms = [
    (s: string) => s.replace('artifact-a', 'artifact-b'),
    (s: string) => s.replace('<Prefix>v1/</Prefix>', '<Prefix>foreign/</Prefix>'),
    (s: string) => s.replace('<MaxKeys>1</MaxKeys>', '<MaxKeys>2</MaxKeys>'),
    (s: string) => s.replace('<IsTruncated>true</IsTruncated>', '<IsTruncated>maybe</IsTruncated>'),
    (s: string) => s.replace('<NextContinuationToken>1</NextContinuationToken>', ''),
    (s: string) => s.replace('<ContinuationToken>1</ContinuationToken>', '<ContinuationToken>wrong</ContinuationToken>'),
    (s: string) => s.replace('<NextUploadIdMarker>u1</NextUploadIdMarker>', '<NextUploadIdMarker>wrong</NextUploadIdMarker>'),
    (s: string) => s.replace('<KeyMarker>' + objectKey + '</KeyMarker>', '<KeyMarker>wrong</KeyMarker>'),
    (s: string) => s.replace('<UploadIdMarker>u1</UploadIdMarker>', '<UploadIdMarker>wrong</UploadIdMarker>'),
    (s: string) => s.replace('<IsTruncated>', '<Prefix>v1/</Prefix><IsTruncated>'),
    (s: string) => s.replace(stamp, '2023-02-30T00:00:00Z'),
    (s: string) => s.replace(stamp, new Date((now + 1) * 1000).toISOString()),
    (s: string) => s.replace(id, '../other'),
    (s: string) => s.replace('<Size>2</Size>', '<Size>-1</Size>'),
    (s: string) => s.replace('<ETag>&quot;abc&quot;</ETag>', '<ETag>bad</ETag>'),
    (s: string) => '<!DOCTYPE x>' + s,
    (s: string) => s.replace('v1/', '&unknown;'),
    (s: string) => s.slice(0, -1),
    (s: string) => s.replace('<Contents>', '<Contents extra="x">'),
  ];
  for (const transform of transforms) {
    const f = fixture(); f.setTransform(transform); await refuses(f, /cleanup/);
  }
});

test('forbidden XML character-data terminator refuses before object deletion or multipart abort', async () => {
  for (const member of ['Contents', 'Upload']) {
    const f = fixture();
    f.setTransform(s => s.replace('</' + member + '>', '<StorageClass>]]></StorageClass></' + member + '>'));
    await refuses(f, /xml/);
  }
  // The equivalent escaped text is legal XML character data.
  const escaped = fixture();
  escaped.setTransform(s => s.replace('</Upload>', '<StorageClass>]]&gt;</StorageClass></Upload>'));
  assert.equal((await cleanupBlobs(escaped.store, policy, clock)).attempted, 4);
});

test('duplicate rows and nonprogress continuation tokens refuse', async () => {
  const duplicate = fixture();
  duplicate.replaceObjects([{ key: objectKey, body: object(objectKey, 2) }, { key: objectKey, body: object(objectKey, 2) }]);
  await refuses(duplicate, /progress/);
  const loop = fixture();
  loop.setTransform((s, q) => q['continuation-token'] ? s.replace('<IsTruncated>false</IsTruncated>',
    '<IsTruncated>true</IsTruncated><NextContinuationToken>1</NextContinuationToken>') : s);
  await refuses(loop, /progress/);
});

test('foreign principal, invalid manifest metadata and changed second scan have zero effects', async () => {
  await refuses(fixture(), /policy/, { ...policy, principal: 'b' });
  await refuses(fixture(), /policy/, { ...policy, writersQuiesced: false } as unknown as CleanupPolicy);
  const bad = fixture();
  const exchange = bad.store.exchange.bind(bad.store);
  bad.store.exchange = async (...args) => args[1] === manifestKey ? { status: 200, body: Buffer.from('{}') } : exchange(...args);
  await refuses(bad, /manifest_integrity/);
  const foreign = fixture();
  const wrong = Buffer.from(manifest.toString().replace('"principal":"a"', '"principal":"b"'));
  const wrongKey = 'v1/' + id + '/manifests/' + sha256(wrong) + '.json';
  foreign.replaceObjects([{ key: wrongKey, body: object(wrongKey, wrong.length) }]);
  const read = foreign.store.exchange.bind(foreign.store);
  foreign.store.exchange = async (...args) => args[1] === wrongKey ? { status: 200, body: wrong } : read(...args);
  await refuses(foreign, /binding/);
  const race = fixture();
  race.setTransform((s, _q) => race.requests.length > 5 ? s.replaceAll('abc', 'changed') : s);
  await refuses(race, /scan_changed/);
});

test('recent objects hold the whole job; orphan objects are retained; young uploads are retained', async () => {
  const f = fixture();
  f.setTransform(s => s.replaceAll(stamp, new Date(now * 1000).toISOString()));
  assert.equal((await cleanupBlobs(f.store, policy, clock)).attempted, 0);
  const orphan = fixture(); orphan.replaceObjects([{ key: objectKey, body: object(objectKey, 2) }]);
  assert.equal((await cleanupBlobs(orphan.store, policy, clock)).objects, 0);
});

test('abort/delete refusal and lost replies report partial effects without retry; repeat completes remaining objects', async () => {
  for (const failure of ['abort', 'delete', 'lost']) {
    const f = fixture(); f.setFailure(failure);
    await assert.rejects(cleanupBlobs(f.store, policy, clock), (error: unknown) => {
      assert.ok(error instanceof BlobCleanupError); assert.equal(error.result.scanned, true);
      assert.equal(error.result.uncertain, true);
      assert.equal(error.result.attempted, failure === 'delete' ? 3 : 1);
      assert.equal(error.result.uploads, failure === 'delete' ? 2 : 0); return true;
    });
  }
  const f = fixture(), exchange = f.store.exchange.bind(f.store);
  let deletes = 0;
  f.store.exchange = async (...args) => {
    if (args[0] === 'DELETE' && ++deletes === 4) return { status: 503, body: Buffer.alloc(0) };
    return exchange(...args);
  };
  await assert.rejects(cleanupBlobs(f.store, policy, clock));
  assert.equal(f.effects.includes(objectKey), true); assert.equal(f.effects.includes(manifestKey), false);
  assert.equal((await cleanupBlobs(f.store, policy, clock)).objects, 1);
});

test('valid hashes cannot hide invalid manifest metadata; recent manifests protect older objects', async () => {
  for (const change of [
    { expiresAt: base + RETENTION - 1 },
    { requested: ['../escape'] },
    { principal: 'b' },
    { createdAt: now + 1, expiresAt: now + 1 + RETENTION },
  ]) {
    const f = fixture(), bytes = Buffer.from(JSON.stringify({ ...JSON.parse(manifest.toString()), ...change }));
    const path = 'v1/' + id + '/manifests/' + sha256(bytes) + '.json';
    f.replaceObjects([{ key: path, body: object(path, bytes.length) }, { key: objectKey, body: object(objectKey, 2) }]);
    const exchange = f.store.exchange.bind(f.store);
    f.store.exchange = async (...args) => args[1] === path ? { status: 200, body: bytes } : exchange(...args);
    await refuses(f, /binding|path|manifest_time/);
  }
  const recent = fixture();
  recent.replaceObjects([{ key: manifestKey, body: object(manifestKey, manifest.length, new Date(now * 1000).toISOString()) },
    { key: objectKey, body: object(objectKey, 2) }]);
  assert.equal((await cleanupBlobs(recent.store, policy, clock)).objects, 0);
  const missing = fixture();
  missing.replaceObjects([{ key: manifestKey, body: object(manifestKey, manifest.length) }]);
  await refuses(missing, /manifest_object/, policy, { now: () => base + 10, monotonic: () => 0 });
  const wrongSize = fixture();
  wrongSize.replaceObjects([{ key: manifestKey, body: object(manifestKey, manifest.length) },
    { key: objectKey, body: object(objectKey, 3) }]);
  await refuses(wrongSize, /manifest_object/);
});

test('late scan timeout and duplicate upload identity still have zero effects', async () => {
  const late = fixture(), exchange = late.store.exchange.bind(late.store);
  let manifestReads = 0;
  late.store.exchange = async (...args) => {
    if (args[1] === manifestKey && ++manifestReads === 2) throw new Error('timeout');
    return exchange(...args);
  };
  await refuses(late, /timeout/);
  const duplicate = fixture();
  duplicate.setTransform(s => s.replace('<UploadId>u2</UploadId>', '<UploadId>u1</UploadId>'));
  await refuses(duplicate, /progress/);
});

test('404 confirms idempotent effects; a deadline during mutation reports an uncertain attempt', async () => {
  const absent = fixture(), exchange = absent.store.exchange.bind(absent.store);
  absent.store.exchange = async (...args) => {
    const reply = await exchange(...args);
    return args[0] === 'DELETE' ? { ...reply, status: 404 } : reply;
  };
  assert.equal((await cleanupBlobs(absent.store, policy, clock)).attempted, 4);
  const late = fixture();
  await assert.rejects(cleanupBlobs(late.store, policy,
    { now: () => now, monotonic: () => late.effects.length ? 1000 : 0 }), (error: unknown) => {
    assert.ok(error instanceof BlobCleanupError); assert.match(error.message, /elapsed/);
    assert.equal(error.result.attempted, 1); assert.equal(error.result.uncertain, true);
    assert.equal(error.result.uploads, 0); return true;
  });
  assert.equal(late.effects.length, 1);
});
