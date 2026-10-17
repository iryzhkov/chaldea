import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanArtifacts, BOOT_ID } from '../../src/exec/artifacts.ts';
import { record } from '../../src/exec/journal.ts';
import { MAX_ARTIFACT } from '../../src/exec/protocol.ts';

test('active artifact reservations bound concurrent writers before bytes arrive', async () => {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'reservations-'));
  const home = join(root, 'home');
  assert.ok(home.startsWith(resolve(tmpdir()) + '/'));
  try {
    const journal = join(root, 'journal');
    const jobId = '11111111-1111-1111-1111-111111111111';
    const entry = { jobId, host: 'fake', argv: ['true'], started: new Date().toISOString(),
      outcome: 'uncertain' as const, pid: process.pid, bootId: BOOT_ID,
      worktree: root, artifactDir: join(root, '.chaldea/artifacts', jobId), artifactReserve: MAX_ARTIFACT };
    await record(journal, entry);
    assert.equal(await cleanArtifacts(journal, 'fake', 0, MAX_ARTIFACT), MAX_ARTIFACT);
    await assert.rejects(cleanArtifacts(journal, 'fake', 1, MAX_ARTIFACT), /active artifacts protected/);
    await record(journal, { ...entry, outcome: 'finished' }, false);
    assert.equal(await cleanArtifacts(journal, 'fake', MAX_ARTIFACT, MAX_ARTIFACT), 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
