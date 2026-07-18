import test from 'node:test';
import assert from 'node:assert/strict';

import { BambuClient } from './bambu.js';

function installRejectingMqttApi() {
  const previousWindow = globalThis.window;
  globalThis.window = {
    bambuApi: {
      isElectron: true,
      mqtt: {
        disconnect: async () => { throw new Error('serial disconnect failed'); },
        disconnectAll: async () => { throw new Error('disconnect all failed'); },
      },
    },
  };
  return () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  };
}

function seedClient(serials) {
  const client = new BambuClient();
  for (const serial of serials) {
    client.printers.set(serial, { dev_id: serial });
    client.callbacks.set(serial, () => {});
  }
  client.globalUpdateCallback = () => {};
  client.ensureCountdownTimer();
  return client;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installDeferredMqttApi() {
  const previousWindow = globalThis.window;
  const connectCalls = [];
  const disconnectCalls = [];
  const disconnectAllCalls = [];
  const listeners = {};
  globalThis.window = {
    bambuApi: {
      isElectron: true,
      mqtt: {
        connect(payload) {
          const deferred = createDeferred();
          connectCalls.push({ ...deferred, payload });
          return deferred.promise;
        },
        disconnect(payload) {
          const deferred = createDeferred();
          disconnectCalls.push({ ...deferred, payload });
          return deferred.promise;
        },
        disconnectAll() {
          const deferred = createDeferred();
          disconnectAllCalls.push(deferred);
          return deferred.promise;
        },
      },
      events: {
        onMqttData(callback) {
          listeners.data = callback;
          return () => {};
        },
        onMqttConnected(callback) {
          listeners.connected = callback;
          return () => {};
        },
        onMqttReconnecting(callback) {
          listeners.reconnecting = callback;
          return () => {};
        },
        onMqttDisconnected(callback) {
          listeners.disconnected = callback;
          return () => {};
        },
      },
    },
  };

  return {
    connectCalls,
    disconnectCalls,
    disconnectAllCalls,
    emitReconnecting(serialNumber) {
      listeners.reconnecting({ serialNumber });
    },
    emitTelemetry(serialNumber, payload) {
      listeners.data({ serialNumber, payload });
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test('disconnect all clears local mqtt state when IPC rejects', async () => {
  const restoreWindow = installRejectingMqttApi();
  const client = seedClient(['one', 'two']);

  try {
    await assert.rejects(client.disconnect(), /disconnect all failed/);
    assert.equal(client.printers.size, 0);
    assert.equal(client.callbacks.size, 0);
    assert.equal(client.globalUpdateCallback, null);
    assert.equal(client.countdownTimer, null);
  } finally {
    client.stopCountdownTimer();
    restoreWindow();
  }
});

test('single disconnect clears its local state when IPC rejects', async () => {
  const restoreWindow = installRejectingMqttApi();
  const client = seedClient(['one']);

  try {
    await assert.rejects(client.disconnect('one'), /serial disconnect failed/);
    assert.equal(client.printers.has('one'), false);
    assert.equal(client.callbacks.has('one'), false);
    assert.equal(client.countdownTimer, null);
  } finally {
    client.stopCountdownTimer();
    restoreWindow();
  }
});

test('pending single disconnect cannot delete a newer successful connection', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();
  const oldUpdates = [];
  const newUpdates = [];
  const oldCallback = (printer) => oldUpdates.push(printer);
  const newCallback = (printer) => newUpdates.push(printer);

  try {
    const initial = client.connectLocal(
      '192.168.1.20',
      'code-a',
      'SERIAL_A',
      oldCallback,
    );
    mqtt.connectCalls[0].resolve({ success: true, serialNumber: 'SERIAL_A' });
    await initial;

    const pendingDisconnect = client.disconnect('SERIAL_A');
    assert.equal(mqtt.disconnectCalls.length, 1);

    const newerConnect = client.connectLocal(
      '192.168.1.21',
      'code-b',
      'SERIAL_A',
      newCallback,
      'New printer',
    );
    mqtt.connectCalls[1].resolve({ success: true, serialNumber: 'SERIAL_A' });
    await newerConnect;
    const newerPrinter = client.printers.get('SERIAL_A');
    newUpdates.length = 0;

    mqtt.disconnectCalls[0].resolve({ success: true });
    await pendingDisconnect;

    assert.equal(client.printers.get('SERIAL_A'), newerPrinter);
    assert.equal(client.printers.get('SERIAL_A').ip, '192.168.1.21');
    assert.equal(client.callbacks.get('SERIAL_A'), newCallback);
    assert.notEqual(client.countdownTimer, null);
    client.emitUpdate('SERIAL_A');
    assert.equal(newUpdates.length, 1);
    assert.equal(oldUpdates.at(-1)?.ip, '192.168.1.20');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('pending disconnect all preserves a newer connection and callback generations', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();
  const newUpdates = [];
  const globalUpdates = [];
  const newCallback = (printer) => newUpdates.push(printer);
  const newGlobalCallback = (printer) => globalUpdates.push(printer);

  try {
    const initial = client.connectLocal(
      '192.168.1.20',
      'code-a',
      'SERIAL_A',
      () => {},
    );
    mqtt.connectCalls[0].resolve({ success: true, serialNumber: 'SERIAL_A' });
    await initial;
    client.setGlobalUpdateCallback(() => {});

    const pendingDisconnect = client.disconnect();
    assert.equal(mqtt.disconnectAllCalls.length, 1);

    const newerConnect = client.connectLocal(
      '192.168.1.22',
      'code-c',
      'SERIAL_A',
      newCallback,
      'Replacement printer',
    );
    mqtt.connectCalls[1].resolve({ success: true, serialNumber: 'SERIAL_A' });
    await newerConnect;
    client.setGlobalUpdateCallback(newGlobalCallback);
    const newerPrinter = client.printers.get('SERIAL_A');
    newUpdates.length = 0;
    globalUpdates.length = 0;

    mqtt.disconnectAllCalls[0].resolve({ success: true });
    await pendingDisconnect;

    assert.equal(client.printers.get('SERIAL_A'), newerPrinter);
    assert.equal(client.callbacks.get('SERIAL_A'), newCallback);
    assert.equal(client.globalUpdateCallback, newGlobalCallback);
    assert.notEqual(client.countdownTimer, null);

    client.handleMessage('SERIAL_A', {
      print: { gcode_state: 'RUNNING', mc_percent: 29 },
    });
    assert.equal(newUpdates.length, 1);
    assert.equal(newUpdates[0].progress, 29);
    assert.equal(globalUpdates.length, 1);
    assert.equal(globalUpdates[0].progress, 29);
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('single disconnect cleans owned state when deferred IPC resolves without a newer connect', async () => {
  const mqtt = installDeferredMqttApi();
  const client = seedClient(['one']);

  try {
    const pending = client.disconnect('one');
    mqtt.disconnectCalls[0].resolve({ success: true });
    await pending;

    assert.equal(client.printers.has('one'), false);
    assert.equal(client.callbacks.has('one'), false);
    assert.equal(client.countdownTimer, null);
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('disconnect all cleans owned state when deferred IPC resolves without a newer connect', async () => {
  const mqtt = installDeferredMqttApi();
  const client = seedClient(['one', 'two']);

  try {
    const pending = client.disconnect();
    mqtt.disconnectAllCalls[0].resolve({ success: true });
    await pending;

    assert.equal(client.printers.size, 0);
    assert.equal(client.callbacks.size, 0);
    assert.equal(client.globalUpdateCallback, null);
    assert.equal(client.countdownTimer, null);
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('local connect success merges into telemetry that arrived while IPC was pending', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();

  try {
    const pending = client.connectLocal('192.168.1.20', 'code-a', 'SERIAL_A', () => {});
    mqtt.emitTelemetry('SERIAL_A', {
      print: {
        gcode_state: 'RUNNING',
        mc_percent: 42,
        nozzle_temper: 215.6,
      },
    });
    mqtt.emitReconnecting('SERIAL_A');
    const telemetryState = client.printers.get('SERIAL_A');

    mqtt.connectCalls[0].resolve({ success: true, serialNumber: 'SERIAL_A' });
    assert.equal(await pending, true);

    const stored = client.printers.get('SERIAL_A');
    assert.notEqual(stored, telemetryState);
    assert.equal(stored.progress, 42);
    assert.equal(stored.temperature.nozzle, 216);
    assert.equal(stored.status, 'printing');
    assert.equal(stored.connectionState, 'online');
    assert.equal(stored.errorMsg, '');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('local connect rejection preserves telemetry while immutably applying error state', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();

  try {
    const pending = client.connectLocal('192.168.1.20', 'code-a', 'SERIAL_A', () => {});
    mqtt.emitTelemetry('SERIAL_A', {
      print: { gcode_state: 'RUNNING', mc_percent: 37 },
    });
    const telemetryState = client.printers.get('SERIAL_A');

    mqtt.connectCalls[0].reject(new Error('local connect failed'));
    await assert.rejects(pending, /local connect failed/);

    const stored = client.printers.get('SERIAL_A');
    assert.notEqual(stored, telemetryState);
    assert.equal(stored.progress, 37);
    assert.equal(stored.jobStatus, 'printing');
    assert.equal(stored.status, 'error');
    assert.equal(stored.connectionState, 'error');
    assert.equal(stored.errorMsg, 'local connect failed');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('cloud connect success merges into telemetry that arrived while IPC was pending', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();

  try {
    const pending = client.connectCloud({
      authToken: 'token-a',
      username: 'u_a',
      serialNumber: 'SERIAL_A',
      onUpdate: () => {},
    });
    mqtt.emitTelemetry('SERIAL_A', {
      print: { gcode_state: 'RUNNING', mc_percent: 58 },
    });
    mqtt.emitReconnecting('SERIAL_A');
    const telemetryState = client.printers.get('SERIAL_A');

    mqtt.connectCalls[0].resolve({ success: true, serialNumber: 'SERIAL_A' });
    assert.equal(await pending, true);

    const stored = client.printers.get('SERIAL_A');
    assert.notEqual(stored, telemetryState);
    assert.equal(stored.progress, 58);
    assert.equal(stored.status, 'printing');
    assert.equal(stored.connectionState, 'online');
    assert.equal(stored.statusSource, 'cloud');
    assert.equal(stored.errorMsg, '');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('cloud connect rejection preserves telemetry while immutably applying error state', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();

  try {
    const pending = client.connectCloud({
      authToken: 'token-a',
      username: 'u_a',
      serialNumber: 'SERIAL_A',
      onUpdate: () => {},
    });
    mqtt.emitTelemetry('SERIAL_A', {
      print: { gcode_state: 'RUNNING', mc_percent: 63 },
    });
    const telemetryState = client.printers.get('SERIAL_A');

    mqtt.connectCalls[0].reject(new Error('cloud connect failed'));
    await assert.rejects(pending, /cloud connect failed/);

    const stored = client.printers.get('SERIAL_A');
    assert.notEqual(stored, telemetryState);
    assert.equal(stored.progress, 63);
    assert.equal(stored.jobStatus, 'printing');
    assert.equal(stored.status, 'error');
    assert.equal(stored.connectionState, 'error');
    assert.equal(stored.statusSource, 'cloud');
    assert.equal(stored.errorMsg, 'cloud connect failed');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});

test('older connect completion cannot overwrite a newer attempt for the same serial', async () => {
  const mqtt = installDeferredMqttApi();
  const client = new BambuClient();

  try {
    const older = client.connectLocal('192.168.1.20', 'code-a', 'SERIAL_A', () => {});
    const olderOutcome = older.catch((error) => error);
    const newer = client.connectLocal('192.168.1.21', 'code-b', 'SERIAL_A', () => {});
    mqtt.emitTelemetry('SERIAL_A', {
      print: { gcode_state: 'RUNNING', mc_percent: 77 },
    });
    mqtt.emitReconnecting('SERIAL_A');

    mqtt.connectCalls[1].resolve({ success: true, serialNumber: 'SERIAL_A' });
    assert.equal(await newer, true);
    const newerState = client.printers.get('SERIAL_A');
    assert.equal(newerState.ip, '192.168.1.21');
    assert.equal(newerState.progress, 77);
    assert.equal(newerState.connectionState, 'online');

    mqtt.connectCalls[0].reject(new Error('older attempt failed'));
    assert.match((await olderOutcome).message, /older attempt failed/);
    assert.equal(client.printers.get('SERIAL_A'), newerState);
    assert.equal(client.printers.get('SERIAL_A').connectionState, 'online');
  } finally {
    client.stopCountdownTimer();
    mqtt.restore();
  }
});
