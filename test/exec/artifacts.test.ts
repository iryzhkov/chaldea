import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanArtifacts } from '../../src/exec/artifacts.ts';
import { record, prune, type Intent } from '../../src/exec/journal.ts';

test('per-host artifact cap and 14-day pruning span worktrees, and journal eviction removes artifacts', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'artifacts-'));
  const journal = join(root, 'journal');
  const now = Date.now();
  const entries: Intent[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      const worktree = join(root, 'work-' + i);
      const jobId = '11111111-1111-1111-1111-' + String(i).padStart(12, '0');
      const artifactDir = join(worktree, '.chaldea/artifacts', jobId);
      const entry: Intent = { jobId, host: i === 2 ? 'other' : 'target', argv: ['true'],
        started: new Date(now - 100000 + i * 1000).toISOString(), outcome: 'finished', worktree, artifactDir };
      entries.push(entry);
      await fs.mkdir(artifactDir, { recursive: true }); await fs.writeFile(join(artifactDir, 'out'), '1234');
      await record(journal, entry);
    }
    assert.equal(await cleanArtifacts(journal, 'target', 1, 6, now), 4);
    await assert.rejects(fs.stat(entries[0].artifactDir!), /ENOENT/);
    assert.equal((await fs.stat(entries[1].artifactDir!)).isDirectory(), true);
    assert.equal((await fs.stat(entries[2].artifactDir!)).isDirectory(), true);
    await cleanArtifacts(journal, 'target', 0, 6, now + 15 * 86400000);
    await assert.rejects(fs.stat(entries[1].artifactDir!), /ENOENT/);
    await prune(journal, 1);
    await assert.rejects(fs.stat(entries[2].artifactDir!), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
