import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mqtt from 'mqtt';

import { createCameraSourceManager } from './camera-source-manager.js';
import { createConfigStore } from './config-store.js';
import { createDeviceRuntime } from './device-runtime.js';
import { createHttpApp } from './http-app.js';
import { createLogger } from './logger.js';
import { createSessionStore } from './session-store.js';
import { createStorage } from './storage.js';

const require = createRequire(import.meta.url);
const { createBambuCloudClient } = require('../core/bambu-cloud.cjs');
const { scanBambuPrinters } = require('../core/lan-discovery.cjs');
const { buildMqttConnectionOptions } = require('../core/mqtt-options.cjs');
const { createMqttConnectionManager } = require('../core/mqtt-connection-manager.cjs');

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));
const SESSION_FILE = 'session.enc';
const SHUTDOWN_DEADLINE_MS = 10_000;
const RESTORE_TIMEOUT_MS = 15_000;
const signalInstallations = new WeakMap();

const defaultFactories = {
  createStorage,
  createConfigStore,
  createSessionStore,
  createLogger,
  createBambuCloudClient,
  createEventBus: () => new EventEmitter(),
  createMqttConnectionManager,
  buildMqttConnectionOptions,
  scanBambuPrinters,
  createDeviceRuntime,
  createCameraSourceManager,
  createHttpApp,
};

export function parseServerEnv(env = {}) {
  const rawPort = env.PORT ?? '3080';
  if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) throw new Error('Invalid PORT');
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

  const configuredDataDir = env.DATA_DIR;
  if (configuredDataDir !== undefined
    && (typeof configuredDataDir !== 'string' || configuredDataDir.trim().length === 0)) {
    throw new Error('Invalid DATA_DIR');
  }
  const trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
  return {
    port,
    dataDir: configuredDataDir ?? '/app/data',
    trustProxy,
    timezone: typeof env.TZ === 'string' && env.TZ.length > 0 ? env.TZ : undefined,
  };
}

function normalizeWriter(writer) {
  if (typeof writer === 'function') return { write: writer, close() {} };
  const stream = process.stdout;
  let closed = false;
  const onError = () => { closed = true; };
  stream.on('error', onError);
  return {
    write(line) {
      if (closed || stream.destroyed) return;
      try { stream.write(line, () => {}); } catch { closed = true; }
    },
    close() {
      stream.removeListener('error', onError);
    },
  };
}

function writeDiagnostic(writer, category) {
  try {
    writer.write(`${JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      component: 'server',
      event: category,
    })}\n`);
  } catch {
    // Startup diagnostics cannot make the degraded path fail.
  }
}

function scopedLogger(logger, component) {
  const scoped = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    scoped[level] = (entry = {}) => {
      const event = typeof entry?.operation === 'string' ? entry.operation : 'event';
      logger[level](component, event, entry);
    };
  }
  return scoped;
}

function isCorruptSession(error) {
  const message = error?.message;
  return typeof message === 'string' && (
    message === 'Invalid session store'
    || message === 'Unsupported session store version'
    || message === `Invalid encrypted envelope: ${SESSION_FILE}`
    || message === `Unable to authenticate encrypted file: ${SESSION_FILE}`
    || message === `Invalid encrypted payload: ${SESSION_FILE}`
  );
}

function unavailableError() {
  const error = new Error('Service unavailable');
  error.apiStatus = 503;
  error.apiCode = 'SERVICE_UNAVAILABLE';
  error.safeMessage = 'Service temporarily unavailable';
  return error;
}

function throwUnavailable() {
  throw unavailableError();
}

function unavailableDependencies() {
  return {
    cloud: {
      loginPassword: throwUnavailable,
      requestVerifyCode: throwUnavailable,
      loginCode: throwUnavailable,
      getCloudUsername: throwUnavailable,
    },
    sessionStore: {
      create: throwUnavailable,
      authenticate: throwUnavailable,
      clear: throwUnavailable,
      getBambuSession: () => null,
      getPrivateAccounts: () => [],
    },
    deviceRuntime: {
      start: throwUnavailable,
      stopSession: throwUnavailable,
      refresh: throwUnavailable,
      updateDevice: throwUnavailable,
      snapshot: throwUnavailable,
      getCameraConfig: throwUnavailable,
      subscribe: throwUnavailable,
      shutdown: async () => {},
    },
    cameraManager: {
      configure: throwUnavailable,
      acquire: throwUnavailable,
      getLatestFrame: throwUnavailable,
      subscribe: throwUnavailable,
      shutdown: async () => {},
    },
    configStore: {
      get: throwUnavailable,
      update: throwUnavailable,
    },
  };
}

function guardDegradedApis(app) {
  const { server } = app;
  if (typeof server?.listeners !== 'function' || typeof server?.removeListener !== 'function') return;

  const requestListeners = server.listeners('request');
  if (requestListeners.length > 0) {
    for (const listener of requestListeners) server.removeListener('request', listener);
    server.on('request', (req, res) => {
      const pathname = String(req.url || '').split('?', 1)[0];
      if (pathname.startsWith('/api/')) {
        req.resume?.();
        const payload = JSON.stringify({
          ok: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
        res.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          'Cache-Control': 'no-store',
          Connection: 'close',
        });
        res.end(payload);
        return;
      }
      for (const listener of requestListeners) listener.call(server, req, res);
    });
  }

  const upgradeListeners = server.listeners('upgrade');
  if (upgradeListeners.length > 0) {
    for (const listener of upgradeListeners) server.removeListener('upgrade', listener);
    server.on('upgrade', (req, socket, head) => {
      const pathname = String(req.url || '').split('?', 1)[0];
      if (pathname.startsWith('/api/')) {
        const payload = JSON.stringify({
          ok: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' },
        });
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\n'
          + 'Content-Type: application/json; charset=utf-8\r\n'
          + `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
        );
        return;
      }
      for (const listener of upgradeListeners) listener.call(server, req, socket, head);
    });
  }
}

function invokeLifecycle(target, method) {
  try {
    return Promise.resolve(target?.[method]?.());
  } catch (error) {
    return Promise.reject(error);
  }
}

function withDeadline(work, timers, timeoutResult, timeoutMs = SHUTDOWN_DEADLINE_MS) {
  let timeout;
  const deadline = new Promise((resolve) => {
    timeout = timers.setTimeout(() => resolve(timeoutResult()), timeoutMs);
  });
  return Promise.race([work, deadline])
    .finally(() => timers.clearTimeout(timeout));
}

async function shutdownInOrder(stages, failures, logger) {
  for (const [name, target, method] of stages) {
    try {
      await invokeLifecycle(target, method);
    } catch {
      failures.push(name);
      logger?.warn?.('server', 'shutdown-stage-failed', { stage: name });
    }
  }
  return { timedOut: false, failures: [...failures] };
}

function createController({
  app,
  components,
  readiness,
  timers,
  writer,
  restoredAccounts = [],
  restoreTimeoutMs = RESTORE_TIMEOUT_MS,
}) {
  let closingPromise = null;
  let closing = false;
  let restorationPromise = null;
  let restorationController = null;
  let removeSignals = () => {};

  const startRestoration = () => {
    if (restorationPromise) return restorationPromise;
    if (restoredAccounts.length === 0) {
      readiness.ready = !readiness.degraded;
      readiness.syncing = false;
      restorationPromise = Promise.resolve({ timedOut: false, aborted: false, skipped: true });
      return restorationPromise;
    }
    if (closing) {
      restorationPromise = Promise.resolve({ timedOut: false, aborted: true });
      return restorationPromise;
    }

    restorationController = new AbortController();
    const { signal } = restorationController;
    let timedOut = false;
    let timeout;
    let removeAbortListener = () => {};
    const aborted = new Promise((resolve) => {
      const onAbort = () => resolve({ timedOut, aborted: !timedOut });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const deadline = new Promise((resolve) => {
      timeout = timers.setTimeout(() => {
        timedOut = true;
        restorationController?.abort();
        resolve({ timedOut: true, aborted: false });
      }, restoreTimeoutMs);
    });

    let restoreWork;
    try {
      restoreWork = Promise.resolve(components.deviceRuntime.start({ accounts: restoredAccounts, signal }));
    } catch (error) {
      restoreWork = Promise.reject(error);
    }
    const observedWork = restoreWork.then(
      () => ({ timedOut: false, aborted: false }),
      () => ({ timedOut: false, aborted: false, failed: true }),
    );

    restorationPromise = Promise.race([observedWork, aborted, deadline])
      .then((result) => {
        if (!closing) {
          readiness.ready = true;
          readiness.syncing = false;
        }
        if (result.timedOut) components.logger?.warn?.('server', 'session-restore-timeout');
        else if (result.failed) components.logger?.warn?.('server', 'session-restore-unavailable');
        return result;
      })
      .finally(() => {
        removeAbortListener();
        timers.clearTimeout(timeout);
        restorationController = null;
      });
    return restorationPromise;
  };

  const controller = {
    app,
    server: app.server,
    components,
    readiness,
    startRestoration,
    get restoration() { return restorationPromise; },
    close() {
      if (closingPromise) return closingPromise;
      closing = true;
      readiness.ready = false;
      readiness.syncing = false;
      restorationController?.abort();
      const failures = [];
      const stages = [
        ['app', app, 'close'],
        ['camera', components.cameraManager, 'shutdown'],
        ['runtime', components.deviceRuntime, 'shutdown'],
      ];
      const orderedShutdown = shutdownInOrder(stages, failures, components.logger);
      closingPromise = withDeadline(orderedShutdown, timers, () => {
        components.logger?.warn?.('server', 'shutdown-deadline-exceeded');
        return { timedOut: true, failures: [...failures] };
      })
        .finally(() => {
          removeSignals();
          writer.close();
        });
      return closingPromise;
    },
  };
  controller.setSignalCleanup = (cleanup) => { removeSignals = cleanup; };
  return controller;
}

function createRuntimeLogger(logger, component) {
  return scopedLogger(logger, component);
}

export async function composeServer({
  env = process.env,
  factories: factoryOverrides = {},
  fetchImpl = globalThis.fetch,
  mqttConnect = mqtt.connect.bind(mqtt),
  writer: writerOption,
  now = Date.now,
  timers: timerOverrides = {},
  restoreTimeoutMs = RESTORE_TIMEOUT_MS,
} = {}) {
  const settings = parseServerEnv(env);
  if (!Number.isFinite(restoreTimeoutMs) || restoreTimeoutMs <= 0) {
    throw new TypeError('Invalid restore timeout');
  }
  const factories = { ...defaultFactories, ...factoryOverrides };
  const timers = {
    setTimeout: timerOverrides.setTimeout?.bind(timerOverrides) ?? setTimeout,
    clearTimeout: timerOverrides.clearTimeout?.bind(timerOverrides) ?? clearTimeout,
  };
  const writer = normalizeWriter(writerOption);
  const readiness = { ready: false, syncing: false, degraded: false, category: null };
  const components = {
    storage: null,
    configStore: null,
    sessionStore: null,
    cloud: null,
    mqtt: null,
    mqttEvents: null,
    deviceRuntime: null,
    cameraManager: null,
    logger: null,
  };
  let app = null;

  const buildLogger = () => {
    if (components.logger || !components.storage) return components.logger;
    const secret = components.storage.getSecretKey();
    let deviceSalt;
    try {
      deviceSalt = createHash('sha256').update('bambu-monitor-device-log-v1').update(secret).digest('hex');
    } finally {
      secret?.fill?.(0);
    }
    components.logger = factories.createLogger({
      write: writer.write,
      debug: components.configStore?.get?.()?.debug === true,
      deviceSalt,
      now,
    });
    return components.logger;
  };

  const buildDegraded = async (category) => {
    readiness.degraded = true;
    readiness.category = category;
    try { buildLogger(); } catch { /* A missing secret key is part of the degraded condition. */ }
    writeDiagnostic(writer, category);
    const unavailable = unavailableDependencies();
    Object.assign(components, unavailable);
    app = factories.createHttpApp({
      ...unavailable,
      logger: components.logger,
      trustProxy: settings.trustProxy,
      readiness: () => readiness,
      distDir: DIST_DIR,
    });
    guardDegradedApis(app);
    return createController({ app, components, readiness, timers, writer, restoreTimeoutMs });
  };

  try {
    try {
      components.storage = await factories.createStorage({ dataDir: settings.dataDir });
    } catch {
      return await buildDegraded('storage-unavailable');
    }

    try {
      components.configStore = await factories.createConfigStore({ storage: components.storage, now });
      buildLogger();
    } catch {
      return await buildDegraded('config-unavailable');
    }

    try {
      components.sessionStore = await factories.createSessionStore({ storage: components.storage, now });
    } catch (error) {
      if (!isCorruptSession(error)) return await buildDegraded('session-unavailable');
      const timestamp = now();
      await components.storage.backup(SESSION_FILE, `${SESSION_FILE}.corrupt-${timestamp}`);
      await components.storage.remove(SESSION_FILE);
      components.logger?.warn('server', 'session-corrupt');
      components.sessionStore = await factories.createSessionStore({ storage: components.storage, now });
    }

    components.cloud = factories.createBambuCloudClient({
      fetchImpl,
      logger: createRuntimeLogger(components.logger, 'bambu-cloud'),
    });
    components.mqttEvents = factories.createEventBus();
    components.mqtt = factories.createMqttConnectionManager({
      connectImpl: mqttConnect,
      buildConnectionOptions: factories.buildMqttConnectionOptions,
      emit: (event, payload) => components.mqttEvents.emit(event, payload),
      logger: createRuntimeLogger(components.logger, 'mqtt'),
    });
    components.deviceRuntime = factories.createDeviceRuntime({
      cloud: components.cloud,
      mqtt: components.mqtt,
      mqttEvents: components.mqttEvents,
      discovery: ({ signal }) => factories.scanBambuPrinters({
        signal,
        logger: createRuntimeLogger(components.logger, 'lan-discovery'),
      }),
      configStore: components.configStore,
      logger: createRuntimeLogger(components.logger, 'device-runtime'),
    });
    components.cameraManager = factories.createCameraSourceManager({ logger: components.logger });
    app = factories.createHttpApp({
      trustProxy: settings.trustProxy,
      readiness: () => readiness,
      configStore: components.configStore,
      sessionStore: components.sessionStore,
      cloud: components.cloud,
      deviceRuntime: components.deviceRuntime,
      cameraManager: components.cameraManager,
      logger: components.logger,
      distDir: DIST_DIR,
    });

    const restoredAccounts = components.sessionStore.getPrivateAccounts?.()
      ?.filter((account) => account && typeof account.accessToken === 'string' && account.accessToken.length > 0)
      ?? [];
    readiness.ready = restoredAccounts.length === 0;
    readiness.syncing = restoredAccounts.length > 0;
    return createController({
      app,
      components,
      readiness,
      timers,
      writer,
      restoredAccounts,
      restoreTimeoutMs,
    });
  } catch (error) {
    const pending = [];
    if (app) pending.push(invokeLifecycle(app, 'close'));
    if (components.cameraManager) pending.push(invokeLifecycle(components.cameraManager, 'shutdown'));
    if (components.deviceRuntime) pending.push(invokeLifecycle(components.deviceRuntime, 'shutdown'));
    else if (components.mqtt) pending.push(invokeLifecycle(components.mqtt, 'shutdown'));
    await withDeadline(Promise.allSettled(pending), timers, () => undefined);
    writer.close();
    throw error;
  }
}

export async function startServer({ listenPort, ...options } = {}) {
  const controller = await composeServer(options);
  const parsedPort = listenPort ?? parseServerEnv(options.env ?? process.env).port;
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    await controller.close();
    throw new Error('Invalid listen port');
  }
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        controller.server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        controller.server.removeListener('error', onError);
        resolve();
      };
      controller.server.once('error', onError);
      controller.server.once('listening', onListening);
      controller.app.listen(parsedPort, '0.0.0.0');
    });
    controller.startRestoration();
    return controller;
  } catch (error) {
    await controller.close();
    throw error;
  }
}

export function installShutdownSignals(controller, {
  processImpl = process,
  forceExit = (code) => processImpl.exit(code),
} = {}) {
  if (!controller || typeof controller.close !== 'function') throw new TypeError('Invalid server controller');
  if (typeof forceExit !== 'function') throw new TypeError('Invalid force exit function');
  const installed = signalInstallations.get(processImpl);
  if (installed) return installed.remove;

  let closing = false;
  let forced = false;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    processImpl.removeListener('SIGTERM', onSignal);
    processImpl.removeListener('SIGINT', onSignal);
    signalInstallations.delete(processImpl);
  };
  const forceOnce = () => {
    if (forced) return;
    forced = true;
    processImpl.exitCode = 1;
    remove();
    try { forceExit(1); } catch { /* The exit status remains available if forceExit returns or fails. */ }
  };
  const onSignal = () => {
    if (closing) {
      forceOnce();
      return;
    }
    closing = true;
    let closeResult;
    try {
      closeResult = controller.close();
    } catch {
      forceOnce();
      return;
    }
    Promise.resolve(closeResult).then(
      (result) => {
        if (forced) return;
        if (result?.timedOut === true) {
          forceOnce();
          return;
        }
        processImpl.exitCode = 0;
        remove();
      },
      () => forceOnce(),
    );
  };
  processImpl.on('SIGTERM', onSignal);
  processImpl.on('SIGINT', onSignal);
  signalInstallations.set(processImpl, { remove });
  controller.setSignalCleanup?.(remove);
  return remove;
}

async function main() {
  try {
    const controller = await startServer();
    installShutdownSignals(controller);
  } catch {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) void main();
