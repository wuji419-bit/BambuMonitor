import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_CONTAINER = 'bambu-monitor-smoke';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3080';
const DEFAULT_IMAGE = 'bambu-monitor:nas-test';
const DEFAULT_VOLUME = 'bambu-monitor-smoke-data';
const HEALTH_TIMEOUT_MS = 60_000;
const LOG_EXIT_TIMEOUT_MS = 15_000;

const sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay));

function commandLabel(command, args) {
  return [command, ...args].join(' ');
}

export function runCommand(command, args, { spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
      return;
    }

    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      reject(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `signal ${signal ?? 'unknown'}`;
      const error = new Error(`${commandLabel(command, args)} failed with exit code ${code ?? 'unknown'}: ${detail}`);
      error.exitCode = code;
      error.signal = signal;
      reject(error);
    });
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
    child.once('error', (error) => {
      reject(new Error(`Failed to start ${commandLabel(command, args)}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${commandLabel(command, args)} failed with exit code ${code ?? 'unknown'} (signal ${signal ?? 'none'}): ${result.stderr.trim()}`));
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
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function readConfig(env) {
  const container = env.DOCKER_SMOKE_CONTAINER || env.CONTAINER_NAME || DEFAULT_CONTAINER;
  const baseURL = (env.DOCKER_SMOKE_BASE_URL || env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const image = env.DOCKER_SMOKE_IMAGE || env.IMAGE || DEFAULT_IMAGE;
  const volume = env.DOCKER_SMOKE_VOLUME || env.VOLUME_NAME || DEFAULT_VOLUME;
  const docker = env.DOCKER || 'docker';
  let parsedURL;
  try {
    parsedURL = new URL(baseURL);
  } catch (error) {
    throw new Error(`Invalid smoke base URL: ${baseURL}`, { cause: error });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error(`Invalid container name: ${container}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volume)) throw new Error(`Invalid volume name: ${volume}`);
  if (!image.trim()) throw new Error('Docker smoke image must not be empty');
  const port = parsedURL.port || (parsedURL.protocol === 'https:' ? '443' : '80');
  return { baseURL, container, docker, image, port, volume };
}

async function ensureContainerNameIsFree(config) {
  try {
    await runCommand(config.docker, ['container', 'inspect', config.container]);
  } catch (error) {
    if (error.exitCode === 1) return;
    throw new Error(`Unable to verify container name ${config.container}: ${error.message}`, { cause: error });
  }
  throw new Error(`Refusing to use existing container ${config.container}`);
}

export async function main({ env = process.env } = {}) {
  const config = readConfig(env);
  let started = false;
  let stopped = false;
  let logCapture;
  let capturedLogs = '';
  let primaryError;

  try {
    await runCommand(config.docker, ['version']);
    await ensureContainerNameIsFree(config);
    await runCommand(config.docker, [
      'run', '--rm', '--detach',
      '--name', config.container,
      '--network', 'host',
      '--env', `PORT=${config.port}`,
      '--env', 'DATA_DIR=/app/data',
      '--volume', `${config.volume}:/app/data`,
      config.image,
    ]);
    started = true;
    await waitForHttpStatus({ url: `${config.baseURL}/healthz`, expectedStatus: 200 });
    await assertHttpStatus({ url: `${config.baseURL}/readyz`, expectedStatus: 200 });
    await assertHttpStatus({ url: `${config.baseURL}/api/devices`, expectedStatus: 401 });
    await assertHttpStatus({ url: `${config.baseURL}/api/cameras/test/frame`, expectedStatus: 401 });

    const firstKey = parseSha256((await runCommand(config.docker, [
      'exec', config.container, 'sha256sum', '/app/data/secret.key',
    ])).stdout);

    await runCommand(config.docker, ['restart', config.container]);
    await waitForHttpStatus({ url: `${config.baseURL}/healthz`, expectedStatus: 200 });
    const secondKey = parseSha256((await runCommand(config.docker, [
      'exec', config.container, 'sha256sum', '/app/data/secret.key',
    ])).stdout);
    if (firstKey !== secondKey) throw new Error('secret.key hash changed after container restart');

    const initProcess = (await runCommand(config.docker, [
      'exec', config.container, 'cat', '/proc/1/comm',
    ])).stdout.trim();
    if (initProcess !== 'tini') throw new Error(`Expected /proc/1/comm to be tini, received ${JSON.stringify(initProcess)}`);

    logCapture = startCommandCapture(config.docker, ['logs', '--follow', config.container]);
    await runCommand(config.docker, ['stop', '--time', '10', config.container]);
    stopped = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (started && !logCapture) {
      logCapture = startCommandCapture(config.docker, ['logs', '--follow', config.container]);
    }
    if (started && !stopped) {
      try {
        await runCommand(config.docker, ['stop', '--time', '10', config.container]);
        stopped = true;
      } catch (error) {
        primaryError ??= error;
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
        primaryError ??= error;
      }
    }
    try {
      assertSafeShutdownLogs(capturedLogs);
    } catch (error) {
      primaryError ??= error;
    }
  }

  if (primaryError) throw primaryError;
  process.stdout.write(`Docker smoke passed for ${config.image} using ${config.container}\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Docker smoke failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
