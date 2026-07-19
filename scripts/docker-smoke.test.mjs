import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  assertHttpStatus,
  assertSafeShutdownLogs,
  parseSha256,
  readConfig,
  runCommand,
  waitForHttpStatus,
} from './docker-smoke.mjs';

test('readConfig defaults to the NAS test image and a dedicated persistent smoke volume', () => {
  const config = readConfig({});

  assert.equal(config.image, 'bambu-monitor:nas-test');
  assert.equal(config.volume, 'bambu-monitor-smoke-data');
});

test('readConfig accepts explicit smoke image and named volume overrides', () => {
  const config = readConfig({
    DOCKER_SMOKE_IMAGE: 'registry.example/bambu-monitor:test',
    DOCKER_SMOKE_VOLUME: 'ci-bambu-data',
  });

  assert.equal(config.image, 'registry.example/bambu-monitor:test');
  assert.equal(config.volume, 'ci-bambu-data');
});

test('waitForHttpStatus retries transport and status failures until the endpoint is ready', async () => {
  const events = [new Error('refused'), 503, 200];
  const sleeps = [];

  const response = await waitForHttpStatus({
    url: 'http://127.0.0.1:3080/healthz',
    expectedStatus: 200,
    timeoutMs: 100,
    retryDelayMs: 5,
    now: (() => {
      let value = 0;
      return () => value += 10;
    })(),
    sleepImpl: async (delay) => sleeps.push(delay),
    fetchImpl: async () => {
      const event = events.shift();
      if (event instanceof Error) throw event;
      return { status: event };
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(sleeps, [5, 5]);
});

test('waitForHttpStatus reports the last observed failure after its deadline', async () => {
  await assert.rejects(
    waitForHttpStatus({
      url: 'http://127.0.0.1:3080/healthz',
      expectedStatus: 200,
      timeoutMs: 20,
      retryDelayMs: 1,
      now: (() => {
        let value = 0;
        return () => value += 10;
      })(),
      sleepImpl: async () => {},
      fetchImpl: async () => ({ status: 503 }),
    }),
    /healthz.*expected 200.*last status 503/i,
  );
});

test('waitForHttpStatus clips its final retry delay to the remaining deadline', async () => {
  const sleeps = [];
  const times = [0, 0, 1];

  await assert.rejects(
    waitForHttpStatus({
      url: 'http://127.0.0.1:3080/healthz',
      expectedStatus: 200,
      timeoutMs: 3,
      retryDelayMs: 10,
      now: () => times.shift() ?? 3,
      sleepImpl: async (delay) => sleeps.push(delay),
      fetchImpl: async () => ({ status: 503 }),
    }),
    /within 3ms/i,
  );

  assert.deepEqual(sleeps, [2]);
});

test('assertHttpStatus rejects an unexpected anonymous endpoint status', async () => {
  await assert.rejects(
    assertHttpStatus({
      url: 'http://127.0.0.1:3080/api/devices',
      expectedStatus: 401,
      fetchImpl: async () => ({ status: 200 }),
    }),
    /api\/devices.*expected 401.*received 200/i,
  );
});

test('parseSha256 returns a normalized digest and rejects malformed output', () => {
  const digest = 'A'.repeat(64);
  assert.equal(parseSha256(`${digest}  /app/data/secret.key\n`), digest.toLowerCase());
  assert.throws(() => parseSha256('not-a-sha /app/data/secret.key'), /sha256sum output/i);
});

test('assertSafeShutdownLogs rejects shutdown deadline and unhandled rejection markers', () => {
  assert.doesNotThrow(() => assertSafeShutdownLogs('{"event":"server-stopped"}\n'));
  assert.throws(() => assertSafeShutdownLogs('shutdown-deadline-exceeded'), /shutdown-deadline-exceeded/i);
  assert.throws(() => assertSafeShutdownLogs('UnhandledPromiseRejection: boom'), /unhandled rejection/i);
  assert.throws(() => assertSafeShutdownLogs('unhandled rejection at promise'), /unhandled rejection/i);
});

test('runCommand uses argument arrays and includes stderr when a command fails', async () => {
  const output = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'safe value']);
  assert.equal(output.stdout, 'safe value');

  await assert.rejects(
    runCommand(process.execPath, ['-e', 'process.stderr.write("command exploded"); process.exit(7)']),
    (error) => error.message.includes('command exploded') && error.message.includes('exit code 7'),
  );
});

test('runCommand rejects spawn errors with command context', async () => {
  const spawnImpl = () => {
    const child = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    return child;
  };

  await assert.rejects(
    runCommand('missing-docker', ['version'], { spawnImpl }),
    /missing-docker version.*ENOENT/i,
  );
});
