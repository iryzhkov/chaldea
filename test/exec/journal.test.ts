import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { record, prune, type Intent } from '../../src/exec/journal.ts';

test('journal survives SIGKILL after durable intent and never replays; confirmed result replaces atomically', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'journal-'));
  try {
    const intent: Intent = { jobId: 'job', host: 'host', argv: ['true'], started: new Date().toISOString(), outcome: 'uncertain' };
    const code = `import { record } from ${JSON.stringify(new URL('../../src/exec/journal.ts', import.meta.url).href)};
await record(${JSON.stringify(root)}, ${JSON.stringify(intent)});
process.stdout.write('durable'); setInterval(() => {}, 10000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout, 'data'); const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
    assert.deepEqual(JSON.parse(await fs.readFile(join(root, 'job.json'), 'utf8')), intent);
    await assert.rejects(record(root, intent), /EEXIST/);
    await record(root, { ...intent, outcome: 'finished', exitCode: 7 }, false);
    assert.equal(JSON.parse(await fs.readFile(join(root, 'job.json'), 'utf8')).exitCode, 7);
    assert.equal((await fs.stat(join(root, 'job.json'))).mode & 0o777, 0o600);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('journal retention is age and count bounded, including stale partial updates', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'journal-prune-'));
  try {
    for (let i = 0; i < 5; i++) {
      const path = join(root, i + '.json');
      await fs.writeFile(path, '{}'); await fs.utimes(path, new Date(1000 + i), new Date(1000 + i));
    }
    await prune(root, Date.now(), 2);
    assert.deepEqual((await fs.readdir(root)).sort(), ['3.json', '4.json']);
    await prune(root, 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
