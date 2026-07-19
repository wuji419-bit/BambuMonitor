import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebRuntime } from './web.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(body); },
  };
}

function createFetchQueue(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected fetch');
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, fetchImpl };
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closeCalls = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value) {
    this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  }

  fail() {
    this.onerror?.(new Error('socket failed'));
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }
}

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeoutImpl(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
    runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'expected a pending timer');
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

function createRuntime(fetchImpl, overrides = {}) {
  FakeWebSocket.instances = [];
  return createWebRuntime({
    fetchImpl,
    WebSocketImpl: FakeWebSocket,
    location: { protocol: 'https:', host: 'nas.local:3080' },
    ...overrides,
  });
}

test('login stores CSRF only in memory and authenticated requests use exact API options', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf-secret', expiresAt: 123, accountMasked: 'a***@b.com' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [{ dev_id: 'A' }], syncedAt: 9 } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [{ dev_id: 'B' }], syncedAt: 10 } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);

  const login = await runtime.auth.cloudLogin({ account: 'alice@example.com', password: 'private-password' });
  assert.deepEqual(login, {
    success: true,
    serverSession: true,
    accountMasked: 'a***@b.com',
    expiresAt: 123,
  });
  const devices = await runtime.auth.getDeviceList();
  assert.deepEqual(devices, {
    success: true,
    devices: [{ dev_id: 'A' }],
    syncedAt: 9,
    cloudState: undefined,
  });
  await runtime.devices.refresh();

  assert.deepEqual(queue.calls.map(({ url }) => url), [
    '/api/auth/login', '/api/devices', '/api/devices/refresh',
  ]);
  assert.equal(queue.calls[0].options.credentials, 'same-origin');
  assert.equal(queue.calls[0].options.headers.Accept, 'application/json');
  assert.equal(queue.calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(queue.calls[0].options.headers['X-CSRF-Token'], undefined);
  assert.equal(queue.calls[2].options.headers['X-CSRF-Token'], 'csrf-secret');
  assert.equal(queue.calls[2].options.body, '{}');
  assert.equal(JSON.stringify(login).includes('csrf-secret'), false);
  assert.equal(JSON.stringify(login).includes('private-password'), false);
  runtime.close();
});

test('session restoration is token-free, logout uses CSRF, and saveSession is a no-op', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { authenticated: true, accountMasked: 't***@example.com', csrfToken: 'csrf-restored' } }),
    jsonResponse({ ok: true, data: { authenticated: false } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);

  assert.deepEqual(await runtime.auth.getSavedSession(), {
    success: true,
    session: { serverSession: true, account: 't***@example.com', accountMasked: 't***@example.com' },
  });
  assert.deepEqual(await runtime.auth.saveSession({ accessToken: 'must-not-persist' }), { success: true });
  assert.deepEqual(await runtime.auth.clearSavedSession(), { success: true, authenticated: false });
  assert.equal(queue.calls.length, 2);
  assert.equal(queue.calls[1].options.headers['X-CSRF-Token'], 'csrf-restored');
  assert.equal(JSON.stringify(queue.calls).includes('must-not-persist'), false);
  runtime.close();
});

test('auth code endpoints and API errors preserve safe status and code', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { sent: true } }),
    jsonResponse({ ok: false, error: { code: 'BAD_CODE', message: 'Verification failed' } }, 400),
  ]);
  const runtime = createRuntime(queue.fetchImpl);

  assert.deepEqual(await runtime.auth.requestVerifyCode({ account: 'a@example.com' }), {
    success: true, sent: true, message: '验证码已发送，请查看短信或邮箱',
  });
  assert.deepEqual(await runtime.auth.cloudLoginCode({ account: 'a@example.com', code: '123456' }), {
    success: false, error: 'Verification failed', code: 'BAD_CODE', status: 400,
  });
  assert.deepEqual(queue.calls.map(({ url }) => url), [
    '/api/auth/code/request', '/api/auth/code/verify',
  ]);
  runtime.close();
});

test('device, settings, and notification mutations preserve exact payloads and adapt results', async () => {
  const updated = { dev_id: 'SERIAL / 一', ip: 'printer.local' };
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf', accountMasked: 'a***' } }),
    jsonResponse({ ok: true, data: updated }),
    jsonResponse({ ok: true, data: { camera: { enabled: true } } }),
    jsonResponse({ ok: true, data: { camera: { enabled: false } } }),
    jsonResponse({ ok: true, data: { sent: true } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);
  await runtime.auth.cloudLogin({ account: 'a', password: 'b' });

  assert.deepEqual(await runtime.devices.update('SERIAL / 一', { ip: 'printer.local' }), {
    success: true, device: updated,
  });
  assert.deepEqual(await runtime.settings.get(), { success: true, settings: { camera: { enabled: true } } });
  assert.deepEqual(await runtime.settings.save({ camera: { enabled: false } }), {
    success: true, settings: { camera: { enabled: false } },
  });
  assert.deepEqual(await runtime.notifications.send(), { success: true, sent: true });

  assert.equal(queue.calls[1].url, '/api/devices/SERIAL%20%2F%20%E4%B8%80');
  assert.equal(queue.calls[1].options.method, 'PATCH');
  assert.equal(queue.calls[1].options.body, JSON.stringify({ ip: 'printer.local' }));
  assert.equal(queue.calls[3].options.method, 'PUT');
  assert.equal(queue.calls[4].options.body, '{}');
  runtime.close();
});

test('camera URLs are same-origin and never accept or expose printer secrets', async () => {
  const queue = createFetchQueue([]);
  const runtime = createRuntime(queue.fetchImpl);
  const result = await runtime.camera.start({
    serialNumber: 'SERIAL / 一', ip: '192.168.1.20', accessCode: '12345678',
  });

  assert.deepEqual(result, {
    success: true,
    mode: 'nas-gateway',
    snapshotUrl: '/api/cameras/SERIAL%20%2F%20%E4%B8%80/frame',
    url: '/api/cameras/SERIAL%20%2F%20%E4%B8%80/stream',
  });
  assert.equal(JSON.stringify(result).includes('192.168.1.20'), false);
  assert.equal(JSON.stringify(result).includes('12345678'), false);
  assert.deepEqual(await runtime.camera.stop({ serialNumber: 'SERIAL / 一' }), { success: true });
  assert.deepEqual(await runtime.camera.stopAll(), { success: true });
  assert.equal(queue.calls.length, 0);
  runtime.close();
});

test('401 invalidates once, clears session memory, and preserves no secret in the result', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf-private', accountMasked: 'a***' } }),
    jsonResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401),
    jsonResponse({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Session expired' } }, 401),
  ]);
  const runtime = createRuntime(queue.fetchImpl);
  let invalidations = 0;
  runtime.events.onSessionInvalid(() => { invalidations += 1; });
  await runtime.auth.cloudLogin({ account: 'a', password: 'secret-password' });

  const first = await runtime.auth.getDeviceList();
  await runtime.devices.refresh();
  assert.deepEqual(first, {
    success: false, error: 'Session expired', code: 'UNAUTHORIZED', status: 401,
  });
  assert.equal(invalidations, 1);
  assert.equal(queue.calls[2].options.headers['X-CSRF-Token'], undefined);
  assert.equal(JSON.stringify(first).includes('csrf-private'), false);
  assert.equal(JSON.stringify(first).includes('secret-password'), false);
  runtime.close();
});

test('one websocket fans out cloned known events and immediate fallback snapshot', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf', accountMasked: 'a***' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [{ dev_id: 'fallback' }], syncedAt: 1 } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);
  const first = [];
  const second = [];
  const offFirst = runtime.events.onDeviceSnapshot((event) => {
    first.push(event);
    event.devices[0].dev_id = 'mutated';
    return Promise.reject(new Error('listener rejection'));
  });
  runtime.events.onDeviceSnapshot((event) => second.push(event));

  await runtime.auth.cloudLogin({ account: 'a', password: 'b' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].url, 'wss://nas.local:3080/api/ws');
  assert.equal(first[0].devices[0].dev_id, 'mutated');
  assert.equal(second[0].devices[0].dev_id, 'fallback');

  FakeWebSocket.instances[0].message({ type: 'devices.snapshot', devices: [{ dev_id: 'socket' }], ignored: 'value' });
  FakeWebSocket.instances[0].message({ type: 'unknown.event', secret: 'drop' });
  FakeWebSocket.instances[0].message('{bad json');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(second.length, 2);
  assert.equal(second[1].devices[0].dev_id, 'socket');

  offFirst();
  offFirst();
  runtime.close();
});

test('websocket reconnect uses bounded backoff, one timer, and rejects stale generations', async () => {
  const timers = createFakeTimers();
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'first', accountMasked: 'a***' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [] } }),
    jsonResponse({ ok: true, data: { csrfToken: 'second', accountMasked: 'b***' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [] } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl, timers);
  const updates = [];
  runtime.events.onDeviceUpdate((event) => updates.push(event));
  await runtime.auth.cloudLogin({ account: 'a', password: 'b' });
  await Promise.resolve();

  const staleSocket = FakeWebSocket.instances[0];
  staleSocket.serverClose();
  staleSocket.serverClose();
  assert.equal(timers.timers.size, 1);
  assert.equal(timers.runNext(), 1000);
  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances[1].serverClose();
  assert.equal(timers.runNext(), 2000);

  FakeWebSocket.instances.at(-1).serverClose();
  assert.equal(timers.runNext(), 4000);
  FakeWebSocket.instances.at(-1).serverClose();
  assert.equal(timers.runNext(), 8000);
  FakeWebSocket.instances.at(-1).serverClose();
  assert.equal(timers.runNext(), 15000);
  FakeWebSocket.instances.at(-1).serverClose();
  assert.equal(timers.runNext(), 15000);
  FakeWebSocket.instances.at(-1).serverClose();

  runtime.close();
  staleSocket.message({ type: 'device.updated', device: { dev_id: 'stale' } });
  assert.equal(updates.length, 0);
  assert.equal(timers.timers.size, 0);

  runtime.events.onDeviceUpdate((event) => updates.push(event));
  await runtime.auth.cloudLogin({ account: 'b', password: 'c' });
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.length, 8);
  FakeWebSocket.instances.at(-1).message({ type: 'device.updated', device: { dev_id: 'fresh' } });
  assert.equal(updates.at(-1).device.dev_id, 'fresh');
  runtime.close();
});

test('session.invalid socket event emits once and closes the active generation', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf', accountMasked: 'a***' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [] } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);
  let invalidations = 0;
  runtime.events.onSessionInvalid(() => { invalidations += 1; });
  await runtime.auth.cloudLogin({ account: 'a', password: 'b' });
  await Promise.resolve();
  const socket = FakeWebSocket.instances[0];

  socket.message({ type: 'session.invalid' });
  socket.message({ type: 'session.invalid' });
  assert.equal(invalidations, 1);
  assert.equal(socket.closeCalls.length, 1);
  runtime.close();
});

test('websocket drops multibyte events above the byte bound before dispatch', async () => {
  const queue = createFetchQueue([
    jsonResponse({ ok: true, data: { csrfToken: 'csrf', accountMasked: 'a***' } }),
    jsonResponse({ ok: true, data: { type: 'devices.snapshot', devices: [] } }),
  ]);
  const runtime = createRuntime(queue.fetchImpl);
  const snapshots = [];
  runtime.events.onDeviceSnapshot((event) => snapshots.push(event));
  await runtime.auth.cloudLogin({ account: 'a', password: 'b' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(snapshots, [{
    type: 'devices.snapshot', devices: [], syncedAt: undefined, cloudState: undefined,
  }]);

  FakeWebSocket.instances[0].message({
    type: 'devices.snapshot',
    devices: [{ dev_id: 'A', name: '中'.repeat(100_000) }],
  });
  assert.equal(snapshots.length, 1, 'only the small HTTP fallback is delivered');
  runtime.close();
});
