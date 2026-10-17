import test from 'node:test';
import assert from 'node:assert/strict';
import { sshStderr } from '../../src/exec/ssh-stderr.ts';

async function filtered(chunks: (string | Buffer)[]) {
  const stream = sshStderr();
  const result = (async () => {
    const output: Buffer[] = [];
    for await (const chunk of stream) output.push(chunk);
    return Buffer.concat(output);
  })();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return result;
}

test('only known OpenSSH mux fallback diagnostics are quiet, across chunk boundaries', async () => {
  const refused = 'mux_client_request_session: session request failed: Session open refused by peer';
  const collision = 'ControlSocket /scratch/socket already exists, disabling multiplexing';
  const input = refused + '\n' + collision + '\r\n' + 'Permission denied (publickey).\n';
  for (let split = 0; split <= input.length; split++) {
    assert.equal((await filtered([input.slice(0, split), input.slice(split)])).toString(),
      'Permission denied (publickey).\n');
  }
  assert.equal((await filtered([refused])).length, 0);
  assert.equal((await filtered(['prefix ' + refused + '\n', 'mux_client_request_session: other error\n'])).toString(),
    'prefix ' + refused + '\nmux_client_request_session: other error\n');
});

test('other SSH stderr keeps exact bytes, including long lines and final partial output', async () => {
  const bytes = Buffer.concat([Buffer.alloc(9000, 0xff), Buffer.from('\nHost key verification failed.\npartial')]);
  assert.deepEqual(await filtered([bytes.subarray(0, 5000), bytes.subarray(5000)]), bytes);
});
