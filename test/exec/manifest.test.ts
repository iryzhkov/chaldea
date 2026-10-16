import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { manifest } from '../../src/exec/manifest.ts';

test('dirty manifest includes tracked ignored files, modes, spaces and untracked; omits deleted and ignored files', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'manifest-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
  try {
    git('init', '-q');
    await fs.mkdir(join(root, 'sub'));
    await fs.writeFile(join(root, 'tracked'), 'before');
    await fs.writeFile(join(root, 'deleted'), '');
    await fs.writeFile(join(root, '.gitignore'), 'ignored\ntracked\n');
    git('add', '-f', 'tracked', 'deleted', '.gitignore');
    await fs.writeFile(join(root, 'tracked'), 'dirty');
    await fs.unlink(join(root, 'deleted'));
    await fs.writeFile(join(root, 'ignored'), 'not sent');
    await fs.writeFile(join(root, 'sub/a space'), 'new', { mode: 0o755 });
    const snapshot = await manifest(join(root, 'sub'));
    assert.equal(snapshot.cwd, 'sub');
    assert.deepEqual(snapshot.files.map(x => x.path), ['.gitignore', 'sub/a space', 'tracked']);
    assert.equal(snapshot.files[1].mode, 0o755);
    assert.equal(snapshot.files[2].data.toString(), 'dirty');
    await fs.mkdir(join(root, '.chaldea/artifacts'), { recursive: true });
    await fs.writeFile(join(root, '.chaldea/artifacts/out'), 'private output');
    assert.equal((await manifest(root)).files.length, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('reject symlinks, directory entries (submodules), FIFOs, and oversized inputs', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'manifest-reject-'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  try {
    await fs.symlink('/etc/passwd', join(root, 'link'));
    await assert.rejects(manifest(root), /ELOOP/);
    await fs.unlink(join(root, 'link'));
    await fs.writeFile(join(root, 'pipe'), 'tracked');
    execFileSync('git', ['-C', root, 'add', 'pipe']);
    await fs.unlink(join(root, 'pipe'));
    execFileSync('mkfifo', [join(root, 'pipe')]);
    await assert.rejects(manifest(root), /regular/);
    await fs.unlink(join(root, 'pipe'));
    execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'pipe']);
    await fs.mkdir(join(root, 'submodule'));
    execFileSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,submodule']);
    await assert.rejects(manifest(root), /regular/);
    execFileSync('git', ['-C', root, 'update-index', '--force-remove', 'submodule']);
    const file = await fs.open(join(root, 'large'), 'w'); await file.truncate(65 * 1024 ** 2); await file.close();
    await assert.rejects(manifest(root), /64 MiB/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
