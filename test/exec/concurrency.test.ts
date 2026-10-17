import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('a busy local host reports a durable refusal without attempting SSH', { timeout: 10000 }, async () => {
  const state = await fs.mkdtemp(join(tmpdir(), 'concurrent-'));
  const holder = spawn('/usr/bin/flock', ['-n', '-F', join(state, 'artifacts-test.lock'),
    process.execPath, '-e', 'process.stdout.write("locked"); process.stdin.resume()'],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const holderExit = once(holder, 'close');
  try {
    await Promise.race([once(holder.stdout!, 'data'), holderExit.then(() => { throw new Error('lock holder exited'); })]);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/chaldea', import.meta.url)),
      'exec', '--host', 'test', '--', 'printf', 'must-not-run'], {
      env: { ...process.env, CHALDEA_STATE_DIR: state, CHALDEA_SSH_CONFIG: join(state, 'nonexistent'),
        CHALDEA_ACCOUNT_LOCKED: '', CHALDEA_ACCOUNT_REFUSED: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = ''; let err = '';
    child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
    const [code] = await once(child, 'close');
    assert.equal(code, 255); assert.equal(out, '');
    assert.match(err, /host test refused: another local chaldea exec.*nothing dispatched/);
    const entries = await fs.readdir(join(state, 'journal'));
    assert.equal(entries.length, 1);
    const intent = JSON.parse(await fs.readFile(join(state, 'journal', entries[0]), 'utf8'));
    assert.equal(intent.host, 'test'); assert.equal(intent.outcome, 'refused');
    assert.deepEqual(intent.argv, ['printf', 'must-not-run']);
  } finally {
    holder.kill('SIGTERM'); await holderExit;
    await fs.rm(state, { recursive: true, force: true });
  }
});
