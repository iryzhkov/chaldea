import test from 'node:test';
import assert from 'node:assert/strict';
import { probeHosts } from '../../src/exec/queue.ts';

test('all probes share one timeout window and retain preference despite completion order', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started: string[] = [];
  const probing = probeHosts(['off-a', 'off-b', 'preferred', 'last'], async host => {
    started.push(host);
    if (host.startsWith('off')) await new Promise((_, reject) =>
      setTimeout(() => reject(new Error('offline')), 10_000));
  });
  assert.deepEqual(started, ['off-a', 'off-b', 'preferred', 'last']);
  let done = false;
  void probing.then(() => { done = true; });
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  const results = await probing;
  assert.deepEqual(results.filter(r => !r.error).map(r => r.host), ['preferred', 'last']);
  assert.deepEqual(results.filter(r => r.error).map(r => r.host), ['off-a', 'off-b']);
});

test('out of order probe completion never reorders reachable hosts', async () => {
  let release!: () => void;
  const probing = probeHosts(['preferred', 'last'], host => host === 'preferred'
    ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
  release();
  assert.deepEqual((await probing).map(r => r.host), ['preferred', 'last']);
});
