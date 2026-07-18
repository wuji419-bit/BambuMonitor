const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildMqttConnectionOptions } = require('./mqtt-options.cjs');
const { createMqttConnectionManager } = require('./mqtt-connection-manager.cjs');

class FakeMqttClient extends EventEmitter {
  constructor() {
    super();
    this.subscribeCalls = [];
    this.subscribeCallbacks = [];
    this.publishCalls = [];
    this.endCalls = [];
  }

  subscribe(topic, callback) {
    this.subscribeCalls.push(topic);
    this.subscribeCallbacks.push(callback);
  }

  completeSubscribe(error = null) {
    const callback = this.subscribeCallbacks.shift();
    assert.ok(callback, 'expected a pending subscribe callback');
    callback(error);
  }

  publish(topic, payload) {
    this.publishCalls.push({ topic, payload });
  }

  end(...args) {
    this.endCalls.push(args);
  }
}

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map();

  return {
    setTimeout(callback, delay) {
      const handle = {
        id: nextId++,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      scheduled.set(handle.id, { callback, delay, handle });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) scheduled.delete(handle.id);
    },
    count(delay) {
      return Array.from(scheduled.values())
        .filter((timer) => delay === undefined || timer.delay === delay)
        .length;
    },
    runOne(delay) {
      const timer = Array.from(scheduled.values()).find((candidate) => candidate.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      scheduled.delete(timer.handle.id);
      timer.callback();
    },
    runAll(delay) {
      const timers = Array.from(scheduled.values())
        .filter((timer) => delay === undefined || timer.delay === delay);
      for (const timer of timers) {
        scheduled.delete(timer.handle.id);
        timer.callback();
      }
    },
  };
}

function createHarness({
  buildConnectionOptions = buildMqttConnectionOptions,
  connectTimeoutMs = 15000,
  reconnectGraceMs = 45000,
} = {}) {
  const clients = [];
  const connectionCalls = [];
  const events = [];
  const logs = [];
  const timers = createManualTimers();
  const logger = {};

  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => logs.push({ level, args });
  }

  const manager = createMqttConnectionManager({
    connectImpl(url, options) {
      const client = new FakeMqttClient();
      clients.push(client);
      connectionCalls.push({ url, options, client });
      return client;
    },
    buildConnectionOptions,
    emit: (event, payload) => events.push({ event, payload }),
    logger,
    connectTimeoutMs,
    reconnectGraceMs,
    timers,
  });

  return {
    clients,
    connectionCalls,
    events,
    logs,
    manager,
    timers,
  };
}

async function connectReady(harness, payload) {
  const pending = harness.manager.connect(payload);
  const client = harness.clients.at(-1);
  assert.ok(client, 'expected connectImpl to create a client');
  client.emit('connect');
  client.completeSubscribe();
  return { client, result: await pending };
}

test('reuses one client for the same serial and effective connection fingerprint', async () => {
  const harness = createHarness();
  const payload = {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'local-secret',
  };

  const firstPending = harness.manager.connect(payload);
  const firstClient = harness.clients[0];
  const secondPending = harness.manager.connect({ ...payload });
  assert.equal(harness.clients.length, 1);
  firstClient.emit('connect');
  firstClient.completeSubscribe();
  const [first, second] = await Promise.all([firstPending, secondPending]);

  assert.deepEqual(first, {
    success: true,
    serialNumber: 'SERIAL_A',
    reused: false,
  });
  assert.deepEqual(second, {
    success: true,
    serialNumber: 'SERIAL_A',
    reused: true,
  });
  assert.equal(harness.clients.length, 1);
  assert.equal(harness.manager.size, 1);
  assert.equal(harness.manager.has('SERIAL_A'), true);
  assert.deepEqual(harness.connectionCalls[0].options, {
    username: 'bblp',
    password: 'local-secret',
    rejectUnauthorized: false,
    connectTimeout: 15000,
    reconnectPeriod: 5000,
    resubscribe: true,
  });
  assert.deepEqual(firstClient.subscribeCalls, ['device/SERIAL_A/report']);
  assert.equal(firstClient.publishCalls.length, 1);
  assert.equal(firstClient.publishCalls[0].topic, 'device/SERIAL_A/request');
  assert.deepEqual(JSON.parse(firstClient.publishCalls[0].payload), {
    pushing: {
      sequence_id: '0',
      command: 'pushall',
    },
  });
});

test('changed mode, IP, access code, token, or cloud username replaces only that serial', async () => {
  const harness = createHarness();
  const firstA = await connectReady(harness, {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  const printerB = await connectReady(harness, {
    serialNumber: 'SERIAL_B',
    ip: '192.168.1.30',
    accessCode: 'code-b',
  });
  const staleClients = [firstA.client];
  let previous = firstA.client;
  const replacements = [
    { serialNumber: 'SERIAL_A', ip: '192.168.1.21', accessCode: 'code-a' },
    { serialNumber: 'SERIAL_A', ip: '192.168.1.21', accessCode: 'code-c' },
    {
      serialNumber: 'SERIAL_A',
      mode: 'cloud',
      region: 'Global',
      authToken: 'cloud-token-a',
      username: 'u_cloud_a',
    },
    {
      serialNumber: 'SERIAL_A',
      mode: 'cloud',
      region: 'Global',
      authToken: 'cloud-token-b',
      username: 'u_cloud_a',
    },
    {
      serialNumber: 'SERIAL_A',
      mode: 'cloud',
      region: 'Global',
      authToken: 'cloud-token-b',
      username: 'u_cloud_b',
    },
  ];

  for (const replacement of replacements) {
    const next = await connectReady(harness, replacement);
    assert.equal(previous.endCalls.length, 1);
    assert.equal(printerB.client.endCalls.length, 0);
    assert.equal(harness.manager.size, 2);
    assert.equal(harness.manager.has('SERIAL_A'), true);
    assert.equal(harness.manager.has('SERIAL_B'), true);
    staleClients.push(previous);
    previous = next.client;
  }

  harness.events.length = 0;
  for (const stale of new Set(staleClients)) {
    stale.emit('message', 'ignored', Buffer.from('{"print":{"mc_percent":99}}'));
    stale.emit('reconnect');
    stale.emit('offline');
    stale.emit('close');
    stale.emit('connect');
  }
  assert.deepEqual(harness.events, []);

  previous.emit('message', 'report', Buffer.from('{"print":{"mc_percent":42}}'));
  assert.deepEqual(harness.events, [{
    event: 'message',
    payload: {
      serialNumber: 'SERIAL_A',
      payload: { print: { mc_percent: 42 } },
    },
  }]);
});

test('TLS verification fingerprint distinguishes undefined, false, and true effective values', async () => {
  const harness = createHarness({
    buildConnectionOptions(payload) {
      const options = {
        username: 'same-user',
        password: 'same-password',
      };
      if (Object.hasOwn(payload, 'rejectUnauthorized')) {
        options.rejectUnauthorized = payload.rejectUnauthorized;
      }
      return {
        serialNumber: payload.serialNumber,
        mode: 'custom',
        url: 'mqtts://same-host.test:8883',
        options,
      };
    },
  });

  const omitted = await connectReady(harness, { serialNumber: 'SERIAL_TLS' });
  assert.equal(harness.connectionCalls[0].options.rejectUnauthorized, undefined);

  const disabledPending = harness.manager.connect({
    serialNumber: 'SERIAL_TLS',
    rejectUnauthorized: false,
  });
  assert.equal(harness.clients.length, 2);
  const disabledClient = harness.clients[1];
  disabledClient.emit('connect');
  disabledClient.completeSubscribe();
  assert.deepEqual(await disabledPending, {
    success: true,
    serialNumber: 'SERIAL_TLS',
    reused: false,
  });
  assert.equal(omitted.client.endCalls.length, 1);
  assert.equal(harness.connectionCalls[1].options.rejectUnauthorized, false);

  assert.deepEqual(await harness.manager.connect({
    serialNumber: 'SERIAL_TLS',
    rejectUnauthorized: false,
  }), {
    success: true,
    serialNumber: 'SERIAL_TLS',
    reused: true,
  });
  assert.equal(harness.clients.length, 2);

  const enabledPending = harness.manager.connect({
    serialNumber: 'SERIAL_TLS',
    rejectUnauthorized: true,
  });
  assert.equal(harness.clients.length, 3);
  const enabledClient = harness.clients[2];
  enabledClient.emit('connect');
  enabledClient.completeSubscribe();
  assert.deepEqual(await enabledPending, {
    success: true,
    serialNumber: 'SERIAL_TLS',
    reused: false,
  });
  assert.equal(disabledClient.endCalls.length, 1);
  assert.equal(harness.connectionCalls[2].options.rejectUnauthorized, true);

  assert.deepEqual(await harness.manager.connect({
    serialNumber: 'SERIAL_TLS',
    rejectUnauthorized: true,
  }), {
    success: true,
    serialNumber: 'SERIAL_TLS',
    reused: true,
  });
  assert.equal(harness.clients.length, 3);
});

test('emits current renderer payload shapes and ignores malformed JSON', async () => {
  const harness = createHarness();
  const { client } = await connectReady(harness, {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });

  client.emit('message', 'report', Buffer.from('{"print":{"gcode_state":"RUNNING"}}'));
  assert.doesNotThrow(() => {
    client.emit('message', 'report', Buffer.from('{not-json'));
  });
  client.emit('reconnect');
  client.emit('offline');
  client.emit('close');
  harness.timers.runOne(45000);

  assert.deepEqual(harness.events, [
    { event: 'connected', payload: { serialNumber: 'SERIAL_A' } },
    {
      event: 'message',
      payload: {
        serialNumber: 'SERIAL_A',
        payload: { print: { gcode_state: 'RUNNING' } },
      },
    },
    { event: 'reconnecting', payload: { serialNumber: 'SERIAL_A' } },
    { event: 'reconnecting', payload: { serialNumber: 'SERIAL_A' } },
    { event: 'reconnecting', payload: { serialNumber: 'SERIAL_A' } },
    { event: 'disconnected', payload: { serialNumber: 'SERIAL_A' } },
  ]);
});

test('reconnect, offline, and close share one grace timer that reconnect cancels', async () => {
  const harness = createHarness();
  const { client } = await connectReady(harness, {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  harness.events.length = 0;

  client.emit('reconnect');
  client.emit('offline');
  client.emit('close');
  assert.equal(harness.timers.count(45000), 1);

  client.emit('connect');
  client.completeSubscribe();
  assert.equal(harness.timers.count(45000), 0);
  harness.timers.runAll(45000);
  assert.equal(harness.events.some(({ event }) => event === 'disconnected'), false);

  client.emit('close');
  assert.equal(harness.timers.count(45000), 1);
  harness.timers.runOne(45000);
  assert.equal(harness.events.at(-1).event, 'disconnected');
});

test('initial timeout settles once, removes the entry, clears timers, and closes the client', async () => {
  const harness = createHarness({ connectTimeoutMs: 1200 });
  const pending = harness.manager.connect({
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  const client = harness.clients[0];

  harness.timers.runOne(1200);
  await assert.rejects(pending, /timeout/i);
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.timers.count(), 0);
  assert.equal(client.endCalls.length, 1);

  client.emit('error', new Error('late error'));
  client.emit('connect');
  assert.equal(client.endCalls.length, 1);
  assert.deepEqual(harness.events, []);
});

test('initial error settles once and performs the same complete cleanup', async () => {
  const harness = createHarness();
  const pending = harness.manager.connect({
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  const client = harness.clients[0];

  client.emit('error', new Error('broker refused connection'));
  await assert.rejects(pending, /MQTT/i);
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.timers.count(), 0);
  assert.equal(client.endCalls.length, 1);

  client.emit('error', new Error('late error'));
  assert.equal(client.endCalls.length, 1);
  assert.deepEqual(harness.events, []);
});

test('disconnect closes one client, clears timers, and suppresses stale intentional events', async () => {
  const harness = createHarness();
  const { client } = await connectReady(harness, {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  client.emit('close');
  assert.equal(harness.timers.count(45000), 1);
  harness.events.length = 0;

  assert.deepEqual(await harness.manager.disconnect('SERIAL_A'), { success: true });
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.timers.count(), 0);
  assert.equal(client.endCalls.length, 1);

  client.emit('reconnect');
  client.emit('offline');
  client.emit('close');
  client.emit('connect');
  assert.deepEqual(harness.events, []);
  assert.deepEqual(await harness.manager.disconnect('SERIAL_A'), { success: true });

  const pendingConnect = harness.manager.connect({
    serialNumber: 'SERIAL_PENDING',
    ip: '192.168.1.21',
    accessCode: 'code-pending',
  });
  const pendingOutcome = pendingConnect.catch((error) => error.message);
  const pendingClient = harness.clients.at(-1);
  assert.equal(harness.timers.count(15000), 1);
  assert.deepEqual(await harness.manager.disconnect('SERIAL_PENDING'), { success: true });
  assert.match(await pendingOutcome, /cancelled/i);
  assert.equal(harness.timers.count(), 0);
  assert.equal(pendingClient.endCalls.length, 1);
  assert.equal(harness.manager.size, 0);
});

test('shutdown clears connect and grace timers, closes all clients, and is idempotent', async () => {
  const harness = createHarness();
  const ready = await connectReady(harness, {
    serialNumber: 'SERIAL_A',
    ip: '192.168.1.20',
    accessCode: 'code-a',
  });
  ready.client.emit('close');

  const pendingConnect = harness.manager.connect({
    serialNumber: 'SERIAL_B',
    ip: '192.168.1.30',
    accessCode: 'code-b',
  });
  const pendingOutcome = pendingConnect.then(
    () => 'resolved',
    (error) => error.message,
  );
  const pendingClient = harness.clients.at(-1);
  assert.equal(harness.timers.count(), 2);
  harness.events.length = 0;

  assert.deepEqual(await harness.manager.shutdown(), { success: true });
  assert.match(await pendingOutcome, /cancelled/i);
  assert.equal(harness.manager.size, 0);
  assert.equal(harness.timers.count(), 0);
  assert.equal(ready.client.endCalls.length, 1);
  assert.equal(pendingClient.endCalls.length, 1);

  pendingClient.emit('reconnect');
  ready.client.emit('close');
  assert.deepEqual(harness.events, []);

  assert.deepEqual(await harness.manager.shutdown(), { success: true });
  assert.equal(ready.client.endCalls.length, 1);
  assert.equal(pendingClient.endCalls.length, 1);
});

test('events, logs, results, and failures never expose credentials or credential URLs', async () => {
  const buildConnectionOptions = (payload) => ({
    serialNumber: payload.serialNumber,
    mode: 'cloud',
    url: 'mqtts://url-user:url-password@example.test:8883',
    options: {
      username: payload.username,
      password: payload.authToken,
      rejectUnauthorized: true,
    },
  });
  const harness = createHarness({ buildConnectionOptions });
  const payload = {
    serialNumber: 'SERIAL_SECRET',
    username: 'u_secret',
    authToken: 'token-secret',
    accessCode: 'access-secret',
  };
  const success = await connectReady(harness, payload);
  assert.deepEqual(Object.keys(success.result).sort(), ['reused', 'serialNumber', 'success']);

  const failed = harness.manager.connect({ ...payload, authToken: 'password-secret' });
  const failedClient = harness.clients.at(-1);
  failedClient.emit('error', new Error(
    'failed mqtts://url-user:url-password@example.test:8883 token-secret access-secret password-secret',
  ));
  const failure = await failed.catch((error) => error);
  const configFailureHarness = createHarness({
    buildConnectionOptions(input) {
      throw new Error(
        `invalid ${input.authToken} ${input.accessCode} mqtts://url-user:url-password@example.test:8883`,
      );
    },
  });
  const configFailure = await configFailureHarness.manager.connect(payload)
    .catch((error) => error);
  const publicOutput = JSON.stringify({
    events: harness.events,
    logs: harness.logs,
    result: success.result,
    failure: failure.message,
    configFailure: configFailure.message,
  });

  for (const secret of [
    'url-password',
    'token-secret',
    'access-secret',
    'password-secret',
    'mqtts://url-user:url-password@example.test:8883',
  ]) {
    assert.equal(publicOutput.includes(secret), false, `leaked ${secret}`);
  }
});
