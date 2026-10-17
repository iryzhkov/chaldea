import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const [version, output] = process.argv.slice(2);
if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || !output) {
  throw new Error('Usage: node scripts/build-host.mjs VERSION OUTPUT');
}
const stage = mkdtempSync(join(tmpdir(), 'host-build-'));
try {
  mkdirSync(join(stage, 'host'));
  for (const [source, name] of [
    ['src/access/maintenance.ts', 'access-maintenance.mjs'],
    ['src/events/collector.ts', 'akasha-collector.mjs'],
  ]) {
    await build({ entryPoints: [source], outfile: join(stage, 'host', name), bundle: true,
      platform: 'node', format: 'esm', target: 'node26', packages: 'bundle',
      sourcemap: false, legalComments: 'inline' });
  }
  const result = spawnSync('python3', ['scripts/package-host.py', version, resolve(output), stage], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('host packaging failed');
} finally { rmSync(stage, { recursive: true, force: true }); }
