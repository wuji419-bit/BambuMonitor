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
    listDevices(accessToken) {
      cloudCalls.push(accessToken);
      const result = cloudQueue.shift();
      if (typeof result === 'function') return result(accessToken);
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

  scan.resolve([]);
  await started;
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
  assert.equal(harness.runtime.getDevice('SERIAL_A').ip, '192.168.1.20');
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.connectCalls[0].mode, 'local');

  await harness.runtime.refresh();
  assert.equal(harness.runtime.getDevice('SERIAL_A').ip, '192.168.1.20');
  assert.equal(harness.connectCalls.length, 1);
});

test('401 and 403 emit a credential-free session.invalid while preserving prior devices', async () => {
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
    assert.equal(events.some((event) => event.type === 'session.invalid'), true);
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
      ip: harness.runtime.getDevice('SERIAL_A').ip,
      name: harness.runtime.getDevice('SERIAL_A').name,
      model: harness.runtime.getDevice('SERIAL_A').model,
    },
    { ip: '192.168.1.11', name: 'Discovered A', model: 'X1 Carbon' },
  );
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
  assert.equal(harness.runtime.getDevice('SERIAL_A').ip, '192.168.1.56');
  const update = events.filter((event) => event.type === 'device.updated').at(-1);
  assert.equal(update.device.name, 'Replacement');
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
