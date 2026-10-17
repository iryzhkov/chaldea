import test from 'node:test';
import assert from 'node:assert/strict';
import { argumentsFor, hostsFor, isLocalHost, fallbackAllowed } from '../../src/exec/client.ts';

test('host is optional, but an explicit host and command must be valid', () => {
  assert.deepEqual(argumentsFor(['exec', '--gpu', '--artifact', 'out', '--', 'echo', '$HOME']),
    { host: undefined, gpu: true, artifacts: ['out'], argv: ['echo', '$HOME'], noQueue: false, queueTimeout: 3600 });
  for (const args of [
    ['exec', '--host'], ['exec', '--host', '', '--', 'true'],
    ['exec', '--host', '--', 'true'], ['exec', '--host', '-x', '--', 'true'],
    ['exec', '--'], ['exec', 'true'], ['exec', '--host', 'a', '--'],
  ]) assert.throws(() => argumentsFor(args));
});

test('queue defaults, duration units and bounds', () => {
  for (const [text, seconds] of [['250ms', .25], ['2s', 2], ['3m', 180], ['1h', 3600], ['12', 12]] as const) {
    assert.equal(argumentsFor(['exec', '--queue-timeout', text, '--', 'true']).queueTimeout, seconds);
  }
  assert.equal(argumentsFor(['exec', '--no-queue', '--', 'true']).noQueue, true);
  for (const text of ['', '0', '-1', 'NaN', 'Infinity', '25h', '5x']) {
    assert.throws(() => argumentsFor(['exec', '--queue-timeout', text, '--', 'true']));
  }
});

test('fleet order is preserved, duplicates removed, and self matches the short hostname only', () => {
  const hosts = hostsFor('# fleet\r\n agent-a \r\nagent-b\nomarchy-pc\nlaptop\nAGENT-A\n\n');
  assert.deepEqual(hosts, ['agent-a', 'agent-b', 'omarchy-pc', 'laptop']);
  assert.deepEqual(hosts.filter(h => !isLocalHost(h, 'omarchy-pc.example')), ['agent-a', 'agent-b', 'laptop']);
  assert.equal(isLocalHost('AGENT-A', 'agent-a.example'), true);
  assert.equal(isLocalHost('agent-a', 'agent-ab'), false);
  assert.deepEqual(hostsFor(' # empty\n'), []);
  for (const entry of ['-oProxyCommand=x', 'host.example', 'agent-a agent-b', '../host', 'agent-a # inline']) {
    assert.throws(() => hostsFor(entry));
  }
});

test('only definite non-execution permits fallback', () => {
  assert.equal(fallbackAllowed('connection-failed', false, false), true);
  assert.equal(fallbackAllowed('connection-failed', true, false), false);
  assert.equal(fallbackAllowed('refused', false, false), true);
  assert.equal(fallbackAllowed('refused', true, false), true); // server admission can refuse after Q
  assert.equal(fallbackAllowed('refused', true, true), false);
  for (const outcome of ['uncertain', 'preempted', 'finished'] as const) {
    for (const sent of [false, true]) assert.equal(fallbackAllowed(outcome, sent, false), false);
  }
  assert.equal(fallbackAllowed('refused', false, false, true), false);
  assert.equal(fallbackAllowed('connection-failed', false, false, true), false);
});
