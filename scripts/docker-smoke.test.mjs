import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  assertHttpStatus,
  assertSafeShutdownLogs,
  parseSha256,
  readConfig,
  runCommand,
  runSmoke,
  waitForHttpStatus,
} from './docker-smoke.mjs';

const DIGEST = 'a'.repeat(64);

function createChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

function missingContainerError() {
  const error = new Error('No such container');
  error.exitCode = 1;
  return error;
}

function successfulResult(args) {
  if (args.includes('sha256sum')) return { stdout: `${DIGEST}  /app/data/secret.key\n`, stderr: '' };
  if (args.includes('/proc/1/comm')) return { stdout: 'tini\n', stderr: '' };
  return { stdout: '', stderr: '' };
}

function createLogCapture(events) {
  return () => {
    events.push({ type: 'logs-follow' });
    return {
      child: { kill() {} },
      completion: Promise.resolve({ stdout: '{"event":"server-stopped"}\n', stderr: '' }),
    };
  };
}

test('readConfig defaults to the NAS test image and a dedicated persistent smoke volume', () => {
  const config = readConfig({});

  assert.equal(config.image, 'bambu-monitor:nas-test');
  assert.equal(config.volume, 'bambu-monitor-smoke-data');
  assert.equal(config.commandTimeoutMs, 30_000);
});

test('readConfig accepts explicit smoke image and named volume overrides', () => {
  const config = readConfig({
    DOCKER_SMOKE_IMAGE: 'registry.example/bambu-monitor:test',
    DOCKER_SMOKE_VOLUME: 'ci-bambu-data',
    DOCKER_SMOKE_COMMAND_TIMEOUT_MS: '4567',
  });

  assert.equal(config.image, 'registry.example/bambu-monitor:test');
  assert.equal(config.volume, 'ci-bambu-data');
  assert.equal(config.commandTimeoutMs, 4567);
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

test('runCommand kills a child that never closes and rejects once with a clear timeout', async () => {
  const child = createChild();
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 250));

  await assert.rejects(
    Promise.race([
      runCommand('docker', ['version'], { spawnImpl: () => child, timeoutMs: 10 }),
      guard,
    ]),
    /docker version timed out after 10ms/i,
  );
  assert.equal(child.killCalls, 1);
  assert.doesNotThrow(() => {
    child.emit('error', new Error('late error'));
    child.emit('close', 137, 'SIGKILL');
  });
});

test('runCommand clears its hard timeout when the child closes first', async () => {
  const child = createChild();
  const scheduled = [];
  const cleared = [];
  const timers = {
    setTimeout(callback, delay) {
      const handle = { callback, delay };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) { cleared.push(handle); },
  };

  const pending = runCommand('docker', ['version'], {
    spawnImpl: () => child,
    timeoutMs: 99,
    timers,
  });
  child.emit('close', 0, null);

  await pending;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 99);
  assert.deepEqual(cleared, scheduled);
});

test('runCommand schedules a 30 second hard timeout by default', async () => {
  const child = createChild();
  const scheduled = [];
  const cleared = [];
  const timers = {
    setTimeout(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.at(-1);
    },
    clearTimeout(handle) { cleared.push(handle); },
  };

  const pending = runCommand('docker', ['version'], { spawnImpl: () => child, timers });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30_000);
  scheduled[0].callback();
  await assert.rejects(pending, /timed out after 30000ms/i);
  assert.deepEqual(cleared, [scheduled[0]]);
});

test('runSmoke executes logs-follow before graceful stop and never force-removes on success', async () => {
  const events = [];
  const commandRunner = async (command, args, options) => {
    events.push({ type: 'command', command, args, options });
    if (args[0] === 'container' && args[1] === 'inspect') throw missingContainerError();
    return successfulResult(args);
  };

  await runSmoke({
    commandRunner,
    logCaptureFactory: createLogCapture(events),
    waitForStatus: async (options) => events.push({ type: 'wait', options }),
    assertStatus: async (options) => events.push({ type: 'assert', options }),
    output: { write() {} },
  });

  const logsAt = events.findIndex((event) => event.type === 'logs-follow');
  const stopAt = events.findIndex((event) => event.args?.[0] === 'stop');
  assert.ok(logsAt >= 0 && logsAt < stopAt);
  assert.equal(events.some((event) => event.args?.[0] === 'rm'), false);
  assert.ok(events.every((event) => event.type !== 'command' || event.options.timeoutMs === 30_000));
  const run = events.find((event) => event.args?.[0] === 'run');
  assert.deepEqual(run.args.slice(run.args.indexOf('--volume'), run.args.indexOf('--volume') + 2), [
    '--volume', 'bambu-monitor-smoke-data:/app/data',
  ]);
});

test('runSmoke force-removes only its started container when graceful stop fails', async () => {
  const events = [];
  const stopError = new Error('docker stop timed out');
  const commandRunner = async (command, args, options) => {
    events.push({ type: 'command', command, args, options });
    if (args[0] === 'container' && args[1] === 'inspect') throw missingContainerError();
    if (args[0] === 'stop') throw stopError;
    return successfulResult(args);
  };

  await assert.rejects(
    runSmoke({
      commandRunner,
      logCaptureFactory: createLogCapture(events),
      waitForStatus: async () => {},
      assertStatus: async () => {},
      output: { write() {} },
    }),
    (error) => error === stopError,
  );

  assert.ok(events.some((event) => event.args?.[0] === 'rm'
    && event.args?.[1] === '--force'
    && event.args?.[2] === 'bambu-monitor-smoke'
    && event.options.timeoutMs === 30_000));
  assert.equal(events.filter((event) => event.args?.[0] === 'stop').length, 1);
  assert.equal(events.some((event) => event.args?.[0] === 'volume'), false);
});

test('runSmoke never stops or removes a container when startup fails before docker run succeeds', async () => {
  const events = [];
  const startupError = new Error('docker daemon unavailable');

  await assert.rejects(
    runSmoke({
      commandRunner: async (command, args) => {
        events.push({ type: 'command', command, args });
        throw startupError;
      },
      logCaptureFactory: createLogCapture(events),
      waitForStatus: async () => {},
      assertStatus: async () => {},
      output: { write() {} },
    }),
    (error) => error === startupError,
  );

  assert.equal(events.some((event) => ['stop', 'rm'].includes(event.args?.[0])), false);
  assert.equal(events.some((event) => event.type === 'logs-follow'), false);
});

test('runSmoke refuses a pre-existing container before run and never cleans it up', async () => {
  const events = [];

  await assert.rejects(
    runSmoke({
      commandRunner: async (command, args) => {
        events.push({ type: 'command', command, args });
        return successfulResult(args);
      },
      logCaptureFactory: createLogCapture(events),
      waitForStatus: async () => {},
      assertStatus: async () => {},
      output: { write() {} },
    }),
    /Refusing to use existing container bambu-monitor-smoke/,
  );

  assert.equal(events.some((event) => ['run', 'stop', 'rm'].includes(event.args?.[0])), false);
  assert.equal(events.some((event) => event.type === 'logs-follow'), false);
});

test('runSmoke preserves the primary failure and attaches bounded cleanup failures', async () => {
  const events = [];
  const primaryError = new Error('ready check failed');
  const stopError = new Error('stop failed');
  const removeError = new Error('remove failed');
  const commandRunner = async (command, args) => {
    events.push({ type: 'command', command, args });
    if (args[0] === 'container' && args[1] === 'inspect') throw missingContainerError();
    if (args[0] === 'stop') throw stopError;
    if (args[0] === 'rm') throw removeError;
    return successfulResult(args);
  };

  await assert.rejects(
    runSmoke({
      commandRunner,
      logCaptureFactory: createLogCapture(events),
      waitForStatus: async () => {},
      assertStatus: async () => { throw primaryError; },
      output: { write() {} },
    }),
    (error) => error === primaryError
      && error.cleanupErrors?.[0] === stopError
      && error.cleanupErrors?.[1] === removeError,
  );
  const logsAt = events.findIndex((event) => event.type === 'logs-follow');
  const stopAt = events.findIndex((event) => event.args?.[0] === 'stop');
  assert.ok(logsAt >= 0 && logsAt < stopAt);
  assert.equal(events.some((event) => event.args?.[0] === 'volume'), false);
});

test('runSmoke returns from a command timeout instead of hanging', async () => {
  const child = createChild();
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 250));

  await assert.rejects(
    Promise.race([
      runSmoke({
        env: { DOCKER_SMOKE_COMMAND_TIMEOUT_MS: '10' },
        commandRunner: (command, args, options) => runCommand(command, args, {
          ...options,
          spawnImpl: () => child,
        }),
        logCaptureFactory: () => { throw new Error('logs must not start'); },
        waitForStatus: async () => {},
        assertStatus: async () => {},
        output: { write() {} },
      }),
      guard,
    ]),
    /docker version timed out after 10ms/i,
  );
  assert.equal(child.killCalls, 1);
});
