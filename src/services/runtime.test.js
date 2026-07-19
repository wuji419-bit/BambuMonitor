import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntime, mergeRuntimeDevice, replaceRuntimeSnapshot } from './runtime.js';
import { createElectronRuntime } from './electron.js';

test('runtime factory selects Electron without constructing a Web adapter', () => {
  const electronRuntime = { kind: 'electron' };
  let webCreations = 0;
  const selected = createRuntime({
    isElectron: () => true,
    createElectron: () => electronRuntime,
    createWeb: () => { webCreations += 1; return { kind: 'web' }; },
  });
  assert.equal(selected, electronRuntime);
  assert.equal(webCreations, 0);
});

test('runtime factory selects Web outside Electron', () => {
  const webRuntime = { kind: 'web' };
  const selected = createRuntime({
    isElectron: () => false,
    createElectron: () => ({ kind: 'electron' }),
    createWeb: () => webRuntime,
  });
  assert.equal(selected, webRuntime);
});

test('server snapshots replace the canonical inventory and updates merge one device', () => {
  const current = [{ dev_id: 'A', progress: 10 }, { dev_id: 'removed' }];
  const snapshot = replaceRuntimeSnapshot(current, [{ dev_id: 'A', name: 'A1' }, { dev_id: 'B' }]);
  assert.deepEqual(snapshot, [{ dev_id: 'A', name: 'A1' }, { dev_id: 'B' }]);
  assert.notEqual(snapshot[0], current[0]);

  const merged = mergeRuntimeDevice(snapshot, { dev_id: 'A', progress: 42 });
  assert.deepEqual(merged, [{ dev_id: 'A', name: 'A1', progress: 42 }, { dev_id: 'B' }]);
  assert.deepEqual(mergeRuntimeDevice(merged, { dev_id: 'C', name: 'P1S' }).at(-1), {
    dev_id: 'C', name: 'P1S',
  });
});

test('Electron runtime delegates existing preload APIs without changing result shapes', async () => {
  const previousWindow = globalThis.window;
  const loginResult = { success: true, accessToken: 'desktop-token' };
  const scanResult = [{ dev_id: 'A', ip: '192.168.1.2' }];
  globalThis.window = {
    bambuApi: {
      isElectron: true,
      auth: {
        cloudLogin: async () => loginResult,
      },
      devices: {
        scanPrinters: async () => scanResult,
      },
    },
  };

  try {
    const electron = createElectronRuntime();
    assert.equal(electron.kind, 'electron');
    assert.equal(electron.capabilities.localScan, true);
    assert.equal(await electron.auth.cloudLogin({ account: 'a', password: 'b' }), loginResult);
    assert.equal(await electron.devices.scanPrinters(), scanResult);
    assert.deepEqual(await electron.devices.update('A', { ip: 'printer.local' }), {
      success: false, error: '此功能仅在 NAS 网页版可用', code: 'UNSUPPORTED',
    });
    const off = electron.events.onDeviceSnapshot(() => {});
    assert.equal(typeof off, 'function');
    off();
    assert.equal(typeof electron.events.close, 'function');
    assert.equal(electron.events.close(), undefined);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
