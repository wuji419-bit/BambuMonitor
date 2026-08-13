import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createHttpApp } from './http-app.js';

import {
  composeServer,
  installShutdownSignals,
  parseServerEnv,
  startServer,
} from './index.js';

const VALID_ENV = { PORT: '3080', DATA_DIR: '/safe/data', TRUST_PROXY: 'false', TZ: 'UTC' };

function fakeComponents(overrides = {}) {
  const order = [];
  const calls = { backup: [], remove: [], restore: [], mqttOptions: null, runtimeOptions: null, httpOptions: null };
  const storage = {
    getSecretKey: () => Buffer.alloc(32, 7),
    backup: async (...args) => { calls.backup.push(args); },
    remove: async (...args) => { calls.remove.push(args); },
  };
  const configStore = {
    get: () => ({ debug: false }),
    update: async () => ({}),
    getDeviceCache: () => ({ version: 1, devices: {} }),
    updateDevice: async () => ({}),
  };
  const sessionStore = {
    create: async () => ({}), authenticate: async () => null, clear: async () => {},
    getBambuSession: () => ({ accessToken: 'restored-token', username: 'restored-user' }),
    getPrivateAccounts: () => [
      { accountId: 'first', account: 'first@example.com', accountMasked: 'f***@example.com', remark: 'Office', accessToken: 'restored-token', username: 'restored-user', savedAt: 1, updatedAt: 1 },
      { accountId: 'second', account: 'second@example.com', accountMasked: 's***@example.com', remark: 'Studio', accessToken: 'second-token', username: 'second-user', savedAt: 1, updatedAt: 1 },
    ],
  };
  const cloud = { loginPassword: async () => ({}), requestVerifyCode: async () => ({}), loginCode: async () => ({}) };
  const mqttManager = { connect: async () => {}, disconnect: async () => {}, shutdown: async () => {} };
  const deviceRuntime = {
    start: async (value) => { calls.restore.push(value); }, stopSession: async () => {}, refresh: async () => {},
    updateDevice: async () => {}, snapshot: () => ({}), getCameraConfig: () => null,
    subscribe: () => () => {}, shutdown: async () => { order.push('runtime.shutdown'); },
  };
  const cameraManager = {
    configure: () => {}, acquire: () => () => {}, getLatestFrame: () => null, subscribe: () => () => {},
    shutdown: async () => { order.push('camera.shutdown'); },
  };
  const app = {
    server: new EventEmitter(),
    close: async () => { order.push('app.close'); },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const factories = {
    async createStorage(options) { order.push('storage'); calls.storageOptions = options; return storage; },
    async createConfigStore(options) { order.push('config'); calls.configOptions = options; return configStore; },
    createLogger(options) { order.push('logger'); calls.loggerOptions = options; return logger; },
    async createSessionStore(options) { order.push('session'); calls.sessionOptions = options; return sessionStore; },
    createBambuCloudClient(options) { order.push('cloud'); calls.cloudOptions = options; return cloud; },
    createEventBus() { order.push('eventBus'); return new EventEmitter(); },
    createMqttConnectionManager(options) { order.push('mqtt'); calls.mqttOptions = options; return mqttManager; },
    buildMqttConnectionOptions() {},
    scanBambuPrinters: async () => [],
    createDeviceRuntime(options) { order.push('runtime'); calls.runtimeOptions = options; return deviceRuntime; },
    createCameraSourceManager(options) { order.push('camera'); calls.cameraOptions = options; return cameraManager; },
    createHttpApp(options) { order.push('http'); calls.httpOptions = options; return app; },
    ...overrides,
  };
  return { order, calls, factories, storage, configStore, sessionStore, cloud, mqttManager, deviceRuntime, cameraManager, app };
}

function request(server, { path = '/', method = 'GET', headers = {}, body } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: address.port, path, method, headers: { Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('parseServerEnv applies production defaults and explicit trust proxy semantics', () => {
  assert.deepEqual(parseServerEnv({}), { port: 3080, dataDir: '/app/data', trustProxy: false, timezone: undefined });
  assert.equal(parseServerEnv({ PORT: '65535', DATA_DIR: '/volume/data', TRUST_PROXY: '1', TZ: 'Asia/Shanghai' }).trustProxy, true);
  assert.equal(parseServerEnv({ TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(parseServerEnv({ TRUST_PROXY: 'yes' }).trustProxy, false);
});

test('parseServerEnv rejects invalid ports and empty configured data directories', () => {
  for (const PORT of ['0', '65536', '3.5', 'abc', ' 3080']) assert.throws(() => parseServerEnv({ PORT }), /PORT/);
  for (const DATA_DIR of ['', '   ']) assert.throws(() => parseServerEnv({ DATA_DIR }), /DATA_DIR/);
});

test('composeServer creates one production component in dependency order and owns deferred restoration', async () => {
  const harness = fakeComponents();
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {}, now: () => 1234 });

  assert.deepEqual(harness.order, ['storage', 'config', 'logger', 'session', 'cloud', 'eventBus', 'mqtt', 'runtime', 'camera', 'http']);
  assert.deepEqual(harness.calls.restore, []);
  assert.equal(controller.readiness.ready, false);
  assert.equal(controller.readiness.syncing, true);
  assert.equal(controller.components.deviceRuntime, harness.deviceRuntime);
  assert.equal(harness.calls.httpOptions.trustProxy, false);
  assert.equal(harness.calls.httpOptions.distDir.endsWith('dist'), true);
  assert.equal(harness.calls.httpOptions.readiness().ready, false);
  assert.notDeepEqual(harness.calls.loggerOptions.deviceSalt, Buffer.alloc(32, 7));
  assert.equal(
    typeof harness.calls.loggerOptions.deviceSalt === 'string'
      ? /^([0-9a-f]{64})$/.test(harness.calls.loggerOptions.deviceSalt)
      : harness.calls.loggerOptions.deviceSalt.some((byte) => byte !== 0),
    true,
  );
  await controller.startRestoration();
  assert.equal(harness.calls.restore.length, 1);
  assert.deepEqual(harness.calls.restore[0].accounts.map((account) => account.accountId), ['first', 'second']);
  assert.equal(harness.calls.restore[0].accessToken, undefined);
  assert.equal(harness.calls.restore[0].username, undefined);
  assert.ok(harness.calls.restore[0].signal instanceof AbortSignal);
  assert.equal(controller.readiness.ready, true);
  assert.equal(controller.readiness.syncing, false);
  await controller.close();
});

test('restoration does not log private account fields', async () => {
  const writes = [];
  const harness = fakeComponents();
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: (line) => writes.push(line) });
  await controller.startRestoration();
  const diagnostics = writes.join('');
  assert.equal(diagnostics.includes('restored-token'), false);
  assert.equal(diagnostics.includes('second-token'), false);
  assert.equal(diagnostics.includes('first@example.com'), false);
  await controller.close();
});

test('composeServer bridges MQTT events and passes AbortSignal into discovery', async () => {
  let discoveryOptions;
  const harness = fakeComponents({
    async scanBambuPrinters(options) { discoveryOptions = options; return []; },
  });
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {} });
  const received = [];
  harness.calls.runtimeOptions.mqttEvents.on('message', (payload) => received.push(payload));
  harness.calls.mqttOptions.emit('message', { serialNumber: 'SERIAL' });
  assert.deepEqual(received, [{ serialNumber: 'SERIAL' }]);
  const abortController = new AbortController();
  await harness.calls.runtimeOptions.discovery({ signal: abortController.signal });
  assert.equal(discoveryOptions.signal, abortController.signal);
  await controller.close();
});

test('composeServer quarantines corrupt encrypted sessions and recreates an empty store', async () => {
  let attempts = 0;
  const emptyStore = { create() {}, authenticate() {}, clear() {}, getBambuSession: () => null };
  const harness = fakeComponents({
    async createSessionStore() {
      harness.order.push('session');
      attempts += 1;
      if (attempts === 1) throw new Error('Unable to authenticate encrypted file: session.enc');
      return emptyStore;
    },
  });
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {}, now: () => 1700 });
  assert.equal(attempts, 2);
  assert.deepEqual(harness.calls.backup, [['session.enc', 'session.enc.corrupt-1700']]);
  assert.deepEqual(harness.calls.remove, [['session.enc']]);
  assert.equal(controller.components.sessionStore, emptyStore);
  assert.equal(controller.readiness.ready, true);
  await controller.close();
});

test('composeServer does not quarantine ordinary session I/O failures', async () => {
  const error = Object.assign(new Error('permission denied while reading private path'), { code: 'EACCES' });
  const harness = fakeComponents({ async createSessionStore() { harness.order.push('session'); throw error; } });
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {} });
  assert.deepEqual(harness.calls.backup, []);
  assert.deepEqual(harness.calls.remove, []);
  assert.equal(controller.readiness.ready, false);
  assert.equal(controller.readiness.degraded, true);
  await controller.close();
});

test('storage failure still serves health while ready, login, and protected APIs return 503', async () => {
  const controller = await startServer({
    env: VALID_ENV,
    listenPort: 0,
    factories: { async createStorage() { throw Object.assign(new Error('secret path denied'), { code: 'EACCES' }); } },
    writer: () => {},
  });
  const jsonHeaders = { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${controller.server.address().port}` };
  assert.equal((await request(controller.server, { path: '/healthz' })).status, 200);
  const readiness = await request(controller.server, { path: '/readyz' });
  assert.equal(readiness.status, 503);
  assert.deepEqual(JSON.parse(readiness.body), { status: 'not_ready', code: 'STORAGE_UNAVAILABLE' });
  assert.equal((await request(controller.server, {
    path: '/api/auth/login', method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ account: 'test@example.com', password: 'not-a-real-password' }),
  })).status, 503);
  assert.equal((await request(controller.server, { path: '/api/devices' })).status, 503);
  assert.equal((await request(controller.server, { path: '/api/devices', headers: { Cookie: 'bambu_session=fake' } })).status, 503);
  await controller.close();
});

test('restore network failure leaves the server ready for login', async () => {
  const harness = fakeComponents({
    createDeviceRuntime(options) {
      harness.order.push('runtime'); harness.calls.runtimeOptions = options;
      return { ...harness.deviceRuntime, async start() { throw new Error('private upstream failure'); } };
    },
  });
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {} });
  assert.equal(controller.readiness.ready, false);
  await controller.startRestoration();
  assert.equal(controller.readiness.ready, true);
  assert.equal(controller.readiness.degraded, false);
  await controller.close();
});

test('startServer listens and serves health while restored cloud work hangs, then becomes ready after timeout', async () => {
  const restore = deferred();
  let restoreSignal;
  const harness = fakeComponents({
    createDeviceRuntime(options) {
      harness.order.push('runtime'); harness.calls.runtimeOptions = options;
      return {
        ...harness.deviceRuntime,
        start(value) { restoreSignal = value.signal; return restore.promise; },
      };
    },
    createHttpApp,
  });
  const starting = startServer({
    env: VALID_ENV,
    listenPort: 0,
    factories: harness.factories,
    restoreTimeoutMs: 20,
    writer: () => {},
  });
  const controller = await Promise.race([
    starting,
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  assert.ok(controller, 'server must listen without awaiting restored cloud work');
  assert.equal((await request(controller.server, { path: '/healthz' })).status, 200);
  assert.equal((await request(controller.server, { path: '/readyz' })).status, 503);
  assert.equal(restoreSignal.aborted, false);

  const restoration = await controller.restoration;
  assert.equal(restoration.timedOut, true);
  assert.equal(restoreSignal.aborted, true);
  assert.equal(controller.readiness.ready, true);
  assert.equal(controller.readiness.syncing, false);
  assert.equal((await request(controller.server, { path: '/readyz' })).status, 200);
  assert.deepEqual(harness.calls.remove, []);
  await controller.close();
});

test('close aborts an owned restoration and leaves no restore timer or rejection behind', async () => {
  const restore = deferred();
  let restoreSignal;
  const harness = fakeComponents({
    createDeviceRuntime(options) {
      harness.order.push('runtime'); harness.calls.runtimeOptions = options;
      return {
        ...harness.deviceRuntime,
        start(value) { restoreSignal = value.signal; return restore.promise; },
      };
    },
    createHttpApp,
  });
  const starting = startServer({
    env: VALID_ENV,
    listenPort: 0,
    factories: harness.factories,
    restoreTimeoutMs: 1000,
    writer: () => {},
  });
  const controller = await Promise.race([
    starting,
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  assert.ok(controller, 'server must listen before restoration settles');
  const closing = controller.close();
  assert.equal(restoreSignal.aborted, true);
  assert.equal((await controller.restoration).aborted, true);
  await closing;
  restore.reject(new Error('late restore rejection'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('close awaits app, camera, and runtime in order while continuing after rejection', async () => {
  const appClose = deferred();
  const cameraClose = deferred();
  const runtimeClose = deferred();
  const cleared = [];
  const timers = {
    setTimeout(callback, delay) {
      return { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    },
    clearTimeout(handle) { cleared.push(handle); },
  };
  const harness = fakeComponents();
  harness.app.close = () => { harness.order.push('app.close'); return appClose.promise; };
  harness.cameraManager.shutdown = () => { harness.order.push('camera.shutdown'); return cameraClose.promise; };
  harness.deviceRuntime.shutdown = () => { harness.order.push('runtime.shutdown'); return runtimeClose.promise; };
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {}, timers });
  harness.order.length = 0;
  const first = controller.close();
  const second = controller.close();
  assert.equal(first, second);
  assert.deepEqual(harness.order, ['app.close']);

  appClose.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.order, ['app.close', 'camera.shutdown']);

  cameraClose.reject(new Error('camera close'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.order, ['app.close', 'camera.shutdown', 'runtime.shutdown']);

  runtimeClose.resolve();
  assert.deepEqual(await first, { timedOut: false, failures: ['camera'] });
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].unrefCalled, false);
});

test('close reports when the injected ten second overall deadline wins', async () => {
  let deadline;
  const cleared = [];
  const timers = {
    setTimeout(callback, delay) { deadline = { callback, delay }; return 9; },
    clearTimeout(handle) { cleared.push(handle); },
  };
  const harness = fakeComponents();
  harness.app.close = () => { harness.order.push('app.close'); return new Promise(() => {}); };
  harness.cameraManager.shutdown = () => { harness.order.push('camera.shutdown'); };
  harness.deviceRuntime.shutdown = () => { harness.order.push('runtime.shutdown'); };
  const controller = await composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {}, timers });
  harness.order.length = 0;
  const closing = controller.close();
  assert.equal(deadline.delay, 10_000);
  assert.deepEqual(harness.order, ['app.close']);
  deadline.callback();
  assert.deepEqual(await closing, { timedOut: true, failures: [] });
  assert.deepEqual(harness.order, ['app.close']);
  assert.deepEqual(cleared, [9]);
});

test('startup failure cleans already-created runtime components', async () => {
  const harness = fakeComponents({ createHttpApp() { harness.order.push('http'); throw new Error('HTTP setup failed'); } });
  await assert.rejects(composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {} }), /HTTP setup failed/);
  assert.deepEqual(harness.order.slice(-3), ['http', 'camera.shutdown', 'runtime.shutdown']);
});

test('runtime construction failure shuts down the MQTT manager it would have owned', async () => {
  const harness = fakeComponents({
    createDeviceRuntime() { harness.order.push('runtime'); throw new Error('runtime setup failed'); },
  });
  harness.mqttManager.shutdown = async () => { harness.order.push('mqtt.shutdown'); };
  await assert.rejects(composeServer({ env: VALID_ENV, factories: harness.factories, writer: () => {} }), /runtime setup failed/);
  assert.deepEqual(harness.order.slice(-2), ['runtime', 'mqtt.shutdown']);
});

test('signal cleanup sets exitCode without force exit after normal shutdown', async () => {
  const processImpl = new EventEmitter();
  processImpl.exitCode = undefined;
  let closes = 0;
  const forced = [];
  const controller = { close: async () => { closes += 1; return { timedOut: false, failures: [] }; } };
  const remove = installShutdownSignals(controller, { processImpl, forceExit: (code) => forced.push(code) });
  assert.equal(processImpl.listenerCount('SIGTERM'), 1);
  assert.equal(processImpl.listenerCount('SIGINT'), 1);
  processImpl.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(processImpl.exitCode, 0);
  assert.deepEqual(forced, []);
  assert.equal(processImpl.listenerCount('SIGTERM'), 0);
  assert.equal(processImpl.listenerCount('SIGINT'), 0);
  remove();
});

test('signal cleanup force exits once when the shutdown deadline wins', async () => {
  const processImpl = new EventEmitter();
  processImpl.exitCode = undefined;
  const forced = [];
  const controller = { close: async () => ({ timedOut: true, failures: [] }) };
  installShutdownSignals(controller, { processImpl, forceExit: (code) => forced.push(code) });
  processImpl.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forced, [1]);
  assert.equal(processImpl.exitCode, 1);
  assert.equal(processImpl.listenerCount('SIGTERM'), 0);
  assert.equal(processImpl.listenerCount('SIGINT'), 0);
});

test('a second signal force exits immediately while ordered close is still pending', async () => {
  const processImpl = new EventEmitter();
  processImpl.exitCode = undefined;
  const closing = deferred();
  const forced = [];
  let closes = 0;
  const controller = {
    close() { closes += 1; return closing.promise; },
  };
  installShutdownSignals(controller, { processImpl, forceExit: (code) => forced.push(code) });
  processImpl.emit('SIGTERM');
  assert.equal(closes, 1);
  assert.deepEqual(forced, []);
  processImpl.emit('SIGINT');
  assert.deepEqual(forced, [1]);
  assert.equal(processImpl.exitCode, 1);
  closing.resolve({ timedOut: true, failures: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forced, [1]);
  assert.equal(processImpl.listenerCount('SIGTERM'), 0);
  assert.equal(processImpl.listenerCount('SIGINT'), 0);
});
