// Only invoked by the isolated pinned Garage fixture with disposable synthetic keys.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { BlobStore, type BlobConfig } from '../../src/exec/blob.ts';
import { cleanupBlobs, BlobCleanupError, type CleanupPolicy } from '../../src/exec/blob-cleanup.ts';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as BlobConfig;
const store = new BlobStore(config);
const now = Number(process.argv[3]!);
const policy: CleanupPolicy = { bucket: config.bucket, principal: config.principal, prefix: 'v1/',
  allowExpiredLastCopy: true, writersQuiesced: true,
  limits: { maxRequests: 80, maxRequestBytes: 65536, maxResponseBytes: 1024 * 1024,
    maxPageBytes: 65536, maxCandidates: 64, maxElapsedMs: 15000, maxMutations: 16, pageSize: 2 } };
const clock = { now: () => now, monotonic: () => performance.now() };
const pages = { objects: 0, uploads: 0 };
const exchange = store.exchange.bind(store);
store.exchange = async (...args) => {
  const reply = await exchange(...args);
  if (args[0] === 'GET' && args[1] === '') {
    if ('uploads' in (args[3] ?? {})) pages.uploads++; else pages.objects++;
  }
  return reply;
};
// A scan that cannot fit must leave all original objects and uploads intact.
await assert.rejects(cleanupBlobs(store, { ...policy, limits: { ...policy.limits, maxCandidates: 2 } }, clock),
  (error: unknown) => error instanceof BlobCleanupError && error.result.attempted === 0 && /candidate_bound/.test(error.message));
pages.objects = 0; pages.uploads = 0;
const result = await cleanupBlobs(store, policy, clock);
assert.deepEqual(result, { scanned: true, attempted: 9, objects: 6, uploads: 3, uncertain: false });
assert.ok(pages.objects >= 6 && pages.uploads >= 4);
const traversed = { ...pages };
assert.deepEqual(await cleanupBlobs(store, policy, clock),
  { scanned: true, attempted: 0, objects: 0, uploads: 0, uncertain: false });
console.log(JSON.stringify({ passed: true, result, pages: traversed, overboundZeroEffects: true, repeatEmpty: true }));
