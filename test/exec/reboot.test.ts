import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BOOT_ID, active } from '../../src/exec/artifacts.ts';
import { record, prune, type Intent } from '../../src/exec/journal.ts';

test('source reboot PID reuse does not protect stale intents or prevent the next dispatch', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'reboot-journal-'));
  try {
    const old: Intent = { jobId: 'old', host: 'target', argv: ['true'], started: new Date().toISOString(),
      outcome: 'uncertain', pid: process.pid, bootId: 'previous-boot' };
    assert.equal(active(old), false);
    assert.equal(active({ ...old, bootId: BOOT_ID }), true);
    await record(root, old);
    await prune(root, 14 * 86400000, 0);
    assert.deepEqual(await fs.readdir(root), []);
    // A new intent is independent; the old uncertain job is never dispatched.
    await record(root, { ...old, jobId: 'new', bootId: BOOT_ID });
    assert.equal(JSON.parse(await fs.readFile(join(root, 'new.json'), 'utf8')).outcome, 'uncertain');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
