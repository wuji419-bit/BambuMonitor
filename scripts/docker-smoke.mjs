import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONTAINER = 'bambu-monitor-smoke';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const DEFAULT_IMAGE = 'bambu-monitor:nas-test';
const DEFAULT_VOLUME = 'bambu-monitor-smoke-data';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 60_000;
const LOG_EXIT_TIMEOUT_MS = 15_000;

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function commandLabel(command, args) {
  return [command, ...args].join(' ');
}

export function runCommand(command, args, {
  spawnImpl = nodeSpawn,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  timers: timerOverrides = {},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError('Command timeout must be a positive finite number'));
  }

  return new Promise((resolve, reject) => {
    let child;
    let timeout;
    let settled = false;
    const timers = {
      setTimeout: timerOverrides.setTimeout?.bind(timerOverrides) ?? setTimeout,
      clearTimeout: timerOverrides.clearTimeout?.bind(timerOverrides) ?? clearTimeout,
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };

    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
      return;
    }

    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      finish(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      };
      if (code === 0) {
        finish(null, result);
        return;
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? 'unknown'}`;
      const error = new Error(`${commandLabel(command, args)} failed with exit code ${code ?? 'unknown'}: ${detail}`);
      error.exitCode = code;
      error.signal = signal;
      finish(error);
    });

    timeout = timers.setTimeout(() => {
      const error = new Error(`${commandLabel(command, args)} timed out after ${timeoutMs}ms`);
      error.code = 'COMMAND_TIMEOUT';
      error.timeoutMs = timeoutMs;
      finish(error);
      try {
        child.kill();
      } catch (killError) {
        error.killError = killError;
      }
    }, timeoutMs);
  });
}

export function startCommandCapture(command, args, { spawnImpl = nodeSpawn } = {}) {
  const child = spawnImpl(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

  const completion = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    child.once('error', (error) => {
      finish(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) finish(null, result);
      else finish(new Error(`${commandLabel(command, args)} failed with exit code ${code ?? 'unknown'} (signal ${signal ?? 'none'}): ${result.stderr.trim()}`));
    });
  });
  completion.catch(() => {});
  return { child, completion };
}

export async function assertHttpStatus({ url, expectedStatus, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(`${url} request failed: ${error.message}`, { cause: error });
  }
  if (response.status !== expectedStatus) {
    throw new Error(`${url} expected ${expectedStatus}, received ${response.status}`);
  }
  return response;
}

export async function waitForHttpStatus({
  url,
  expectedStatus,
  timeoutMs = HEALTH_TIMEOUT_MS,
  retryDelayMs = 1000,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
}) {
  const startedAt = now();
  let lastFailure = 'no response';

  for (;;) {
    const remaining = Math.max(1, timeoutMs - (now() - startedAt));
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
      });
      if (response.status === expectedStatus) return response;
      lastFailure = `last status ${response.status}`;
    } catch (error) {
      lastFailure = `last error ${error.message}`;
    }

    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new Error(`${url} did not reach expected ${expectedStatus} within ${timeoutMs}ms (${lastFailure})`);
    }
    await sleepImpl(Math.min(retryDelayMs, timeoutMs - elapsed));
  }
}

export function parseSha256(output) {
  const match = /^([a-fA-F0-9]{64})\s+\S+\s*$/.exec(output);
  if (!match) throw new Error(`Invalid sha256sum output: ${JSON.stringify(output)}`);
  return match[1].toLowerCase();
}

export function assertSafeShutdownLogs(logs) {
  if (/shutdown-deadline-exceeded/i.test(logs)) {
    throw new Error('Container logs contain shutdown-deadline-exceeded');
  }
  if (/unhandled(?:\s+rejection|promiserejection)/i.test(logs)) {
    throw new Error('Container logs contain an unhandled rejection');
  }
}

function withTimeout(promise, timeoutMs, message, onTimeout) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    Promise.resolve(promise).then(
      (value) => finish(null, value),
      (error) => finish(error),
    );
    timer = setTimeout(() => {
      const error = new Error(message);
      finish(error);
      try {
        onTimeout?.();
      } catch (timeoutError) {
        error.killError = timeoutError;
      }
    }, timeoutMs);
  });
}

export function readConfig(env) {
  const container = env.DOCKER_SMOKE_CONTAINER || env.CONTAINER_NAME || DEFAULT_CONTAINER;
  const baseURL = (env.DOCKER_SMOKE_BASE_URL || env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const image = env.DOCKER_SMOKE_IMAGE || env.IMAGE || DEFAULT_IMAGE;
  const volume = env.DOCKER_SMOKE_VOLUME || env.VOLUME_NAME || DEFAULT_VOLUME;
  const docker = env.DOCKER || 'docker';
  const rawCommandTimeout = env.DOCKER_SMOKE_COMMAND_TIMEOUT_MS ?? String(DEFAULT_COMMAND_TIMEOUT_MS);
  let parsedURL;
  try {
    parsedURL = new URL(baseURL);
  } catch (error) {
    throw new Error(`Invalid smoke base URL: ${baseURL}`, { cause: error });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error(`Invalid container name: ${container}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume)) throw new Error(`Invalid volume name: ${volume}`);
  if (!image.trim()) throw new Error('Docker smoke image must not be empty');
  if (typeof rawCommandTimeout !== 'string' || !/^\d+$/.test(rawCommandTimeout)) {
    throw new Error('Invalid Docker command timeout');
  }
  const commandTimeoutMs = Number(rawCommandTimeout);
  if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 300_000) {
    throw new Error('Invalid Docker command timeout');
  }
  const port = parsedURL.port || (parsedURL.protocol === 'https:' ? '443' : '80');
  return { baseURL, commandTimeoutMs, container, docker, image, port, volume };
}

function runDocker(config, args, commandRunner) {
  return commandRunner(config.docker, args, { timeoutMs: config.commandTimeoutMs });
}

async function ensureContainerNameIsFree(config, commandRunner) {
  try {
    await runDocker(config, ['container', 'inspect', config.container], commandRunner);
  } catch (error) {
    if (error.exitCode === 1) return;
    throw new Error(`Unable to verify container name ${config.container}: ${error.message}`, { cause: error });
  }
  throw new Error(`Refusing to use existing container ${config.container}`);
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function attachCleanupError(primaryError, cleanupError) {
  if (!Object.hasOwn(primaryError, 'cleanupErrors')) {
    Object.defineProperty(primaryError, 'cleanupErrors', {
      configurable: true,
      enumerable: true,
      value: [],
      writable: false,
    });
  }
  primaryError.cleanupErrors.push(normalizeError(cleanupError));
}

export async function runSmoke({
  env = process.env,
  commandRunner = runCommand,
  logCaptureFactory = startCommandCapture,
  waitForStatus = waitForHttpStatus,
  assertStatus = assertHttpStatus,
  output = process.stdout,
} = {}) {
  const config = readConfig(env);
  let started = false;
  let stopped = false;
  let stopAttempted = false;
  let logCaptureAttempted = false;
  let logCapture;
  let capturedLogs = '';
  let primaryError;
  const recordFailure = (error) => {
    const normalized = normalizeError(error);
    if (!primaryError) primaryError = normalized;
    else if (primaryError !== normalized) attachCleanupError(primaryError, normalized);
  };
  const startLogs = () => {
    if (logCaptureAttempted) return;
    logCaptureAttempted = true;
    logCapture = logCaptureFactory(config.docker, ['logs', '--follow', config.container]);
  };

  try {
    await runDocker(config, ['version'], commandRunner);
    await ensureContainerNameIsFree(config, commandRunner);
    await runDocker(config, [
      'run', '--rm', '--detach',
      '--name', config.container,
      '--network', 'host',
      '--env', `PORT=${config.port}`,
      '--env', 'DATA_DIR=/app/data',
      '--volume', `${config.volume}:/app/data`,
      config.image,
    ], commandRunner);
    started = true;
    await waitForStatus({ url: `${config.baseURL}/healthz`, expectedStatus: 200 });
    await assertStatus({ url: `${config.baseURL}/readyz`, expectedStatus: 200 });
    await assertStatus({ url: `${config.baseURL}/api/devices`, expectedStatus: 401 });
    await assertStatus({ url: `${config.baseURL}/api/cameras/test/frame`, expectedStatus: 401 });

    const firstKey = parseSha256((await runDocker(config, [
      'exec', config.container, 'sha256sum', '/app/data/secret.key',
    ], commandRunner)).stdout);

    await runDocker(config, ['restart', config.container], commandRunner);
    await waitForStatus({ url: `${config.baseURL}/healthz`, expectedStatus: 200 });
    const secondKey = parseSha256((await runDocker(config, [
      'exec', config.container, 'sha256sum', '/app/data/secret.key',
    ], commandRunner)).stdout);
    if (firstKey !== secondKey) throw new Error('secret.key hash changed after container restart');

    const initProcess = (await runDocker(config, [
      'exec', config.container, 'cat', '/proc/1/comm',
    ], commandRunner)).stdout.trim();
    if (initProcess !== 'tini') throw new Error(`Expected /proc/1/comm to be tini, received ${JSON.stringify(initProcess)}`);

    startLogs();
    stopAttempted = true;
    await runDocker(config, ['stop', '--time', '10', config.container], commandRunner);
    stopped = true;
  } catch (error) {
    recordFailure(error);
  } finally {
    if (started && !stopped) {
      if (!logCaptureAttempted) {
        try {
          startLogs();
        } catch (error) {
          recordFailure(error);
        }
      }
      if (!stopAttempted) {
        stopAttempted = true;
        try {
          await runDocker(config, ['stop', '--time', '10', config.container], commandRunner);
          stopped = true;
        } catch (error) {
          recordFailure(error);
        }
      }
    }
    if (started && !stopped) {
      try {
        await runDocker(config, ['rm', '--force', config.container], commandRunner);
        stopped = true;
      } catch (error) {
        recordFailure(error);
      }
    }
    if (logCapture) {
      try {
        const result = await withTimeout(
          logCapture.completion,
          LOG_EXIT_TIMEOUT_MS,
          'Timed out waiting for docker logs --follow to exit',
          () => logCapture.child.kill(),
        );
        capturedLogs = `${result.stdout}\n${result.stderr}`;
      } catch (error) {
        recordFailure(error);
      }
    }
    try {
      assertSafeShutdownLogs(capturedLogs);
    } catch (error) {
      recordFailure(error);
    }
  }

  if (primaryError) throw primaryError;
  output.write(`Docker smoke passed for ${config.image} using ${config.container}\n`);
}

export async function main(options = {}) {
  return runSmoke(options);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    const cleanupDetails = error.cleanupErrors?.map((cleanupError) => cleanupError.stack || cleanupError.message) ?? [];
    const suffix = cleanupDetails.length > 0 ? `\nCleanup failures:\n${cleanupDetails.join('\n')}` : '';
    process.stderr.write(`Docker smoke failed: ${error.stack || error.message}${suffix}\n`);
    process.exitCode = 1;
  });
}
