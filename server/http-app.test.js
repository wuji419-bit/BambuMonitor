import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

import { createDeviceRuntime } from './device-runtime.js';
import { createHttpApp } from './http-app.js';

const SESSION_ID = Buffer.alloc(32, 7).toString('base64url');
const SECOND_SESSION_ID = Buffer.alloc(32, 8).toString('base64url');
const CSRF = 'csrf-token';
const JPEG = Buffer.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9]);

function createManualTimers() {
  let nextId = 0;
  const entries = new Map();
  function add(kind, callback, delay) {
    const handle = { id: ++nextId, kind, callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    entries.set(handle.id, handle);
    return handle;
  }
  return {
    setTimeout: (callback, delay) => add('timeout', callback, delay),
    clearTimeout: (handle) => entries.delete(handle?.id),
    setInterval: (callback, delay) => add('interval', callback, delay),
    clearInterval: (handle) => entries.delete(handle?.id),
    runInterval(delay) {
      const entry = [...entries.values()].find((item) => item.kind === 'interval' && item.delay === delay);
      assert.ok(entry, `missing ${delay}ms interval`);
      entry.callback();
    },
    runTimeout(delay) {
      const entry = [...entries.values()].find((item) => item.kind === 'timeout' && item.delay === delay);
      assert.ok(entry, `missing ${delay}ms timeout`);
      entries.delete(entry.id);
      entry.callback();
    },
    count(kind) {
      return [...entries.values()].filter((item) => !kind || item.kind === kind).length;
    },
    entries,
  };
}

function createHarness(overrides = {}) {
  const sessions = new Map([
    [SESSION_ID, { account: 'test@example.com', csrfToken: CSRF, expiresAt: 2_000_000_000_000 }],
    [SECOND_SESSION_ID, { account: 'other@example.com', csrfToken: 'csrf-two', expiresAt: 2_000_000_000_001 }],
  ]);
  const runtimeListeners = new Set();
  const cameraListeners = new Map();
  const calls = {
    authenticate: [], cameraAcquire: [], cameraConfigure: [], cameraRelease: 0,
    cameraSubscribe: [], cameraUnsubscribe: 0, clear: 0, cloud: [], refresh: 0,
    cloudRaw: [], runtimeShutdown: 0, runtimeStopSession: 0, start: [], updateDevice: [],
    startListenerCounts: [], updateSettings: [], notifications: [],
  };
  let snapshot = {
    type: 'devices.snapshot',
    devices: [{ dev_id: 'SERIAL_A', name: 'Printer A', model: 'P1S', ip: '192.168.1.20' }],
    syncedAt: 100,
    cloudState: 'connected',
  };
  let restartSnapshot = structuredClone(snapshot);
  let settings = overrides.settings ?? {
    version: 1,
    camera: { autoOpen: false, customUrls: {} },
    notifications: { enabled: true, targets: [{ id: 'private', token: 'notification-secret' }] },
    debug: false,
  };
  let latestFrame = null;
  let activeCameraLeases = 0;
  let cameraSourceStarts = 0;

  const cloud = overrides.cloud ?? {
    async loginPassword(payload) {
      calls.cloudRaw.push(payload);
      calls.cloud.push(['password', structuredClone(payload)]);
      return { success: true, accessToken: 'private-access-token' };
    },
    async requestVerifyCode(payload) {
      calls.cloud.push(['request-code', structuredClone(payload)]);
      return { success: true, message: 'sent' };
    },
    async loginCode(payload) {
      calls.cloudRaw.push(payload);
      calls.cloud.push(['code', structuredClone(payload)]);
      return { success: true, accessToken: 'private-code-token' };
    },
    async getCloudUsername() { return 'cloud-user'; },
  };
  const sessionStore = overrides.sessionStore ?? {
    async create(input) {
      assert.equal(input.accessToken.includes('token'), true);
      sessions.set(SESSION_ID, {
        account: input.account, csrfToken: CSRF, expiresAt: 2_000_000_000_000,
      });
      this.saved = { ...input, savedAt: 100 };
      return { sessionId: SESSION_ID, account: input.account, csrfToken: CSRF, expiresAt: 2_000_000_000_000 };
    },
    async authenticate(id, options) {
      calls.authenticate.push([id, options]);
      return sessions.get(id) ?? null;
    },
    getBambuSession() { return this.saved ?? { account: 'test@example.com', accessToken: 'saved-token', username: 'cloud-user', savedAt: 100 }; },
    async clear() { calls.clear += 1; sessions.clear(); },
  };
  const deviceRuntime = overrides.deviceRuntime ?? {
    snapshot: () => structuredClone(snapshot),
    getDevice(serial) {
      return snapshot.devices.find((device) => device.dev_id === serial) ?? null;
    },
    getCameraConfig(serial) {
      const device = snapshot.devices.find((item) => item.dev_id === serial);
      if (!device) return null;
      return {
        serialNumber: device.dev_id,
        dev_id: device.dev_id,
        ip: device.ip,
        name: device.name,
        model: device.model,
        accessCode: `private-code-${device.dev_id}`,
      };
    },
    async start(session) {
      calls.start.push(structuredClone(session));
      calls.startListenerCounts.push(runtimeListeners.size);
      if (snapshot.devices.length === 0) snapshot = structuredClone(restartSnapshot);
      if (overrides.startSnapshot) {
        snapshot = structuredClone(overrides.startSnapshot);
        restartSnapshot = structuredClone(snapshot);
        for (const listener of runtimeListeners) listener(structuredClone(snapshot));
      }
      return structuredClone(snapshot);
    },
    async refresh() { calls.refresh += 1; return structuredClone(snapshot); },
    async updateDevice(serial, patch) {
      calls.updateDevice.push([serial, structuredClone(patch)]);
      const device = this.getDevice(serial);
      if (!device) return null;
      Object.assign(device, patch);
      return structuredClone(device);
    },
    subscribe(listener) {
      runtimeListeners.add(listener);
      listener(structuredClone(snapshot));
      let active = true;
      return () => { if (active) { active = false; runtimeListeners.delete(listener); } };
    },
    async stopSession() {
      calls.runtimeStopSession += 1;
      if (snapshot.devices.length > 0) restartSnapshot = structuredClone(snapshot);
      snapshot = { type: 'devices.snapshot', devices: [], syncedAt: null, cloudState: 'idle' };
      for (const listener of runtimeListeners) listener(structuredClone(snapshot));
      return structuredClone(snapshot);
    },
    async shutdown() { calls.runtimeShutdown += 1; },
  };
  const cameraManager = overrides.cameraManager ?? {
    configure(device) { calls.cameraConfigure.push(structuredClone(device)); return true; },
    acquire(serial) {
      calls.cameraAcquire.push(serial);
      activeCameraLeases += 1;
      if (activeCameraLeases === 1) cameraSourceStarts += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        activeCameraLeases -= 1;
        calls.cameraRelease += 1;
      };
    },
    getLatestFrame: () => latestFrame && Buffer.from(latestFrame),
    subscribe(serial, listener) {
      calls.cameraSubscribe.push(serial);
      activeCameraLeases += 1;
      if (activeCameraLeases === 1) cameraSourceStarts += 1;
      const listeners = cameraListeners.get(serial) ?? new Set();
      listeners.add(listener);
      cameraListeners.set(serial, listeners);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        activeCameraLeases -= 1;
        calls.cameraUnsubscribe += 1;
      };
    },
  };
  const configStore = overrides.configStore ?? {
    get: () => structuredClone(settings),
    async update(patch) {
      calls.updateSettings.push(structuredClone(patch));
      const next = structuredClone(patch);
      settings = {
        ...settings,
        ...next,
        camera: next.camera ? { ...settings.camera, ...next.camera } : settings.camera,
        notifications: next.notifications
          ? { ...settings.notifications, ...next.notifications }
          : settings.notifications,
        version: 1,
      };
      return structuredClone(settings);
    },
  };
  const logger = overrides.logger ?? { info() {}, warn() {}, error() {} };
  const app = createHttpApp({
    cloud, sessionStore, deviceRuntime, cameraManager, configStore, logger,
    notificationSender: overrides.notificationSender,
    distDir: overrides.distDir ?? null,
    trustProxy: overrides.trustProxy ?? false,
    readiness: overrides.readiness ?? true,
    timers: overrides.timers,
    limits: overrides.limits,
  });

  return {
    app, calls, cameraListeners, configStore, deviceRuntime, runtimeListeners, sessionStore,
    emitCamera(serial, frame = JPEG) {
      latestFrame = Buffer.from(frame);
      for (const listener of cameraListeners.get(serial) ?? []) listener(Buffer.from(frame));
    },
    emitRuntime(event) { for (const listener of runtimeListeners) listener(structuredClone(event)); },
    get activeCameraLeases() { return activeCameraLeases; },
    get cameraSourceStarts() { return cameraSourceStarts; },
    setLatestFrame(frame) { latestFrame = frame && Buffer.from(frame); },
    setSnapshot(value) { snapshot = structuredClone(value); restartSnapshot = structuredClone(value); },
  };
}

async function startHarness(harness) {
  const returned = harness.app.listen(0, '127.0.0.1');
  assert.equal(returned, harness.app.server);
  await once(harness.app.server, 'listening');
  const { port } = harness.app.server.address();
  return `http://127.0.0.1:${port}`;
}

function cookie(id = SESSION_ID) { return `bambu_session=${id}`; }

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  let body = null;
  if (bytes.length && response.headers.get('content-type')?.includes('json')) body = JSON.parse(bytes.toString());
  return { response, bytes, body };
}

function apiHeaders(base, { csrf = CSRF, id = SESSION_ID, origin = base } = {}) {
  return { Cookie: cookie(id), Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };
}

function rawRequest(base, pathname, options = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: pathname, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ response: res, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitFor(predicate, message = 'condition', attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

function openSocket(base, { id = SESSION_ID, origin = base } = {}) {
  const url = `${base.replace(/^http/, 'ws')}/api/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin, headers: { Cookie: cookie(id) } });
    ws.testMessages = [];
    ws.testMessageWaiters = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiter = ws.testMessageWaiters.shift();
      if (waiter) waiter(message);
      else ws.testMessages.push(message);
    });
    const timeout = setTimeout(() => reject(new Error('websocket open timed out')), 1_000);
    ws.once('open', () => { clearTimeout(timeout); resolve(ws); });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      reject(Object.assign(new Error('upgrade rejected'), { statusCode: response.statusCode }));
    });
    ws.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

function nextMessage(ws, timeoutMs = 1_000) {
  if (ws.testMessages.length) return Promise.resolve(ws.testMessages.shift());
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeListener('close', onClose);
      const index = ws.testMessageWaiters.indexOf(waiter);
      if (index >= 0) ws.testMessageWaiters.splice(index, 1);
    };
    const waiter = (message) => { cleanup(); resolve(message); };
    const onClose = () => { cleanup(); reject(new Error('websocket closed before message')); };
    timer = setTimeout(() => { cleanup(); reject(new Error('websocket message timed out')); }, timeoutMs);
    ws.once('close', onClose);
    ws.testMessageWaiters.push(waiter);
  });
}

async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

function waitForClose(emitter) {
  return new Promise((resolve) => {
    emitter.once('close', resolve);
    emitter.once('error', () => {});
  });
}

test('keeps health public and reports readiness with exact health payload', async (t) => {
  let ready = false;
  const harness = createHarness({ readiness: () => ready });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const health = await request(base, '/healthz');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal((await request(base, '/readyz')).response.status, 503);
  ready = true;
  assert.equal((await request(base, '/readyz')).response.status, 200);
  assert.equal((await request(base, '/api/devices')).response.status, 401);
});

test('readyz reports a stable storage code without leaking readiness details', async (t) => {
  let readiness = {
    ready: false,
    degraded: true,
    category: 'storage-unavailable',
    error: 'EACCES: C:\\private\\bambu-monitor\\secret.key',
  };
  const harness = createHarness({ readiness: () => readiness });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const unavailable = await request(base, '/readyz');
  assert.equal(unavailable.response.status, 503);
  assert.deepEqual(unavailable.body, { status: 'not_ready', code: 'STORAGE_UNAVAILABLE' });
  assert.equal(JSON.stringify(unavailable.body).includes('private'), false);
  assert.equal(JSON.stringify(unavailable.body).includes('EACCES'), false);

  readiness = { ready: true, category: 'storage-unavailable' };
  const ready = await request(base, '/readyz');
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body, { status: 'ready' });
});

test('password login enforces origin and exact bounded JSON then creates a secure-safe session', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const badOrigin = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: 'http://evil.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'test@example.com', password: 'private-password' }),
  });
  assert.equal(badOrigin.response.status, 403);
  assert.deepEqual(badOrigin.body, { ok: false, error: { code: 'FORBIDDEN', message: 'Request verification failed' } });

  const extra = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'test@example.com', password: 'private-password', accessToken: 'leak' }),
  });
  assert.equal(extra.response.status, 400);

  const loggedIn = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'test@example.com', password: 'private-password' }),
  });
  assert.equal(loggedIn.response.status, 200);
  assert.match(loggedIn.response.headers.get('set-cookie'), /^bambu_session=.*HttpOnly; SameSite=Lax/);
  assert.deepEqual(Object.keys(loggedIn.body.data).sort(), ['accountMasked', 'csrfToken', 'expiresAt']);
  assert.equal(JSON.stringify(loggedIn.body).includes('private-access-token'), false);
  assert.equal(harness.calls.cloudRaw[0].password, '');
  assert.deepEqual(harness.calls.start, [{ accessToken: 'private-access-token', username: 'cloud-user' }]);
});

test('cross-account login synchronously removes old websocket subscriptions before runtime start', async (t) => {
  const harness = createHarness({
    startSnapshot: {
      type: 'devices.snapshot',
      devices: [{ dev_id: 'NEW_ACCOUNT_DEVICE', name: 'New account printer' }],
      syncedAt: 200,
      cloudState: 'connected',
    },
  });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const oldSocket = await openSocket(base);
  await nextMessage(oldSocket);
  assert.equal(harness.runtimeListeners.size, 1);

  const login = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'new-account@example.com', password: 'private-password' }),
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(harness.calls.startListenerCounts, [0]);
  assert.equal(harness.runtimeListeners.size, 0);
  await waitFor(() => oldSocket.readyState === WebSocket.CLOSED, 'cross-account websocket close', 20);
  assert.equal(
    oldSocket.testMessages.some((message) => JSON.stringify(message).includes('NEW_ACCOUNT_DEVICE')),
    false,
  );
});

test('same-account login keeps existing websocket subscriptions and session cap ownership', async (t) => {
  const harness = createHarness({
    startSnapshot: {
      type: 'devices.snapshot',
      devices: [{ dev_id: 'SAME_ACCOUNT_DEVICE', name: 'Same account printer' }],
      syncedAt: 201,
      cloudState: 'connected',
    },
  });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const existingSocket = await openSocket(base);
  await nextMessage(existingSocket);

  const update = nextMessage(existingSocket);
  const login = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'test@example.com', password: 'private-password' }),
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(harness.calls.startListenerCounts, [1]);
  assert.equal((await update).devices[0].dev_id, 'SAME_ACCOUNT_DEVICE');
  assert.equal(existingSocket.readyState, WebSocket.OPEN);
  assert.equal(harness.runtimeListeners.size, 1);
  await closeSocket(existingSocket);
});

test('auth endpoints require JSON, enforce body and independent account rate limits, and never output secrets', async (t) => {
  const harness = createHarness({
    limits: {
      bodyBytes: 80,
      login: { limit: 1, windowMs: 60_000, maxKeys: 2 },
      requestCode: { limit: 1, windowMs: 60_000, maxKeys: 2 },
    },
  });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const wrongType = await request(base, '/api/auth/login', { method: 'POST', headers: { Origin: base }, body: '{}' });
  assert.equal(wrongType.response.status, 415);
  const tooLarge = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'a', password: 'x'.repeat(100) }),
  });
  assert.equal(tooLarge.response.status, 413);

  const verify = () => request(base, '/api/auth/code/verify', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'limited@example.com', code: '123456' }),
  });
  assert.equal((await verify()).response.status, 200);
  assert.equal(harness.calls.cloudRaw[0].code, '');
  assert.equal((await verify()).response.status, 429);

  const requestCode = () => request(base, '/api/auth/code/request', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'limited@example.com' }),
  });
  assert.equal((await requestCode()).response.status, 200);
  assert.equal((await requestCode()).response.status, 429);
  assert.equal(JSON.stringify(harness.calls.cloud).includes('private-code-token'), false);
});

test('session is minimal, protected mutations require CSRF, and logout clears state and cookie', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  assert.deepEqual((await request(base, '/api/session')).body, { ok: true, data: { authenticated: false } });
  const authenticated = await request(base, '/api/session', { headers: { Cookie: cookie() } });
  assert.deepEqual(authenticated.body.data, {
    authenticated: true, accountMasked: 't***@example.com', csrfToken: CSRF,
  });

  const missingCsrf = await request(base, '/api/devices/refresh', { method: 'POST', headers: { Cookie: cookie(), Origin: base } });
  assert.equal(missingCsrf.response.status, 403);
  const refreshMissingType = await request(base, '/api/devices/refresh', {
    method: 'POST', headers: { Cookie: cookie(), Origin: base, 'X-CSRF-Token': CSRF }, body: '{}',
  });
  assert.equal(refreshMissingType.response.status, 415);
  const refreshWrongType = await request(base, '/api/devices/refresh', {
    method: 'POST', headers: { Cookie: cookie(), Origin: base, 'X-CSRF-Token': CSRF, 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(refreshWrongType.response.status, 415);
  const refreshExtra = await request(base, '/api/devices/refresh', {
    method: 'POST', headers: apiHeaders(base), body: JSON.stringify({ force: true }),
  });
  assert.equal(refreshExtra.response.status, 400);
  const refreshed = await request(base, '/api/devices/refresh', { method: 'POST', headers: apiHeaders(base), body: '{}' });
  assert.equal(refreshed.response.status, 200);

  const logoutMissingType = await request(base, '/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookie(), Origin: base, 'X-CSRF-Token': CSRF }, body: '{}',
  });
  assert.equal(logoutMissingType.response.status, 415);
  const logoutWrongType = await request(base, '/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookie(), Origin: base, 'X-CSRF-Token': CSRF, 'Content-Type': 'text/plain' }, body: '{}',
  });
  assert.equal(logoutWrongType.response.status, 415);
  const logoutExtra = await request(base, '/api/auth/logout', {
    method: 'POST', headers: apiHeaders(base), body: JSON.stringify({ all: true }),
  });
  assert.equal(logoutExtra.response.status, 400);
  const logout = await request(base, '/api/auth/logout', { method: 'POST', headers: apiHeaders(base), body: '{}' });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get('set-cookie'), /bambu_session=;.*Max-Age=0/);
  assert.equal(harness.calls.clear, 1);
  assert.equal(harness.calls.runtimeStopSession, 1);
  assert.equal(harness.calls.runtimeShutdown, 0);

  const idempotentWrongType = await request(base, '/api/auth/logout', { method: 'POST', headers: { Origin: base }, body: '{}' });
  assert.equal(idempotentWrongType.response.status, 415);
  const idempotent = await request(base, '/api/auth/logout', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(idempotent.response.status, 200);
  assert.match(idempotent.response.headers.get('set-cookie'), /Max-Age=0/);
});

test('logout resets the runtime and a later login starts and synchronizes it again', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const logout = await request(base, '/api/auth/logout', {
    method: 'POST', headers: apiHeaders(base), body: '{}',
  });
  assert.equal(logout.response.status, 200);
  assert.equal(harness.calls.runtimeStopSession, 1);
  assert.equal(harness.deviceRuntime.snapshot().devices.length, 0);

  const login = await request(base, '/api/auth/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'test@example.com', password: 'private-password' }),
  });
  assert.equal(login.response.status, 200);
  assert.equal(harness.calls.start.length, 1);
  const devices = await request(base, '/api/devices', { headers: { Cookie: cookie() } });
  assert.equal(devices.response.status, 200);
  assert.deepEqual(devices.body.data.devices.map((device) => device.dev_id), ['SERIAL_A']);
  assert.equal(harness.calls.runtimeShutdown, 0);
});

test('logout closes every websocket invalidated by the cleared persisted session store', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const first = await openSocket(base);
  const second = await openSocket(base, { id: SECOND_SESSION_ID });
  await Promise.all([nextMessage(first), nextMessage(second)]);

  const logout = await request(base, '/api/auth/logout', {
    method: 'POST', headers: apiHeaders(base), body: '{}',
  });
  assert.equal(logout.response.status, 200);
  await waitFor(
    () => first.readyState === WebSocket.CLOSED && second.readyState === WebSocket.CLOSED,
    'all logout websockets',
    20,
  );
  await waitFor(() => harness.runtimeListeners.size === 0, 'logout websocket cleanup');
});

test('devices and settings validate paths and object contracts before one runtime/store transaction', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const devices = await request(base, '/api/devices', { headers: { Cookie: cookie() } });
  assert.equal(devices.body.data.type, 'devices.snapshot');

  const patched = await request(base, '/api/devices/SERIAL_A', {
    method: 'PATCH', headers: apiHeaders(base), body: JSON.stringify({ name: 'NAS Printer' }),
  });
  assert.equal(patched.response.status, 200);
  assert.deepEqual(harness.calls.updateDevice, [['SERIAL_A', { name: 'NAS Printer' }]]);
  assert.equal((await request(base, '/api/devices/UNKNOWN', {
    method: 'PATCH', headers: apiHeaders(base), body: JSON.stringify({ name: 'Unknown' }),
  })).response.status, 404);
  assert.equal((await request(base, '/api/devices/%E0%A4%A', {
    method: 'PATCH', headers: apiHeaders(base), body: JSON.stringify({ name: 'Bad' }),
  })).response.status, 400);

  const invalidSettings = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base), body: JSON.stringify({ constructor: {}, debug: true }),
  });
  assert.equal(invalidSettings.response.status, 400);
  const settings = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base), body: JSON.stringify({ debug: true }),
  });
  assert.equal(settings.response.status, 200);
  assert.deepEqual(harness.calls.updateSettings, [{ debug: true }]);
});

test('HTTP and websocket device projections hide local connection details but preserve cloud state', async (t) => {
  const harness = createHarness();
  harness.setSnapshot({
    type: 'devices.snapshot',
    devices: [{
      dev_id: 'SERIAL_A',
      name: 'Private Printer',
      model: 'P1S',
      ip: '192.168.1.44',
      accessCode: 'private-access-code',
      rtspsUrl: 'rtsps://bblp:private-access-code@192.168.1.44/streaming/live/1',
      statusSource: 'cloud',
      cloudOnline: true,
      connectionMode: 'local',
      connectionState: 'online',
    }],
    syncedAt: 123,
    cloudState: 'connected',
  });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const httpSnapshot = await request(base, '/api/devices', { headers: { Cookie: cookie() } });
  const ws = await openSocket(base);
  const wsSnapshot = await nextMessage(ws);
  const pendingUpdate = nextMessage(ws);
  harness.emitRuntime({
    type: 'device.updated',
    device: {
      dev_id: 'SERIAL_A',
      ip: '10.0.0.8',
      accessCode: 'updated-private-code',
      statusSource: 'cloud',
      connectionState: 'reconnecting',
    },
  });
  const wsUpdate = await pendingUpdate;
  const patched = await request(base, '/api/devices/SERIAL_A', {
    method: 'PATCH',
    headers: apiHeaders(base),
    body: JSON.stringify({ ip: '192.168.1.55' }),
  });

  for (const payload of [httpSnapshot.body, wsSnapshot, wsUpdate, patched.body]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('192.168.1.'), false);
    assert.equal(serialized.includes('10.0.0.8'), false);
    assert.equal(serialized.includes('private-access-code'), false);
    assert.equal(serialized.includes('updated-private-code'), false);
    assert.equal(serialized.includes('rtsps://'), false);
  }
  assert.equal(httpSnapshot.body.data.devices[0].hasLocalAddress, true);
  assert.equal(httpSnapshot.body.data.devices[0].statusSource, 'cloud');
  assert.equal(httpSnapshot.body.data.devices[0].cloudOnline, true);
  assert.equal(wsUpdate.device.hasLocalAddress, true);
  assert.deepEqual(harness.calls.updateDevice.at(-1), ['SERIAL_A', { ip: '192.168.1.55' }]);
  assert.equal(patched.body.data.hasLocalAddress, true);
  await closeSocket(ws);
});

test('settings projection redacts credentials while PUT preserves round-trips and accepts replacements', async (t) => {
  const rawSettings = {
    version: 1,
    camera: {
      autoOpen: false,
      customUrls: {
        SERIAL_A: 'https://camera-user:camera-pass@camera.example.test/live?token=camera-query-secret&view=wide',
      },
    },
    notifications: {
      enabled: true,
      targets: [
        {
          id: 'alpha', name: 'Alpha', type: 'webhook', enabled: true,
          secret: 'alpha-target-secret', token: 'alpha-target-token',
          url: 'https://alpha-user:alpha-pass@hooks.example.test/alpha?api_key=alpha-query-secret&safe=visible',
          headers: {
            Authorization: 'Bearer alpha-auth-secret',
            'Proxy-Authorization': 'Basic alpha-proxy-auth-secret',
            Cookie: 'sid=alpha-cookie-secret',
            'X-API-Key': 'alpha-header-api-key',
            'X-Token': 'alpha-header-token',
            'X-Secret': 'alpha-header-secret',
            'X-Safe': 'visible-header',
          },
        },
        {
          id: 'beta', name: 'Beta', secret: 'beta-target-secret', token: 'beta-target-token',
          url: 'https://hooks.example.test/beta?access_token=beta-query-secret',
          headers: { Authorization: 'Bearer beta-auth-secret' },
        },
        {
          name: 'Index fallback', secret: 'index-target-secret', token: 'index-target-token',
          headers: { 'X-API-Key': 'index-header-secret' },
        },
      ],
    },
    debug: false,
  };
  const secretValues = [
    'camera-user', 'camera-pass', 'camera-query-secret',
    'alpha-user', 'alpha-pass', 'alpha-query-secret', 'alpha-target-secret', 'alpha-target-token',
    'alpha-auth-secret', 'alpha-proxy-auth-secret', 'alpha-cookie-secret', 'alpha-header-api-key', 'alpha-header-token',
    'alpha-header-secret', 'beta-target-secret', 'beta-target-token', 'beta-query-secret',
    'beta-auth-secret', 'index-target-secret', 'index-target-token', 'index-header-secret',
  ];
  const assertProjected = (payload) => {
    const serialized = JSON.stringify(payload);
    for (const secret of secretValues) assert.equal(serialized.includes(secret), false, secret);
  };
  const harness = createHarness({ settings: rawSettings });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const read = await request(base, '/api/settings', { headers: { Cookie: cookie() } });
  assert.equal(read.response.status, 200);
  const projected = read.body.data;
  assertProjected(projected);
  assert.equal(projected.notifications.targets[0].secret, '[REDACTED]');
  assert.equal(projected.notifications.targets[0].token, '[REDACTED]');
  assert.equal(projected.notifications.targets[0].headers.Authorization, '[REDACTED]');
  assert.equal(projected.notifications.targets[0].headers['Proxy-Authorization'], '[REDACTED]');
  assert.equal(projected.notifications.targets[0].headers.Cookie, '[REDACTED]');
  assert.equal(projected.notifications.targets[0].headers['X-API-Key'], '[REDACTED]');
  assert.equal(projected.notifications.targets[0].headers['X-Safe'], 'visible-header');

  const roundTrip = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base), body: JSON.stringify(projected),
  });
  assert.equal(roundTrip.response.status, 200);
  assertProjected(roundTrip.body);
  let storedPatch = harness.calls.updateSettings.at(-1);
  assert.equal(storedPatch.camera.customUrls.SERIAL_A, rawSettings.camera.customUrls.SERIAL_A);
  assert.equal(storedPatch.notifications.targets[0].secret, 'alpha-target-secret');
  assert.equal(storedPatch.notifications.targets[0].headers.Authorization, 'Bearer alpha-auth-secret');
  assert.equal(storedPatch.notifications.targets[0].url, rawSettings.notifications.targets[0].url);
  assert.equal(storedPatch.notifications.targets[2].secret, 'index-target-secret');

  const reorderedTargets = [
    projected.notifications.targets[1],
    projected.notifications.targets[0],
    projected.notifications.targets[2],
  ];
  const reordered = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base),
    body: JSON.stringify({ notifications: { targets: reorderedTargets } }),
  });
  assert.equal(reordered.response.status, 200);
  storedPatch = harness.calls.updateSettings.at(-1);
  assert.equal(storedPatch.notifications.targets[0].secret, 'beta-target-secret');
  assert.equal(storedPatch.notifications.targets[1].secret, 'alpha-target-secret');
  assert.equal(storedPatch.notifications.targets[2].secret, 'index-target-secret');

  const omitted = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base),
    body: JSON.stringify({ notifications: { targets: [{ id: 'alpha', name: 'Renamed Alpha' }] } }),
  });
  assert.equal(omitted.response.status, 200);
  storedPatch = harness.calls.updateSettings.at(-1).notifications.targets[0];
  assert.equal(storedPatch.secret, 'alpha-target-secret');
  assert.equal(storedPatch.token, 'alpha-target-token');
  assert.equal(storedPatch.headers.Authorization, 'Bearer alpha-auth-secret');
  assert.equal(storedPatch.url, rawSettings.notifications.targets[0].url);

  const replacement = await request(base, '/api/settings', {
    method: 'PUT', headers: apiHeaders(base),
    body: JSON.stringify({
      camera: {
        customUrls: {
          SERIAL_A: 'https://replacement-camera-user:replacement-camera-pass@camera.example.test/new?token=replacement-camera-token',
        },
      },
      notifications: { targets: [{
        id: 'alpha',
        secret: 'replacement-target-secret',
        token: 'replacement-target-token',
        url: 'https://hooks.example.test/new?token=replacement-query-secret',
        headers: { Authorization: 'Bearer replacement-auth-secret' },
      }] },
    }),
  });
  assert.equal(replacement.response.status, 200);
  assert.equal(
    harness.calls.updateSettings.at(-1).camera.customUrls.SERIAL_A,
    'https://replacement-camera-user:replacement-camera-pass@camera.example.test/new?token=replacement-camera-token',
  );
  storedPatch = harness.calls.updateSettings.at(-1).notifications.targets[0];
  assert.equal(storedPatch.secret, 'replacement-target-secret');
  assert.equal(storedPatch.token, 'replacement-target-token');
  assert.equal(storedPatch.url, 'https://hooks.example.test/new?token=replacement-query-secret');
  assert.equal(storedPatch.headers.Authorization, 'Bearer replacement-auth-secret');
  for (const secret of [
    'replacement-target-secret', 'replacement-target-token',
    'replacement-query-secret', 'replacement-auth-secret', 'replacement-camera-user',
    'replacement-camera-pass', 'replacement-camera-token',
  ]) {
    assert.equal(JSON.stringify(replacement.body).includes(secret), false);
  }
});

test('notification tests use server-side settings and unsupported mode is explicit without echoing targets', async (t) => {
  let senderInput;
  const supported = createHarness({ notificationSender: async (input) => { senderInput = input; return { success: true, token: 'sender-leak' }; } });
  const supportedBase = await startHarness(supported);
  t.after(() => supported.app.close());
  const sent = await request(supportedBase, '/api/notifications/test', {
    method: 'POST', headers: apiHeaders(supportedBase), body: '{}',
  });
  assert.equal(sent.response.status, 200);
  assert.equal(senderInput.settings.notifications.targets[0].token, 'notification-secret');
  assert.equal(JSON.stringify(sent.body).includes('notification-secret'), false);
  assert.equal(JSON.stringify(sent.body).includes('sender-leak'), false);

  const unsupported = createHarness();
  const unsupportedBase = await startHarness(unsupported);
  t.after(() => unsupported.app.close());
  assert.equal((await request(unsupportedBase, '/api/notifications/test', {
    method: 'POST', headers: apiHeaders(unsupportedBase), body: '{}',
  })).response.status, 501);
});

test('camera frame auth, origin, timeout, cleanup, latest frame, and four-per-second rate are enforced', async (t) => {
  const timers = createManualTimers();
  const harness = createHarness({ timers, limits: { frameWaitMs: 4_000, frameRate: { limit: 4, windowMs: 1_000, maxKeys: 100 } } });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  assert.equal((await request(base, '/api/cameras/SERIAL_A/frame')).response.status, 401);
  assert.equal((await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie(), Origin: 'http://evil.test' } })).response.status, 403);

  const waiting = request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  await waitFor(() => harness.activeCameraLeases === 2, 'frame leases');
  assert.equal(harness.activeCameraLeases, 2);
  timers.runTimeout(4_000);
  const timedOut = await waiting;
  assert.equal(timedOut.response.status, 504);
  assert.equal(harness.activeCameraLeases, 0);

  harness.setLatestFrame(JPEG);
  for (let index = 0; index < 3; index += 1) {
    const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
    assert.equal(frame.response.status, 200);
    assert.equal(frame.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(frame.bytes, JPEG);
  }
  assert.equal((await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } })).response.status, 429);
  assert.equal(harness.activeCameraLeases, 0);
});

test('camera routes configure from private runtime state plus server-side custom URL without payload leaks', async (t) => {
  const harness = createHarness({
    settings: {
      version: 1,
      camera: { autoOpen: false, customUrls: { SERIAL_A: 'https://camera.example.test/live' } },
      notifications: { enabled: false, targets: [] },
      debug: false,
    },
  });
  harness.setLatestFrame(JPEG);
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const devices = await request(base, '/api/devices', { headers: { Cookie: cookie() } });
  const ws = await openSocket(base);
  const initial = await nextMessage(ws);
  const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 200);
  assert.deepEqual(harness.calls.cameraConfigure.at(-1), {
    serialNumber: 'SERIAL_A',
    dev_id: 'SERIAL_A',
    ip: '192.168.1.20',
    name: 'Printer A',
    model: 'P1S',
    accessCode: 'private-code-SERIAL_A',
    customUrl: 'https://camera.example.test/live',
  });
  for (const payload of [devices.body, initial, frame.bytes]) {
    assert.equal(JSON.stringify(payload).includes('private-code-SERIAL_A'), false);
  }
  await closeSocket(ws);
});

test('real device runtime passes private camera access code to HTTP camera manager only', async (t) => {
  const mqttListeners = new Set();
  let mqttShutdownCalls = 0;
  const runtime = createDeviceRuntime({
    cloud: {
      async listDevices() {
        return {
          success: true,
          devices: [{
            id: 'SERIAL_REAL', name: 'Real Printer', model: 'P1S',
            accessCode: 'real-private-access-code', online: true,
          }],
          username: 'real-user',
        };
      },
    },
    mqtt: {
      async connect() {},
      async disconnect() {},
      subscribe(listener) { mqttListeners.add(listener); return () => mqttListeners.delete(listener); },
      async shutdown() { mqttShutdownCalls += 1; },
    },
    discovery: { async scan() { return []; } },
    configStore: {
      getDeviceCache() {
        return { version: 1, devices: { SERIAL_REAL: { ip: '192.168.1.88', model: 'P1S' } } };
      },
      async updateDevice() { return {}; },
    },
    now: () => 100,
  });
  await runtime.start({ accessToken: 'real-private-cloud-token', username: 'real-user' });
  const harness = createHarness({ deviceRuntime: runtime });
  harness.setLatestFrame(JPEG);
  const base = await startHarness(harness);
  t.after(async () => {
    await harness.app.close();
    await runtime.shutdown();
  });

  const devices = await request(base, '/api/devices', { headers: { Cookie: cookie() } });
  const frame = await request(base, '/api/cameras/SERIAL_REAL/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 200);
  assert.equal(harness.calls.cameraConfigure.at(-1).accessCode, 'real-private-access-code');
  assert.equal(harness.calls.cameraConfigure.at(-1).customUrl, undefined);
  assert.equal(JSON.stringify(harness.calls.cameraConfigure).includes('real-private-cloud-token'), false);
  assert.equal(JSON.stringify(devices.body).includes('real-private-access-code'), false);
  assert.equal(JSON.stringify(devices.body).includes('real-private-cloud-token'), false);
  assert.equal(mqttShutdownCalls, 0);
});

test('camera routes fail safely when private camera configuration is unavailable', async (t) => {
  const harness = createHarness();
  harness.deviceRuntime.getCameraConfig = () => null;
  harness.setLatestFrame(JPEG);
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 503);
  assert.deepEqual(frame.body, {
    ok: false, error: { code: 'CAMERA_UNAVAILABLE', message: 'Camera is unavailable' },
  });
  assert.equal(harness.calls.cameraConfigure.length, 0);
  assert.equal(harness.calls.cameraAcquire.length, 0);

  harness.deviceRuntime.getCameraConfig = () => ({
    serialNumber: 'SERIAL_A', accessCode: 'orphaned-private-code',
  });
  const invalid = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(invalid.response.status, 503);
  assert.equal(JSON.stringify(invalid.body).includes('orphaned-private-code'), false);
  assert.equal(harness.calls.cameraConfigure.length, 0);
});

test('camera routes accept manager-valid built-in config without model metadata', async (t) => {
  const harness = createHarness();
  harness.deviceRuntime.getCameraConfig = () => ({
    serialNumber: 'SERIAL_A', dev_id: 'SERIAL_A',
    ip: '192.168.1.20', accessCode: 'private-code-without-model',
  });
  harness.setLatestFrame(JPEG);
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 200);
  assert.equal(harness.calls.cameraConfigure.at(-1).accessCode, 'private-code-without-model');
});

test('camera frame releases a subscription that emits synchronously during setup', async (t) => {
  let releases = 0;
  let unsubscribes = 0;
  const cameraManager = {
    configure() { return true; },
    acquire() { return () => { releases += 1; }; },
    getLatestFrame() { return null; },
    subscribe(_serial, listener) {
      listener(JPEG);
      return () => { unsubscribes += 1; };
    },
  };
  const harness = createHarness({ cameraManager });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 200);
  assert.deepEqual(frame.bytes, JPEG);
  assert.equal(releases, 1);
  assert.equal(unsubscribes, 1);
});

test('camera frame releases its acquisition when subscription setup throws', async (t) => {
  let releases = 0;
  const cameraManager = {
    configure() { return true; },
    acquire() { return () => { releases += 1; }; },
    getLatestFrame() { return null; },
    subscribe() { throw new Error('camera-secret'); },
  };
  const harness = createHarness({ cameraManager });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const frame = await request(base, '/api/cameras/SERIAL_A/frame', { headers: { Cookie: cookie() } });
  assert.equal(frame.response.status, 503);
  assert.deepEqual(frame.body, { ok: false, error: { code: 'CAMERA_UNAVAILABLE', message: 'Camera is unavailable' } });
  assert.equal(releases, 1);
  assert.equal(JSON.stringify(frame.body).includes('camera-secret'), false);
});

async function heldStream(base, serial = 'SERIAL_A', id = SESSION_ID) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: `/api/cameras/${serial}/stream`,
      headers: { Cookie: cookie(id) },
    });
    req.once('response', (response) => resolve({ req, response }));
    req.once('error', reject);
    req.end();
  });
}

test('camera streams cap before acquire, share one source, replace closed slots, and clean every lease', async (t) => {
  const harness = createHarness({ limits: { streamsPerCamera: 4, streamsGlobal: 20 } });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());

  const held = [];
  for (let index = 0; index < 4; index += 1) held.push(await heldStream(base));
  assert.equal(harness.cameraSourceStarts, 1);
  assert.equal(harness.calls.cameraSubscribe.length, 4);
  const rejected = await request(base, '/api/cameras/SERIAL_A/stream', { headers: { Cookie: cookie() } });
  assert.equal(rejected.response.status, 429);
  assert.equal(harness.calls.cameraSubscribe.length, 4);

  held[0].response.destroy();
  await once(held[0].response, 'close');
  const replacement = await heldStream(base);
  assert.equal(replacement.response.statusCode, 200);
  harness.emitCamera('SERIAL_A');
  await once(replacement.response, 'data');
  replacement.response.destroy();
  for (const stream of held.slice(1)) stream.response.destroy();
  await waitFor(() => harness.activeCameraLeases === 0, 'stream cleanup');
  assert.equal(harness.activeCameraLeases, 0);
  assert.equal(harness.calls.cameraUnsubscribe, 5);
});

test('global camera stream limit applies across cameras before manager subscription', async (t) => {
  const devices = Array.from({ length: 21 }, (_, index) => ({
    dev_id: `SERIAL_${index}`,
    name: `P${index}`,
    model: 'P1S',
    ip: `192.168.1.${index + 1}`,
  }));
  const harness = createHarness({ limits: { streamsPerCamera: 4, streamsGlobal: 20 } });
  harness.setSnapshot({ type: 'devices.snapshot', devices, syncedAt: 1, cloudState: 'connected' });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const held = [];
  for (let index = 0; index < 20; index += 1) held.push(await heldStream(base, `SERIAL_${index}`));
  assert.equal((await request(base, '/api/cameras/SERIAL_20/stream', { headers: { Cookie: cookie() } })).response.status, 429);
  assert.equal(harness.calls.cameraSubscribe.length, 20);
  for (const stream of held) stream.response.destroy();
});

test('websocket clients receive one initial snapshot and isolated updates then unsubscribe exactly once', async (t) => {
  const harness = createHarness();
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const firstPending = openSocket(base).then(async (ws) => ({ ws, message: await nextMessage(ws) }));
  const secondPending = openSocket(base).then(async (ws) => ({ ws, message: await nextMessage(ws) }));
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.message.type, 'devices.snapshot');
  assert.equal(second.message.type, 'devices.snapshot');
  assert.equal(harness.runtimeListeners.size, 2);

  const firstUpdate = nextMessage(first.ws);
  const secondUpdate = nextMessage(second.ws);
  harness.emitRuntime({ type: 'device.updated', device: { dev_id: 'SERIAL_A', progress: 42 } });
  assert.equal((await firstUpdate).device.progress, 42);
  assert.equal((await secondUpdate).device.progress, 42);
  await closeSocket(first.ws);
  await closeSocket(second.ws);
  await waitFor(() => harness.runtimeListeners.size === 0, 'websocket unsubscribe');
  assert.equal(harness.runtimeListeners.size, 0);
});

test('websocket upgrade rejects origin/session/socket overflow and session invalid closes clients', async (t) => {
  const harness = createHarness({ limits: { wsPerSession: 2 } });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  await assert.rejects(openSocket(base, { origin: 'http://evil.test' }), (error) => error.statusCode === 403);
  await assert.rejects(openSocket(base, { id: 'invalid' }), (error) => error.statusCode === 401);

  const first = await openSocket(base);
  const second = await openSocket(base);
  await Promise.all([nextMessage(first), nextMessage(second)]);
  await assert.rejects(openSocket(base), (error) => error.statusCode === 429);
  const invalidMessages = [nextMessage(first, 500), nextMessage(second, 500)];
  const firstClosed = once(first, 'close');
  const secondClosed = once(second, 'close');
  harness.emitRuntime({ type: 'session.invalid' });
  assert.deepEqual(await Promise.all(invalidMessages), [
    { type: 'session.invalid' }, { type: 'session.invalid' },
  ]);
  await Promise.all([firstClosed, secondClosed]);
  assert.equal(harness.runtimeListeners.size, 0);
});

test('websocket ping timer is unrefed and terminates after two missed pongs', async (t) => {
  const timers = createManualTimers();
  const harness = createHarness({ timers });
  const base = await startHarness(harness);
  t.after(() => harness.app.close());
  const ws = await openSocket(base);
  await nextMessage(ws);
  ws._receiver.removeAllListeners('conclude');
  const closed = once(ws, 'close');
  timers.runInterval(30_000);
  timers.runInterval(30_000);
  timers.runInterval(30_000);
  await closed;
  await waitFor(() => harness.runtimeListeners.size === 0, 'ping termination cleanup');
  assert.equal(harness.runtimeListeners.size, 0);
  assert.equal([...timers.entries.values()].every((entry) => entry.unrefCalled), true);
});

test('static app serves cache-safe assets, HEAD and SPA while rejecting traversal and API fallback', async (t) => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'bambu-http-app-'));
  await mkdir(path.join(distDir, 'assets'));
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>NAS app</title>');
  await writeFile(path.join(distDir, 'assets', 'app-abc123.js'), 'globalThis.loaded = true;');
  const harness = createHarness({ distDir });
  const base = await startHarness(harness);
  t.after(async () => { await harness.app.close(); await rm(distDir, { recursive: true, force: true }); });

  const index = await request(base, '/');
  assert.equal(index.response.status, 200, index.bytes.toString());
  assert.equal(index.response.headers.get('cache-control'), 'no-cache');
  assert.equal(index.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(index.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(index.response.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.match(index.response.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(index.response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(index.bytes.toString(), /NAS app/);
  const asset = await request(base, '/assets/app-abc123.js');
  assert.match(asset.response.headers.get('cache-control'), /immutable/);
  assert.match(asset.response.headers.get('content-type'), /javascript/);
  const head = await rawRequest(base, '/assets/app-abc123.js', { method: 'HEAD' });
  assert.equal(head.bytes.length, 0);
  assert.match((await request(base, '/printers/SERIAL_A')).bytes.toString(), /NAS app/);
  assert.equal((await rawRequest(base, '/%2e%2e/server/session-store.js')).response.statusCode, 400);
  assert.equal((await request(base, '/.env')).response.status, 404);
  assert.equal((await request(base, '/api/unknown')).response.status, 404);
});

test('close ends active camera responses, websocket subscriptions, timers, and the HTTP server idempotently', async () => {
  const timers = createManualTimers();
  const harness = createHarness({ timers });
  const base = await startHarness(harness);
  const stream = await heldStream(base);
  const ws = await openSocket(base);
  await nextMessage(ws);
  const streamClosed = waitForClose(stream.response);
  const wsClosed = once(ws, 'close');

  const firstClose = harness.app.close();
  const secondClose = harness.app.close();
  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, streamClosed, wsClosed]);
  assert.equal(harness.activeCameraLeases, 0);
  assert.equal(harness.runtimeListeners.size, 0);
  assert.equal(timers.count(), 0);
  assert.equal(harness.app.server.listening, false);
});
