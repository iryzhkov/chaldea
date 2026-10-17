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


test('lock open and flock operation errors fail clearly with 255, without a busy refusal', { timeout: 10000 }, async () => {
  const cli = fileURLToPath(new URL('../../bin/chaldea', import.meta.url));
  for (const kind of ['open', 'flock']) {
    const state = await fs.mkdtemp(join(tmpdir(), 'lock-error-'));
    try {
      const fixture = join(state, 'failing-flock');
      await fs.writeFile(fixture, '#!/bin/sh\nexit 71\n', { mode: 0o700 });
      if (kind === 'open') await fs.mkdir(join(state, 'artifacts-test.lock'));
      const args = [cli, 'exec', '--host', 'test', '--', 'true'];
      // Replace only the external utility in the execve request. The shipped
      // lock script, error handling, PID and exit behavior execute unchanged.
      const inject = [
        'const execve = process.execve;',
        'process.execve = (file, args, env) => {',
        '  if (file === "/bin/sh") args[2] = args[2].replace("/usr/bin/flock", \'"$CHALDEA_TEST_FLOCK"\');',
        '  return execve(file, args, env);',
        '};',
        'process.argv = [process.execPath, ...' + JSON.stringify(args) + '];',
        'await import(' + JSON.stringify(new URL('../../bin/chaldea', import.meta.url).href) + ');',
      ].join('\n');
      const child = spawn(process.execPath, kind === 'flock' ? ['--input-type=module', '-e', inject] : args, {
        env: { ...process.env, CHALDEA_STATE_DIR: state, CHALDEA_SSH_CONFIG: join(state, 'nonexistent'),
          CHALDEA_TEST_FLOCK: fixture, CHALDEA_ACCOUNT_LOCKED: '', CHALDEA_ACCOUNT_REFUSED: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = ''; let err = '';
      child.stdout!.on('data', x => { out += x; }); child.stderr!.on('data', x => { err += x; });
      const [code] = await once(child, 'close');
      assert.equal(code, 255, err); assert.equal(out, '');
      assert.match(err, kind === 'open' ? /cannot open local host lock/ : /local host lock failed \(flock exit 71\)/);
      assert.doesNotMatch(err, /another local chaldea exec/);
      await assert.rejects(fs.access(join(state, 'journal')), { code: 'ENOENT' });
    } finally {
      await fs.rm(state, { recursive: true, force: true });
    }
  }
});
