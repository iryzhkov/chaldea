import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, prune } from '../../src/exec/journal.ts';

test('pruning protects a live client intent ahead of finished records', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'journal-active-'));
  try {
    const base = { host: 'test', argv: ['true'], started: new Date().toISOString() };
    await record(root, { ...base, jobId: 'active', pid: process.pid, outcome: 'uncertain' });
    await record(root, { ...base, jobId: 'finished', outcome: 'finished', exitCode: 0 });
    await prune(root, 14 * 86400000, 1);
    assert.deepEqual(await fs.readdir(root), ['active.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
