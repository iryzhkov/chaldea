import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_SNAPSHOT, LIMITS, PATHS, FILE_MODES, safePath, type Entry } from './protocol.ts';

export type Snapshot = { root: string; cwd: string; files: (Entry & { data: Buffer })[] };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });

export async function manifest(cwd = process.cwd()): Promise<Snapshot> {
  const root = await fs.realpath(git(cwd, ['rev-parse', '--show-toplevel']).toString().trim());
  const workdir = relative(root, await fs.realpath(cwd)).split('/').join('/');
  if (workdir) safePath(workdir);
  // Runtime output must never become input, including in linked Git worktrees.
  const exclude = resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).toString().trim());
  await fs.mkdir(dirname(exclude), { recursive: true });
  let ignored = ''; try { ignored = await fs.readFile(exclude, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  if (!ignored.split('\n').includes(PATHS.snapshotExclude)) await fs.appendFile(exclude, '\n' + PATHS.snapshotExclude + '\n');

  async function scan() {
    const names = git(root, ['ls-files', '-c', '-o', '--exclude-standard', '-z']);
    if (!Buffer.from(names.toString('utf8')).equals(names)) throw new Error('non-UTF-8 filename');
    const paths = [...new Set(names.toString('utf8').split('\0').filter(Boolean))].sort();
    if (paths.length > LIMITS.maxFiles) throw new Error('manifest exceeds 10000 files');
    let total = 0;
    const files: Snapshot['files'] = [];
    for (const path of paths) {
      safePath(path);
      const absolute = resolve(root, path);
      try {
        let parent = dirname(absolute);
        while (parent !== root) {
          if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('symlink parent: ' + path);
          parent = dirname(parent);
        }
        const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat();
          if (!before.isFile()) throw new Error('only regular files supported: ' + path);
          if (await fs.realpath('/proc/self/fd/' + handle.fd) !== absolute) throw new Error('path changed: ' + path);
          if (before.size > MAX_SNAPSHOT - total) throw new Error('snapshot exceeds 64 MiB');
          const data = Buffer.alloc(before.size);
          let offset = 0;
          while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
            if (!bytesRead) throw new Error('worktree changed during snapshot');
            offset += bytesRead;
          }
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new Error('worktree changed during snapshot');
          }
          total += data.length;
          files.push({ path, size: data.length, mode: before.mode & 0o111 ? FILE_MODES.executable : FILE_MODES.regular,
            sha256: createHash('sha256').update(data).digest('hex'), data });
        } finally { await handle.close(); }
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e; // tracked deletions are absent
      }
    }
    return files;
  }
  const files = await scan();
  const second = await scan();
  const metadata = (items: Snapshot['files']) => JSON.stringify(items.map(({ data, ...entry }) => entry));
  if (metadata(files) !== metadata(second)) throw new Error('worktree changed during snapshot; retry explicitly');
  return { root, cwd: workdir, files };
}
