import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDeviceRuntime } from './device-runtime.js';

const NOW = 1_700_000_000_000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function cloudDevice(id, overrides = {}) {
  return {
    id,
    name: `Printer ${id}`,
    model: 'P1S',
    accessCode: `code-${id}`,
    online: true,
    ...overrides,
  };
}

function createHarness({
  cache = {},
  cloudResults = [],
  connectImpl,
  disconnectImpl,
  logger,
  mqttEvents,
  scanResults = [],
  updateDeviceImpl,
} = {}) {
  const cloudQueue = [...cloudResults];
  const scanQueue = [...scanResults];
  const cloudCalls = [];
  const connectCalls = [];
  const disconnectCalls = [];
  const scanCalls = [];
  const updateCalls = [];
  const mqttListeners = new Set();
  let mqttShutdownCalls = 0;

  const cloud = {
    listDevices(accessToken, options) {
      cloudCalls.push({ accessToken, options });
      const result = cloudQueue.shift();
      if (typeof result === 'function') return result(accessToken, options);
      if (result instanceof Error) return Promise.reject(result);
      return result instanceof Promise ? result : Promise.resolve(result);
    },
  };
  const mqtt = {
    connect(payload) {
      connectCalls.push(structuredClone(payload));
      if (connectImpl) return connectImpl(payload);
      return Promise.resolve({ success: true });
    },
    disconnect(serialNumber) {
      disconnectCalls.push(serialNumber);
      if (disconnectImpl) return disconnectImpl(serialNumber);
      return Promise.resolve({ success: true });
    },
    subscribe(listener) {
      mqttListeners.add(listener);
      return () => mqttListeners.delete(listener);
    },
    shutdown() {
      mqttShutdownCalls += 1;
      return Promise.resolve({ success: true });
    },
    emit(event, payload) {
      for (const listener of mqttListeners) listener(event, payload);
    },
  };
  const discovery = {
    scan(options) {
      scanCalls.push(options);
      const result = scanQueue.shift() ?? [];
      if (typeof result === 'function') return result(options);
      if (result instanceof Error) return Promise.reject(result);
      return result instanceof Promise ? result : Promise.resolve(result);
    },
  };
  const configStore = {
    getDeviceCache() {
      return { version: 1, devices: structuredClone(cache) };
    },
    async updateDevice(serialNumber, patch) {
      updateCalls.push({ serialNumber, patch: structuredClone(patch) });
      if (updateDeviceImpl) return updateDeviceImpl(serialNumber, patch);
      cache[serialNumber] = { ...(cache[serialNumber] ?? {}), ...patch, updatedAt: NOW };
      return structuredClone(cache[serialNumber]);
    },
  };

  return {
    cloud,
    cloudCalls,
    configStore,
    connectCalls,
    disconnectCalls,
    discovery,
    enqueueCloud(result) {
      cloudQueue.push(result);
    },
    enqueueScan(result) {
      scanQueue.push(result);
    },
    mqtt,
    mqttListeners,
    runtime: createDeviceRuntime({
      cloud,
      mqtt,
      ...(mqttEvents === undefined ? {} : { mqttEvents }),
      discovery,
      configStore,
      now: () => NOW,
      logger,
    }),
    scanCalls,
    updateCalls,
    get mqttShutdownCalls() {
      return mqttShutdownCalls;
    },
  };
}

test('publishes every cloud device in cloud order before LAN discovery completes', async () => {
  const scan = deferred();
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_B'), cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }],
    scanResults: [scan.promise],
  });

  const started = harness.runtime.start({ accessToken: 'token', username: 'fallback-user' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(
    harness.runtime.snapshot().devices.map((device) => device.dev_id),
    ['SERIAL_B', 'SERIAL_A'],
  );
  assert.equal(harness.connectCalls.length, 2);
  assert.equal(harness.connectCalls.every((call) => call.mode === 'cloud'), true);
  assert.equal(harness.connectCalls.every((call) => call.region === 'China'), true);

  scan.resolve([]);
  await started;
});

test('start threads AbortSignal to cloud and stale cloud completion cannot mutate state', async () => {
  const cloud = deferred();
  let cloudOptions;
  const harness = createHarness({
    cloudResults: [(_accessToken, options) => { cloudOptions = options; return cloud.promise; }],
    scanResults: [[]],
  });
  const controller = new AbortController();
  const started = harness.runtime.start({
    accessToken: 'restore-token', username: 'restore-user', signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.notEqual(cloudOptions.signal, controller.signal);
  assert.equal(cloudOptions.signal.aborted, false);
  controller.abort();
  await started;
  assert.equal(cloudOptions.signal.aborted, true);
  assert.equal(harness.runtime.snapshot().cloudState, 'reconnecting');

  cloud.resolve({ success: true, devices: [cloudDevice('STALE')], username: 'stale-user' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.runtime.snapshot().devices, []);
  assert.equal(harness.scanCalls.length, 0);
  await harness.runtime.shutdown();
});

test('start links its AbortSignal to LAN discovery and settles the aborted scan', async () => {
  let scanSignal;
  const harness = createHarness({
    cloudResults: [{ success: true, devices: [], username: 'restore-user' }],
    scanResults: [(options) => {
      scanSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('scan aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }],
  });
  const controller = new AbortController();
  const started = harness.runtime.start({
    accessToken: 'restore-token', username: 'restore-user', signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(scanSignal);
  controller.abort();
  assert.equal(scanSignal.aborted, true);
  await started;
  await harness.runtime.shutdown();
});

test('deduplicates normalized cloud serials with the first valid occurrence winning', async () => {
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [
        cloudDevice('serial_a', { name: 'First', accessCode: 'first-code' }),
        cloudDevice('SERIAL_A', { name: 'Second', accessCode: 'second-code' }),
      ],
      username: 'cloud-user',
    }],
    scanResults: [[]],
  });

  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });

  assert.equal(harness.runtime.snapshot().devices.length, 1);
  assert.equal(harness.runtime.getDevice('SERIAL_A').name, 'First');
  assert.equal(harness.connectCalls.length, 1);
});

test('exposes fresh server-only camera config without leaking access codes through public payloads', async () => {
  const harness = createHarness({
    cache: { SERIAL_A: { ip: '192.168.1.20', name: 'Cached Printer', model: 'P1S' } },
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A', { accessCode: 'private-camera-code' })],
      username: 'cloud-user',
    }],
    scanResults: [[]],
  });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  await harness.runtime.start({ accessToken: 'private-cloud-token', username: 'cloud-user' });

  const first = harness.runtime.getCameraConfig('serial_a');
  assert.deepEqual(first, {
    serialNumber: 'SERIAL_A',
    dev_id: 'SERIAL_A',
    ip: '192.168.1.20',
    name: 'Cached Printer',
    model: 'P1S',
    accessCode: 'private-camera-code',
  });
  first.accessCode = 'mutated';
  assert.equal(harness.runtime.getCameraConfig('SERIAL_A').accessCode, 'private-camera-code');
  assert.equal(harness.runtime.getCameraConfig('UNKNOWN'), null);

  for (const payload of [harness.runtime.snapshot(), harness.runtime.getDevice('SERIAL_A'), events]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('private-camera-code'), false);
    assert.equal(serialized.includes('private-cloud-token'), false);
    assert.equal(serialized.includes('192.168.1.20'), false);
  }
  assert.equal(harness.runtime.getDevice('SERIAL_A').hasLocalAddress, true);
  assert.equal(harness.runtime.getDevice('SERIAL_A').connectionMode, 'local');
});

test('stopSession clears live state without shutting down MQTT and a later start synchronizes again', async () => {
  let stoppedScanSignal;
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A', { accessCode: 'first-code' })],
      username: 'first-user',
    }],
    scanResults: [[], ({ signal }) => {
      stoppedScanSignal = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve([]), { once: true }));
    }],
  });
  await harness.runtime.start({ accessToken: 'first-token', username: 'first-user' });
  const scanning = harness.runtime.scanLan();
  await Promise.resolve();

  const firstStop = harness.runtime.stopSession();
  const secondStop = harness.runtime.stopSession();
  assert.equal(firstStop, secondStop);
  await firstStop;
  assert.equal(stoppedScanSignal.aborted, true);
  assert.deepEqual(harness.disconnectCalls, ['SERIAL_A']);
  assert.equal(harness.mqttShutdownCalls, 0);
  assert.equal(harness.mqttListeners.size, 1);
  assert.deepEqual(harness.runtime.snapshot(), {
    type: 'devices.snapshot', devices: [], syncedAt: null, cloudState: 'idle',
  });
  assert.equal(harness.runtime.getCameraConfig('SERIAL_A'), null);
  await scanning;

  harness.enqueueCloud({
    success: true,
    devices: [cloudDevice('SERIAL_B', { accessCode: 'second-code' })],
    username: 'second-user',
  });
  harness.enqueueScan([]);
  await harness.runtime.start({ accessToken: 'second-token', username: 'second-user' });
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['SERIAL_B']);
  assert.equal(harness.runtime.getCameraConfig('SERIAL_B').accessCode, 'second-code');
  assert.equal(harness.connectCalls.at(-1).authToken, 'second-token');
  assert.equal(harness.mqttShutdownCalls, 0);

  await harness.runtime.stopSession();
  await harness.runtime.shutdown();
  await harness.runtime.shutdown();
  assert.equal(harness.mqttShutdownCalls, 1);
});

test('stopSession invalidates a late refresh before a later login start', async () => {
  const lateRefresh = deferred();
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('OLD_SESSION')],
      username: 'old-user',
    }],
    scanResults: [[], []],
  });
  await harness.runtime.start({ accessToken: 'old-token', username: 'old-user' });
  harness.enqueueCloud(lateRefresh.promise);
  const refreshing = harness.runtime.refresh();
  await Promise.resolve();

  await harness.runtime.stopSession();
  harness.enqueueCloud({
    success: true,
    devices: [cloudDevice('NEW_SESSION')],
    username: 'new-user',
  });
  await harness.runtime.start({ accessToken: 'new-token', username: 'new-user' });
  lateRefresh.resolve({
    success: true,
    devices: [cloudDevice('STALE_SESSION')],
    username: 'old-user',
  });
  await refreshing;

  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['NEW_SESSION']);
  assert.equal(harness.connectCalls.some((call) => call.serialNumber === 'STALE_SESSION'), false);
  assert.equal(harness.connectCalls.at(-1).authToken, 'new-token');
  assert.equal(harness.mqttShutdownCalls, 0);
});

test('rejected current MQTT connect clears its fingerprint and retries the replacement record', async () => {
  const firstConnect = deferred();
  const inventory = (name) => ({
    success: true,
    devices: [cloudDevice('SERIAL_A', { name })],
    username: 'cloud-user',
  });
  const harness = createHarness({
    cloudResults: [inventory('Original'), inventory('Current'), inventory('Current')],
    connectImpl() {
      return harness.connectCalls.length === 1
        ? firstConnect.promise
        : Promise.resolve({ success: true });
    },
    scanResults: [[]],
  });
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  await harness.runtime.refresh();
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.runtime.getDevice('SERIAL_A').name, 'Current');

  firstConnect.reject(new Error('broker unavailable'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.runtime.getDevice('SERIAL_A').name, 'Current');
  assert.equal(harness.runtime.getDevice('SERIAL_A').connectionState, 'error');
  await harness.runtime.refresh();
  assert.equal(harness.connectCalls.length, 2);
});

test('accepts a separate EventEmitter for manager callback events', async () => {
  const mqttEvents = new EventEmitter();
  const connectCalls = [];
  const mqtt = {
    connect(payload) {
      connectCalls.push(structuredClone(payload));
      return Promise.resolve({ success: true });
    },
    disconnect() {
      return Promise.resolve({ success: true });
    },
    shutdown() {
      return Promise.resolve({ success: true });
    },
  };
  const runtime = createDeviceRuntime({
    cloud: {
      async listDevices() {
        return {
          success: true,
          devices: [cloudDevice('SERIAL_A')],
          username: 'cloud-user',
        };
      },
    },
    mqtt,
    mqttEvents,
    discovery: { async scan() { return []; } },
    configStore: {
      getDeviceCache() { return { version: 1, devices: {} }; },
      async updateDevice() { return {}; },
    },
    now: () => NOW,
  });

  await runtime.start({ accessToken: 'token', username: 'cloud-user' });
  mqttEvents.emit('message', {
    serialNumber: 'SERIAL_A',
    payload: { print: { mc_percent: 37, gcode_state: 'RUNNING' } },
  });

  assert.equal(connectCalls.length, 1);
  assert.equal(runtime.getDevice('SERIAL_A').progress, 37);
  assert.equal(mqttEvents.listenerCount('message'), 1);
  await runtime.shutdown();
  assert.equal(mqttEvents.listenerCount('message'), 0);
});

test('reuses one MQTT connection across refresh and retains a cached IP after scan failure', async () => {
  const inventory = {
    success: true,
    devices: [cloudDevice('SERIAL_A')],
    username: 'cloud-user',
  };
  const harness = createHarness({
    cache: { SERIAL_A: { ip: '192.168.1.20', name: 'Cached A', model: 'X1C' } },
    cloudResults: [inventory, inventory],
    scanResults: [new Error('LAN unavailable')],
  });

  await harness.runtime.start({ accessToken: 'token', username: 'fallback-user' });
  assert.equal(harness.runtime.getDevice('SERIAL_A').hasLocalAddress, true);
  assert.equal(harness.runtime.getCameraConfig('SERIAL_A').ip, '192.168.1.20');
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.connectCalls[0].mode, 'local');

  await harness.runtime.refresh();
  assert.equal(harness.runtime.getDevice('SERIAL_A').hasLocalAddress, true);
  assert.equal(harness.runtime.getCameraConfig('SERIAL_A').ip, '192.168.1.20');
  assert.equal(harness.connectCalls.length, 1);
});

test('401 and 403 emit a credential-free account.invalid while preserving prior devices', async () => {
  for (const status of [401, 403]) {
    const authError = Object.assign(new Error('expired token-secret code-SERIAL_A'), {
      status,
      tokenInvalid: true,
    });
    const harness = createHarness({
      cloudResults: [{
        success: true,
        devices: [cloudDevice('SERIAL_A')],
        username: 'cloud-user',
      }, authError],
      scanResults: [[]],
    });
    await harness.runtime.start({ accessToken: 'token-secret', username: 'cloud-user' });
    const events = [];
    harness.runtime.subscribe((event) => events.push(event));

    await harness.runtime.refresh();

    assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['SERIAL_A']);
    assert.equal(harness.runtime.snapshot().cloudState, 'invalid');
    assert.equal(events.some((event) => event.type === 'session.invalid'), false);
    assert.equal(events.some((event) => event.type === 'account.invalid' && event.accountId === 'legacy'), true);
    const publicEvents = JSON.stringify(events);
    assert.equal(publicEvents.includes('token-secret'), false);
    assert.equal(publicEvents.includes('code-SERIAL_A'), false);
  }
});

test('ordinary cloud failures preserve inventory and publish reconnecting cloud state', async () => {
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }, new Error('network failed with token-secret')],
    scanResults: [[]],
  });
  await harness.runtime.start({ accessToken: 'token-secret', username: 'cloud-user' });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  await harness.runtime.refresh();

  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['SERIAL_A']);
  assert.equal(harness.runtime.snapshot().cloudState, 'reconnecting');
  assert.equal(events.some((event) => event.type === 'session.invalid'), false);
  assert.equal(JSON.stringify(events).includes('token-secret'), false);
});

test('merges cache and verified LAN fields by serial, persists them, and ignores LAN-only devices', async () => {
  const harness = createHarness({
    cache: {
      SERIAL_A: { ip: '192.168.1.10', name: 'Cached A', model: 'Cached Model' },
      LAN_ONLY: { ip: '192.168.1.99', name: 'Not bound', model: 'A1' },
    },
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A', { name: 'Cloud A', model: 'P1S' })],
      username: 'cloud-user',
    }],
    scanResults: [[
      { serial: 'SERIAL_A', ip: '192.168.1.11', name: 'Discovered A', model: 'X1 Carbon' },
      { serial: 'LAN_ONLY', ip: '192.168.1.99', name: 'LAN only', model: 'A1' },
    ]],
  });

  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });

  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['SERIAL_A']);
  assert.deepEqual(
    {
      ip: harness.runtime.getCameraConfig('SERIAL_A').ip,
      name: harness.runtime.getDevice('SERIAL_A').name,
      model: harness.runtime.getDevice('SERIAL_A').model,
    },
    { ip: '192.168.1.11', name: 'Discovered A', model: 'X1 Carbon' },
  );
  assert.equal(harness.runtime.getDevice('SERIAL_A').hasLocalAddress, true);
  assert.deepEqual(harness.updateCalls, [{
    serialNumber: 'SERIAL_A',
    patch: { ip: '192.168.1.11', name: 'Discovered A', model: 'X1 Carbon' },
  }]);
});

test('disconnects a printer removed from later canonical cloud inventory', async () => {
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A'), cloudDevice('SERIAL_B')],
      username: 'cloud-user',
    }, {
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }],
    scanResults: [[]],
  });
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });

  await harness.runtime.refresh();

  assert.deepEqual(harness.disconnectCalls, ['SERIAL_B']);
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['SERIAL_A']);
  assert.equal(harness.connectCalls.length, 2);
});

test('reconnects only when mode, credentials, IP, or access code changes', async () => {
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }, {
      success: true,
      devices: [cloudDevice('SERIAL_A', { accessCode: 'replacement-code' })],
      username: 'cloud-user',
    }],
    scanResults: [[]],
  });
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  assert.equal(harness.connectCalls.length, 1);

  await harness.runtime.updateDevice('SERIAL_A', { name: 'Renamed' });
  assert.equal(harness.connectCalls.length, 1);
  await harness.runtime.updateDevice('SERIAL_A', { ip: '192.168.1.22' });
  assert.equal(harness.connectCalls.length, 2);
  assert.equal(harness.connectCalls.at(-1).mode, 'local');
  await harness.runtime.updateDevice('SERIAL_A', { ip: '192.168.1.22' });
  assert.equal(harness.connectCalls.length, 2);

  await harness.runtime.refresh();
  assert.equal(harness.connectCalls.length, 3);
  assert.equal(harness.connectCalls.at(-1).accessCode, 'replacement-code');
  assert.equal('accessCode' in harness.runtime.getDevice('SERIAL_A'), false);

  const writesBeforeUnknown = harness.updateCalls.length;
  assert.equal(await harness.runtime.updateDevice('NOT_BOUND', { ip: '192.168.1.30' }), null);
  assert.equal(harness.updateCalls.length, writesBeforeUnknown);
});

test('access token and username fingerprint changes each reconnect exactly once', async () => {
  const inventory = (username = '') => ({
    success: true,
    devices: [cloudDevice('SERIAL_A')],
    username,
  });
  const harness = createHarness({
    cloudResults: [inventory(), inventory(), inventory(), inventory(), inventory()],
  });

  await harness.runtime.start({ accessToken: 'token-a', username: 'user-a' });
  assert.equal(harness.connectCalls.length, 1);
  assert.deepEqual(harness.connectCalls.at(-1), {
    serialNumber: 'SERIAL_A',
    mode: 'cloud',
    region: 'China',
    authToken: 'token-a',
    username: 'user-a',
  });

  await harness.runtime.start({ accessToken: 'token-a', username: 'user-a' });
  assert.equal(harness.connectCalls.length, 1);

  await harness.runtime.start({ accessToken: 'token-b', username: 'user-a' });
  assert.equal(harness.connectCalls.length, 2);
  assert.equal(harness.connectCalls.at(-1).authToken, 'token-b');
  assert.equal(harness.connectCalls.at(-1).username, 'user-a');

  await harness.runtime.start({ accessToken: 'token-b', username: 'user-b' });
  assert.equal(harness.connectCalls.length, 3);
  assert.equal(harness.connectCalls.at(-1).authToken, 'token-b');
  assert.equal(harness.connectCalls.at(-1).username, 'user-b');

  await harness.runtime.start({ accessToken: 'token-b', username: 'user-b' });
  assert.equal(harness.connectCalls.length, 3);
});

test('a LAN write completing after cloud removal cannot reconnect or emit a stale device', async () => {
  const persistenceStarted = deferred();
  const persistence = deferred();
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }, {
      success: true,
      devices: [],
      username: 'cloud-user',
    }],
    scanResults: [[], [{ serial: 'SERIAL_A', ip: '192.168.1.55' }]],
    updateDeviceImpl() {
      persistenceStarted.resolve();
      return persistence.promise;
    },
  });
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  const scanning = harness.runtime.scanLan();
  await persistenceStarted.promise;
  await harness.runtime.refresh();
  const connectsAfterRemoval = harness.connectCalls.length;
  persistence.resolve({ ip: '192.168.1.55', updatedAt: NOW });
  await scanning;

  assert.equal(harness.runtime.getDevice('SERIAL_A'), null);
  assert.equal(harness.connectCalls.length, connectsAfterRemoval);
  assert.equal(events.some((event) => event.type === 'device.updated'), false);
});

test('a LAN write completing after replacement enriches only the current cloud record', async () => {
  const persistenceStarted = deferred();
  const persistence = deferred();
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A', { name: 'Original', accessCode: 'old-code' })],
      username: 'old-user',
    }, {
      success: true,
      devices: [cloudDevice('SERIAL_A', { name: 'Replacement', accessCode: 'new-code' })],
      username: 'new-user',
    }],
    scanResults: [[], [{ serial: 'SERIAL_A', ip: '192.168.1.56' }]],
    updateDeviceImpl() {
      persistenceStarted.resolve();
      return persistence.promise;
    },
  });
  await harness.runtime.start({ accessToken: 'token', username: 'old-user' });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  const scanning = harness.runtime.scanLan();
  await persistenceStarted.promise;
  await harness.runtime.refresh();
  assert.equal(harness.connectCalls.length, 2);
  persistence.resolve({ ip: '192.168.1.56', updatedAt: NOW });
  await scanning;

  assert.equal(harness.connectCalls.length, 3);
  assert.deepEqual(harness.connectCalls.at(-1), {
    serialNumber: 'SERIAL_A',
    mode: 'local',
    ip: '192.168.1.56',
    accessCode: 'new-code',
  });
  assert.equal(harness.runtime.getDevice('SERIAL_A').name, 'Replacement');
  assert.equal(harness.runtime.getDevice('SERIAL_A').hasLocalAddress, true);
  assert.equal(harness.runtime.getCameraConfig('SERIAL_A').ip, '192.168.1.56');
  const update = events.filter((event) => event.type === 'device.updated').at(-1);
  assert.equal(update.device.name, 'Replacement');
  assert.equal(update.device.hasLocalAddress, true);
  assert.equal('ip' in update.device, false);
});

test('fans one MQTT telemetry message to two subscribers without creating another connection', async () => {
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }],
    scanResults: [[]],
  });
  const firstEvents = [];
  const secondEvents = [];
  const unsubscribeFirst = harness.runtime.subscribe((event) => firstEvents.push(event));
  harness.runtime.subscribe((event) => secondEvents.push(event));
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  assert.equal(harness.mqttListeners.size, 1);

  harness.mqtt.emit('message', {
    serialNumber: 'SERIAL_A',
    payload: { print: { mc_percent: 42, gcode_state: 'RUNNING' } },
  });

  const firstUpdate = firstEvents.filter((event) => event.type === 'device.updated').at(-1);
  const secondUpdate = secondEvents.filter((event) => event.type === 'device.updated').at(-1);
  assert.equal(firstUpdate.device.progress, 42);
  assert.deepEqual(firstUpdate, secondUpdate);
  assert.equal(harness.connectCalls.length, 1);

  unsubscribeFirst();
  unsubscribeFirst();
  const firstCount = firstEvents.length;
  harness.mqtt.emit('reconnecting', { serialNumber: 'SERIAL_A' });
  assert.equal(firstEvents.length, firstCount);
  assert.equal(secondEvents.at(-1).device.connectionState, 'reconnecting');
});

test('isolates subscriber payloads and catches rejected thenables without awaiting them', async () => {
  const logs = [];
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }],
    logger: {
      warn(entry) {
        logs.push(entry);
      },
    },
    scanResults: [[]],
  });
  const secondEvents = [];
  const rejectedThenable = {
    then(_resolve, reject) {
      reject(new Error('subscriber failed'));
    },
  };
  harness.runtime.subscribe((event) => {
    if (event.devices?.[0]) event.devices[0].name = 'mutated snapshot';
    if (event.device) event.device.name = 'mutated update';
    return rejectedThenable;
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(logs.length, 1);
  harness.runtime.subscribe((event) => secondEvents.push(event));

  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  const latestSnapshot = secondEvents.filter((event) => event.type === 'devices.snapshot').at(-1);
  assert.equal(latestSnapshot.devices[0].name, 'Printer SERIAL_A');

  harness.mqtt.emit('message', {
    serialNumber: 'SERIAL_A',
    payload: { print: { mc_percent: 24, gcode_state: 'RUNNING' } },
  });
  const update = secondEvents.filter((event) => event.type === 'device.updated').at(-1);
  assert.equal(update.device.name, 'Printer SERIAL_A');
  assert.equal(update.device.progress, 24);
  assert.equal(harness.runtime.getDevice('SERIAL_A').name, 'Printer SERIAL_A');

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    logs.some((entry) => entry.operation === 'device-runtime.subscriber-failed'),
    true,
  );
});

test('coalesces overlapping scans and ignores an aborted late result after shutdown', async () => {
  const lateScan = deferred();
  let lateSignal;
  const harness = createHarness({
    cloudResults: [{
      success: true,
      devices: [cloudDevice('SERIAL_A')],
      username: 'cloud-user',
    }],
    scanResults: [[], ({ signal }) => {
      lateSignal = signal;
      return lateScan.promise;
    }],
  });
  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  const firstScan = harness.runtime.scanLan();
  const secondScan = harness.runtime.scanLan();
  assert.equal(firstScan, secondScan);
  assert.equal(harness.scanCalls.length, 2);
  assert.equal(lateSignal.aborted, false);

  const shutdown = harness.runtime.shutdown();
  assert.equal(lateSignal.aborted, true);
  const eventCountAtShutdown = events.length;
  lateScan.resolve([{
    serial: 'SERIAL_A',
    ip: '192.168.1.50',
    name: 'Too late',
    model: 'A1',
  }]);
  await firstScan;
  await shutdown;

  assert.equal(harness.updateCalls.length, 0);
  assert.equal(events.length, eventCountAtShutdown);
  assert.deepEqual(harness.disconnectCalls, ['SERIAL_A']);
  assert.equal(harness.mqttShutdownCalls, 1);
  await harness.runtime.shutdown();
  assert.equal(harness.mqttShutdownCalls, 1);
});

test('stale concurrent start and refresh completions cannot replace newer session state', async () => {
  const staleStart = deferred();
  const harness = createHarness({
    cloudResults: [staleStart.promise, {
      success: true,
      devices: [cloudDevice('NEW_SESSION')],
      username: 'new-user',
    }],
    scanResults: [[]],
  });

  const firstStart = harness.runtime.start({ accessToken: 'old-token', username: 'old-user' });
  const secondStart = harness.runtime.start({ accessToken: 'new-token', username: 'new-user' });
  await secondStart;
  staleStart.resolve({
    success: true,
    devices: [cloudDevice('STALE_SESSION')],
    username: 'old-user',
  });
  await firstStart;

  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['NEW_SESSION']);
  assert.equal(harness.connectCalls.some((call) => call.serialNumber === 'STALE_SESSION'), false);

  const staleRefresh = deferred();
  harness.enqueueCloud(staleRefresh.promise);
  harness.enqueueCloud({
    success: true,
    devices: [cloudDevice('LATEST_REFRESH')],
    username: 'new-user',
  });
  const firstRefresh = harness.runtime.refresh();
  const secondRefresh = harness.runtime.refresh();
  await secondRefresh;
  staleRefresh.resolve({
    success: true,
    devices: [cloudDevice('STALE_REFRESH')],
    username: 'new-user',
  });
  await firstRefresh;

  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['LATEST_REFRESH']);
});

test('unsubscribe and shutdown are idempotent and prevent all post-shutdown emissions', async () => {
  const harness = createHarness({
    cloudResults: [{ success: true, devices: [], username: 'cloud-user' }],
    scanResults: [[]],
  });
  const events = [];
  const unsubscribe = harness.runtime.subscribe((event) => events.push(event));
  assert.equal(events.length, 1);
  unsubscribe();
  unsubscribe();

  await harness.runtime.start({ accessToken: 'token', username: 'cloud-user' });
  await harness.runtime.shutdown();
  await harness.runtime.shutdown();
  harness.mqtt.emit('message', {
    serialNumber: 'SERIAL_A',
    payload: { print: { mc_percent: 90 } },
  });

  assert.equal(events.length, 1);
  assert.equal(harness.mqttListeners.size, 0);
  assert.equal(harness.mqttShutdownCalls, 1);
});

test('aggregates account inventories in insertion order with one MQTT connection per serial', async () => {
  const harness = createHarness({
    cloudResults: [
      { success: true, username: 'first-user', devices: [cloudDevice('FIRST'), cloudDevice('DUPLICATE')] },
      { success: true, username: 'second-user', devices: [cloudDevice('DUPLICATE'), cloudDevice('SECOND')] },
    ],
    scanResults: [[]],
  });

  await harness.runtime.start({
    accounts: [
      { accountId: 'first', accountMasked: 'f***@example.com', remark: 'Office', accessToken: 'first-token', username: 'first-user' },
      { accountId: 'second', accountMasked: 's***@example.com', remark: 'Studio', accessToken: 'second-token', username: 'second-user' },
    ],
  });

  const devices = harness.runtime.snapshot().devices;
  assert.deepEqual(devices.map((device) => device.dev_id), ['FIRST', 'DUPLICATE', 'SECOND']);
  assert.deepEqual(devices[1].accountIds, ['first', 'second']);
  assert.deepEqual(devices[1].accountLabels, ['Office', 'Studio']);
  assert.equal(devices[1].displayName, 'Printer DUPLICATE（Office / Studio）');
  assert.equal(harness.connectCalls.filter((call) => call.serialNumber === 'DUPLICATE').length, 1);
  assert.equal(harness.scanCalls.length, 1);
  assert.deepEqual(harness.runtime.getAccountStates().map((state) => state.connectionState), ['connected', 'connected']);
});

test('isolates an invalid account without invalidating the aggregate runtime', async () => {
  const invalid = Object.assign(new Error('expired'), { status: 401, tokenInvalid: true });
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('FIRST')] },
      invalid,
    ],
    scanResults: [[]],
  });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));

  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token', username: '' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token', username: '' },
  ] });

  assert.equal(harness.runtime.snapshot().cloudState, 'connected');
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['FIRST']);
  assert.equal(events.some((event) => event.type === 'session.invalid'), false);
  assert.equal(events.some((event) => event.type === 'account.invalid' && event.accountId === 'second'), true);
});

test('remark-only updates relabel duplicate devices without reconnecting', async () => {
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('DUPLICATE')] },
      { success: true, devices: [cloudDevice('DUPLICATE')] },
    ],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: 'Office', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: 'Studio', accessToken: 'second-token' },
  ] });
  const connections = harness.connectCalls.length;

  harness.runtime.updateAccountRemark('second', 'Lab');

  assert.equal(harness.connectCalls.length, connections);
  assert.deepEqual(harness.runtime.getDevice('DUPLICATE').accountLabels, ['Office', 'Lab']);
  assert.equal(harness.runtime.getDevice('DUPLICATE').displayName, 'Printer DUPLICATE（Office / Lab）');
});

test('fails over a cloud source and removes the device only after its final account is removed', async () => {
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('DUPLICATE')] },
      { success: true, devices: [cloudDevice('DUPLICATE')] },
    ],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token', username: 'first-user' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token', username: 'second-user' },
  ] });
  assert.equal(harness.connectCalls.at(-1).authToken, 'first-token');

  assert.equal(harness.runtime.removeAccount('first'), true);
  assert.equal(harness.runtime.getDevice('DUPLICATE').accountIds[0], 'second');
  assert.equal(harness.connectCalls.at(-1).authToken, 'second-token');
  assert.deepEqual(harness.disconnectCalls, []);

  assert.equal(harness.runtime.removeAccount('second'), true);
  assert.equal(harness.runtime.getDevice('DUPLICATE'), null);
  assert.deepEqual(harness.disconnectCalls, ['DUPLICATE']);
});

test('keeps an equivalent local connection when one duplicate source is removed', async () => {
  const harness = createHarness({
    cache: { DUPLICATE: { ip: '192.168.1.44' } },
    cloudResults: [
      { success: true, devices: [cloudDevice('DUPLICATE', { accessCode: 'same-code' })] },
      { success: true, devices: [cloudDevice('DUPLICATE', { accessCode: 'same-code' })] },
    ],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });
  const connections = harness.connectCalls.length;

  harness.runtime.removeAccount('first');

  assert.equal(harness.runtime.getCameraConfig('DUPLICATE').accessCode, 'same-code');
  assert.equal(harness.connectCalls.length, connections);
});

test('marks aggregate state invalid only when every selected account is invalid', async () => {
  const invalid = () => Object.assign(new Error('expired'), { status: 403, tokenInvalid: true });
  const harness = createHarness({ cloudResults: [invalid(), invalid()], scanResults: [[]] });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });

  assert.equal(harness.runtime.snapshot().cloudState, 'invalid');
  assert.deepEqual(harness.runtime.getAccountStates().map((state) => state.connectionState), ['invalid', 'invalid']);
});

test('limits simultaneous account cloud requests to three', async () => {
  const pending = [];
  let active = 0;
  let maximum = 0;
  const harness = createHarness({
    cloudResults: Array.from({ length: 5 }, (_value, index) => () => {
      active += 1;
      maximum = Math.max(maximum, active);
      const request = deferred();
      pending.push({ index, request });
      return request.promise.finally(() => { active -= 1; });
    }),
    scanResults: [[]],
  });
  const started = harness.runtime.start({ accounts: Array.from({ length: 5 }, (_value, index) => ({
    accountId: `account-${index}`, accountMasked: `a${index}***@example.com`, remark: '', accessToken: `token-${index}`,
  })) });
  await Promise.resolve();
  assert.equal(pending.length, 3);
  pending.splice(0).forEach(({ index, request }) => request.resolve({ success: true, devices: [cloudDevice(`SERIAL_${index}`)] }));
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  pending.splice(0).forEach(({ index, request }) => request.resolve({ success: true, devices: [cloudDevice(`SERIAL_${index}`)] }));
  await started;

  assert.equal(maximum, 3);
  assert.equal(harness.runtime.snapshot().devices.length, 5);
});

test('updates account credentials in place without replacing its masked public label', async () => {
  const harness = createHarness({
    cloudResults: [{ success: true, devices: [cloudDevice('SERIAL_A')] }],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [{
    accountId: 'office', account: 'office@example.com', accountMasked: 'o***@example.com', remark: '', accessToken: 'old-token', username: 'old-user',
  }] });

  harness.runtime.updateAccount({ accountId: 'office', accessToken: 'new-token' });

  assert.equal(harness.connectCalls.at(-1).authToken, 'new-token');
  assert.deepEqual(harness.runtime.getDevice('SERIAL_A').accountLabels, ['o***@example.com']);
  assert.equal(harness.runtime.getDevice('SERIAL_A').displayName, 'Printer SERIAL_A');
  assert.equal(JSON.stringify(harness.runtime.snapshot()).includes('office@example.com'), false);
});

test('invalid duplicate source fails over once and all invalid sources disconnect with safe attention', async () => {
  const invalid = Object.assign(new Error('expired'), { status: 401, tokenInvalid: true });
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('DUPLICATE')] },
      { success: true, devices: [cloudDevice('DUPLICATE')] },
      invalid,
      invalid,
    ],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });
  const initialConnections = harness.connectCalls.length;

  await harness.runtime.refresh({ accountId: 'first', skipLan: true });
  assert.equal(harness.connectCalls.length, initialConnections + 1);
  assert.equal(harness.connectCalls.at(-1).authToken, 'second-token');

  await harness.runtime.refresh({ accountId: 'second', skipLan: true });
  assert.deepEqual(harness.disconnectCalls, ['DUPLICATE']);
  assert.equal(harness.runtime.getDevice('DUPLICATE').connectionState, 'error');
  assert.equal(harness.runtime.getDevice('DUPLICATE').statusSource, 'cloud');
  assert.equal(harness.connectCalls.some((call) => call.authToken === 'first-token' && harness.connectCalls.indexOf(call) >= initialConnections), false);
});

test('waits for a full batch before connecting duplicate sources in insertion order', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness({ cloudResults: [first.promise, second.promise], scanResults: [[]] });
  const started = harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });
  await Promise.resolve();
  second.resolve({ success: true, devices: [cloudDevice('DUPLICATE')] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(harness.connectCalls.length, 0);
  first.resolve({ success: true, devices: [cloudDevice('DUPLICATE')] });
  await started;
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.connectCalls[0].authToken, 'first-token');
});

test('uses a later duplicate access code with cached LAN IP without a transient cloud connect', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness({
    cache: { DUPLICATE: { ip: '192.168.1.88' } },
    cloudResults: [first.promise, second.promise],
    scanResults: [[]],
  });
  const started = harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });
  second.resolve({ success: true, devices: [cloudDevice('DUPLICATE', { accessCode: 'later-code' })] });
  first.resolve({ success: true, devices: [cloudDevice('DUPLICATE', { accessCode: '' })] });
  await started;
  assert.deepEqual(harness.connectCalls, [{ serialNumber: 'DUPLICATE', mode: 'local', ip: '192.168.1.88', accessCode: 'later-code' }]);
});

test('keeps independent account refreshes from cancelling each other', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('FIRST_OLD')] },
      { success: true, devices: [cloudDevice('SECOND_OLD')] },
      first.promise,
      second.promise,
    ],
    scanResults: [[], [], []],
  });
  await harness.runtime.start({ accounts: [
    { accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' },
    { accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' },
  ] });
  const refreshFirst = harness.runtime.refresh({ accountId: 'first', skipLan: true });
  const refreshSecond = harness.runtime.refresh({ accountId: 'second', skipLan: true });
  second.resolve({ success: true, devices: [cloudDevice('SECOND_NEW')] });
  first.resolve({ success: true, devices: [cloudDevice('FIRST_NEW')] });
  await Promise.all([refreshFirst, refreshSecond]);
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['FIRST_NEW', 'SECOND_NEW']);
});

test('rejects an older completion from the same account refresh', async () => {
  const stale = deferred();
  const current = deferred();
  const harness = createHarness({
    cloudResults: [{ success: true, devices: [cloudDevice('OLD')] }, stale.promise, current.promise],
    scanResults: [[], [], []],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' }] });
  const firstRefresh = harness.runtime.refresh({ accountId: 'first', skipLan: true });
  const secondRefresh = harness.runtime.refresh({ accountId: 'first', skipLan: true });
  current.resolve({ success: true, devices: [cloudDevice('CURRENT')] });
  stale.resolve({ success: true, devices: [cloudDevice('STALE')] });
  await Promise.all([firstRefresh, secondRefresh]);
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['CURRENT']);
});

test('removing an account aborts its in-flight refresh without late account or device events', async () => {
  const late = deferred();
  const harness = createHarness({
    cloudResults: [{ success: true, devices: [cloudDevice('SERIAL_A')] }, late.promise],
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' }] });
  const events = [];
  harness.runtime.subscribe((event) => events.push(event));
  const refreshing = harness.runtime.refresh({ accountId: 'first', skipLan: true });
  await Promise.resolve();
  harness.runtime.removeAccount('first');
  const countAfterRemoval = events.length;
  late.resolve({ success: true, devices: [cloudDevice('LATE')] });
  await refreshing;
  assert.equal(events.length, countAfterRemoval);
  assert.deepEqual(harness.runtime.snapshot().devices, []);
});

test('addAccount waits for one owned LAN scan before resolving', async () => {
  const scan = deferred();
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('FIRST')] },
      { success: true, devices: [cloudDevice('SECOND')] },
    ],
    scanResults: [[], scan.promise],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'first-token' }] });
  let settled = false;
  const adding = harness.runtime.addAccount({ accountId: 'second', accountMasked: 's***@example.com', remark: '', accessToken: 'second-token' }).then(() => { settled = true; });
  while (harness.scanCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.scanCalls.length, 2);
  assert.equal(settled, false);
  scan.resolve([]);
  await adding;
  assert.equal(settled, true);
});

test('a credential update followed by refresh restores an invalid account', async () => {
  const invalid = Object.assign(new Error('expired'), { status: 403, tokenInvalid: true });
  const harness = createHarness({
    cloudResults: [invalid, { success: true, devices: [cloudDevice('RECOVERED')] }],
    scanResults: [[], []],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'old-token' }] });
  assert.equal(harness.runtime.getAccountStates()[0].connectionState, 'invalid');
  harness.runtime.updateAccount({ accountId: 'first', accessToken: 'new-token' });
  await harness.runtime.refresh({ accountId: 'first', skipLan: true });
  assert.equal(harness.runtime.getAccountStates()[0].connectionState, 'connected');
  assert.equal(harness.connectCalls.at(-1).authToken, 'new-token');
});

test('credential replacement invalidates a live refresh before its stale completion can mutate', async () => {
  const stale = deferred();
  let staleOptions;
  const harness = createHarness({
    cloudResults: [
      { success: true, username: 'old-user', devices: [cloudDevice('CURRENT')] },
      (_accessToken, options) => { staleOptions = options; return stale.promise; },
      { success: true, username: 'new-user', devices: [cloudDevice('REAUTHENTICATED')] },
    ],
    scanResults: [[], []],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'old-token', username: 'old-user' }] });
  const external = new AbortController();
  const refreshing = harness.runtime.refresh({ accountId: 'first', signal: external.signal, skipLan: true });
  await Promise.resolve();
  harness.runtime.updateAccount({ accountId: 'first', accessToken: 'new-token', username: 'new-user' });
  const afterUpdate = harness.runtime.snapshot();
  const accountStateAfterUpdate = harness.runtime.getAccountStates()[0];
  assert.equal(staleOptions.signal.aborted, true);
  stale.resolve({ success: true, username: 'stale-user', devices: [cloudDevice('STALE')] });
  await refreshing;
  assert.deepEqual(harness.runtime.snapshot(), afterUpdate);
  assert.deepEqual(harness.runtime.getAccountStates()[0], accountStateAfterUpdate);

  await harness.runtime.refresh({ accountId: 'first', skipLan: true });
  assert.deepEqual(harness.runtime.snapshot().devices.map((device) => device.dev_id), ['REAUTHENTICATED']);
  assert.equal(harness.connectCalls.at(-1).authToken, 'new-token');
  assert.equal(harness.connectCalls.at(-1).username, 'new-user');
});

test('coalesces invalid-source disconnect with immediate stop and shutdown', async () => {
  for (const lifecycle of ['stopSession', 'shutdown']) {
    const invalid = Object.assign(new Error('expired'), { status: 401, tokenInvalid: true });
    const disconnecting = deferred();
    const harness = createHarness({
      cloudResults: [{ success: true, devices: [cloudDevice('SERIAL_A')] }, invalid],
      disconnectImpl: () => disconnecting.promise,
      scanResults: [[]],
    });
    await harness.runtime.start({ accessToken: 'token', username: 'user' });
    await harness.runtime.refresh({ skipLan: true });
    const closing = harness.runtime[lifecycle]();
    assert.deepEqual(harness.disconnectCalls, ['SERIAL_A']);
    disconnecting.resolve();
    await closing;
    assert.deepEqual(harness.disconnectCalls, ['SERIAL_A']);
  }
});

test('reauth waits for an active disconnect before connecting the current source once', async () => {
  const invalid = Object.assign(new Error('expired'), { status: 403, tokenInvalid: true });
  const disconnecting = deferred();
  const harness = createHarness({
    cloudResults: [
      { success: true, devices: [cloudDevice('SERIAL_A')] },
      invalid,
      { success: true, devices: [cloudDevice('SERIAL_A')] },
    ],
    disconnectImpl: () => disconnecting.promise,
    scanResults: [[]],
  });
  await harness.runtime.start({ accounts: [{ accountId: 'first', accountMasked: 'f***@example.com', remark: '', accessToken: 'old-token' }] });
  await harness.runtime.refresh({ accountId: 'first', skipLan: true });
  harness.runtime.updateAccount({ accountId: 'first', accessToken: 'new-token' });
  await harness.runtime.refresh({ accountId: 'first', skipLan: true });
  assert.equal(harness.connectCalls.length, 1);
  disconnecting.resolve();
  while (harness.connectCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.connectCalls.length, 2);
  assert.equal(harness.connectCalls.at(-1).authToken, 'new-token');
});
