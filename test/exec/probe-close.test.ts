import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('probe closes unread stdout before awaiting child close', { timeout: 10000 }, async () => {
  assert.notEqual(tmpdir(), '/tmp');
  const root = await fs.mkdtemp(join(tmpdir(), 'probe-'));
  try {
    const ssh = join(root, 'ssh');
    // More than one readable buffer: the generator yields H and never resumes.
    await fs.writeFile(ssh, '#!/usr/bin/env node\nprocess.stdout.write(Buffer.concat([Buffer.from([72,0,0,0,2,123,125]),Buffer.alloc(1024*1024)]));setInterval(()=>{},1000);\n', { mode: 0o700 });
    const url = new URL('../../src/exec/queue.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      'import {probeHost} from ' + JSON.stringify(url) + '; await probeHost("unused","fake"); console.log("settled");'],
      { env: { ...process.env, PATH: root + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, err);
    assert.equal(out, 'settled\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
