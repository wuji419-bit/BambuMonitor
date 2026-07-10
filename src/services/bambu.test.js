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
