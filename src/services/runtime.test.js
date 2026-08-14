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

test('runtime inventory consistently promotes the account-qualified display name', () => {
  const snapshot = replaceRuntimeSnapshot([], [{
    dev_id: 'A', name: 'A2L01', displayName: 'A2L01（工作室）', accountLabels: ['工作室'],
  }]);
  assert.equal(snapshot[0].name, 'A2L01（工作室）');
  assert.equal(snapshot[0].displayName, 'A2L01（工作室）');

  const updated = mergeRuntimeDevice(snapshot, { dev_id: 'A', progress: 42, name: 'A2L01' });
  assert.equal(updated[0].name, 'A2L01（工作室）');
  assert.equal(updated[0].progress, 42);
  assert.equal(updated[0].baseName, 'A2L01');
});

test('Electron runtime fails closed when the managed account preload is unavailable', async () => {
  const previousWindow = globalThis.window;
  let legacyLoginCalls = 0;
  const scanResult = [{ dev_id: 'A', ip: '192.168.1.2' }];
  globalThis.window = {
    bambuApi: {
      isElectron: true,
      auth: {
        cloudLogin: async () => {
          legacyLoginCalls += 1;
          return { success: true, accessToken: 'desktop-token' };
        },
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
    assert.deepEqual(await electron.auth.cloudLogin({ account: 'a', password: 'b' }), {
      success: false,
      error: '当前桌面版缺少安全账户接口，请更新或重新安装 BambuMonitor',
      code: 'UNSUPPORTED',
    });
    assert.equal(legacyLoginCalls, 0);
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

test('Electron runtime uses managed accounts without exposing credentials to the renderer', async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  let accountsChanged;
  const account = { accountId: 'first', accountMasked: 'f***@example.com', remark: 'Office', label: 'Office' };
  const snapshot = {
    accounts: [account],
    accountStates: [{ accountId: 'first', status: 'connected' }],
    devices: [{ dev_id: 'SERIAL', name: 'A2L01', displayName: 'A2L01（Office）' }],
  };
  globalThis.window = {
    bambuApi: {
      isElectron: true,
      accounts: {
        list: async () => ({ success: true, snapshot }),
        loginPassword: async (payload) => { calls.push(['login', payload]); return { success: true, account, snapshot }; },
        requestVerifyCode: async () => ({ success: true }),
        loginCode: async () => ({ success: true, account, snapshot }),
        updateRemark: async () => ({ success: true, account, snapshot }),
        reauthenticate: async () => ({ success: true, account, snapshot }),
        remove: async () => ({ success: true, removed: account, snapshot: { accounts: [], accountStates: [], devices: [] } }),
        refresh: async (payload) => { calls.push(['refresh', payload]); return { success: true, snapshot }; },
      },
      events: {
        onAccountsChanged(callback) { accountsChanged = callback; return () => { accountsChanged = null; }; },
      },
      mqtt: { connect: async (payload) => { calls.push(['mqtt', payload]); return { success: true }; } },
      devices: { scanPrinters: async () => [] },
    },
  };

  try {
    const electron = createElectronRuntime();
    const login = await electron.auth.cloudLogin({
      account: 'first@example.com', password: 'private-password', remark: 'Office',
    });
    assert.equal(login.success, true);
    assert.deepEqual(login.devices, snapshot.devices);
    assert.equal(JSON.stringify(login).includes('private-password'), false);
    assert.equal(Object.hasOwn(login, 'accessToken'), false);
    assert.deepEqual(calls[0][0], 'login');

    assert.deepEqual(await electron.accounts.list(), {
      success: true,
      accounts: [account],
      states: [{ accountId: 'first', connectionState: 'connected' }],
      devices: snapshot.devices,
    });
    await electron.accounts.refresh('first');
    assert.deepEqual(calls.at(-1), ['refresh', { accountId: 'first' }]);
    const invalid = [];
    const off = electron.events.onAccountInvalid((event) => invalid.push(event));
    accountsChanged?.({
      ...snapshot,
      accountStates: [{ accountId: 'first', status: 'invalid' }],
    });
    assert.deepEqual(invalid, [{
      type: 'account.invalid', accountId: 'first',
      state: { accountId: 'first', connectionState: 'invalid' },
    }]);
    off();

    await electron.mqtt.connect({ serialNumber: 'SERIAL' });
    assert.deepEqual(calls.at(-1), ['mqtt', { serialNumber: 'SERIAL' }]);
    electron.events.close();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
