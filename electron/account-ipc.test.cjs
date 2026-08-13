const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCOUNT_IPC_CHANNELS,
  registerAccountIpc,
  resolveManagedCameraPayload,
  resolveManagedMqttPayload,
} = require('./account-ipc.cjs');

function createIpcHarness(runtimeOverrides = {}) {
  const handlers = new Map();
  const emitted = [];
  const connectionPlans = [];
  const operationOrder = [];
  const runtime = {
    listAccounts: () => ({ accounts: [], accountStates: [], devices: [] }),
    loginPassword: async () => ({ success: false, error: 'not implemented' }),
    requestVerifyCode: async () => ({ success: false, error: 'not implemented' }),
    loginCode: async () => ({ success: false, error: 'not implemented' }),
    updateRemark: async () => ({ success: false, error: 'not implemented' }),
    reauthenticate: async () => ({ success: false, error: 'not implemented' }),
    removeAccount: async () => ({ success: false, error: 'not implemented' }),
    refreshAccounts: async () => ({ accounts: [], accountStates: [], devices: [] }),
    ...runtimeOverrides,
  };
  registerAccountIpc({
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      },
    },
    getRuntime: () => runtime,
    emit: (channel, payload) => {
      operationOrder.push('emit');
      emitted.push({ channel, payload });
    },
    reconcileConnections: async (plan) => {
      operationOrder.push('reconcile');
      connectionPlans.push(plan);
    },
  });
  return {
    connectionPlans,
    emitted,
    handlers,
    operationOrder,
    invoke: (channel, payload) => handlers.get(channel)({}, payload),
  };
}

test('registers the complete renderer-safe desktop account contract', () => {
  const { handlers } = createIpcHarness();
  assert.deepEqual([...handlers.keys()], [
    ACCOUNT_IPC_CHANNELS.list,
    ACCOUNT_IPC_CHANNELS.loginPassword,
    ACCOUNT_IPC_CHANNELS.requestCode,
    ACCOUNT_IPC_CHANNELS.loginCode,
    ACCOUNT_IPC_CHANNELS.updateRemark,
    ACCOUNT_IPC_CHANNELS.reauthenticate,
    ACCOUNT_IPC_CHANNELS.remove,
    ACCOUNT_IPC_CHANNELS.refresh,
  ]);
});

test('reconciles changed and removed private connection sources before publishing the snapshot', async () => {
  let fingerprints = { SERIAL: 'old', REMOVED: 'removed' };
  const snapshot = { accounts: [], accountStates: [], devices: [] };
  const harness = createIpcHarness({
    getConnectionFingerprints: () => ({ ...fingerprints }),
    async reauthenticate() {
      fingerprints = { SERIAL: 'new', ADDED: 'added' };
      return { success: true, snapshot };
    },
  });

  await harness.invoke(ACCOUNT_IPC_CHANNELS.reauthenticate, { accountId: 'account-1' });

  assert.deepEqual(harness.connectionPlans, [{
    disconnectSerials: ['REMOVED', 'SERIAL'],
    reconnectSerials: ['SERIAL'],
  }]);
  assert.deepEqual(harness.operationOrder, ['reconcile', 'emit']);
  assert.equal(harness.emitted.length, 1);
});

test('projects malicious runtime results to public account and device fields', async () => {
  const privateSnapshot = {
    accounts: [{
      accountId: 'account-1',
      accountMasked: 'm***@example.com',
      remark: 'Studio',
      label: 'Studio',
      savedAt: 10,
      updatedAt: 20,
      accessToken: 'leaked-token',
    }],
    accountStates: [{
      accountId: 'account-1', status: 'connected', accessToken: 'leaked-state-token',
    }, { accountId: 'leaked-token-id', status: 'connected' }],
    devices: [{
      dev_id: 'SERIAL',
      name: 'P1S',
      displayName: 'P1S（Studio）',
      accountIds: ['account-1', 'leaked-token-id'],
      accountLabels: ['Studio', 'leaked-token-label'],
      accessCode: 'leaked-code',
      ip: '192.168.1.50',
    }],
  };
  const harness = createIpcHarness({ listAccounts: () => privateSnapshot });

  const result = await harness.invoke(ACCOUNT_IPC_CHANNELS.list);

  assert.equal(result.success, true);
  assert.equal(result.snapshot.accounts[0].label, 'Studio');
  assert.equal(result.snapshot.accountStates[0].status, 'connected');
  assert.equal(result.snapshot.devices[0].displayName, 'P1S（Studio）');
  assert.deepEqual(result.snapshot.devices[0].accountIds, ['account-1']);
  assert.deepEqual(result.snapshot.devices[0].accountLabels, ['Studio']);
  assert.equal(JSON.stringify(result).includes('leaked-token'), false);
  assert.equal(JSON.stringify(result).includes('leaked-state-token'), false);
  assert.equal(JSON.stringify(result).includes('leaked-code'), false);
  assert.equal(JSON.stringify(result).includes('192.168.1.50'), false);
  assert.equal(JSON.stringify(result).includes('leaked-token-id'), false);
  assert.equal(JSON.stringify(result).includes('leaked-token-label'), false);
});

test('routes account mutations and emits only the projected snapshot', async () => {
  const calls = [];
  const snapshot = {
    accounts: [],
    accountStates: [],
    devices: [{ dev_id: 'SERIAL', name: 'P1S', accessCode: 'private-code' }],
  };
  const harness = createIpcHarness({
    async loginPassword(payload) {
      calls.push(['loginPassword', payload]);
      return { success: true, snapshot, accessToken: 'private-token' };
    },
    async updateRemark(accountId, remark) {
      calls.push(['updateRemark', accountId, remark]);
      return { success: true, snapshot };
    },
    async removeAccount(accountId) {
      calls.push(['removeAccount', accountId]);
      return { success: true, snapshot };
    },
    async refreshAccounts(options) {
      calls.push(['refreshAccounts', options]);
      return snapshot;
    },
  });

  const login = await harness.invoke(ACCOUNT_IPC_CHANNELS.loginPassword, {
    account: 'maker@example.com', password: 'secret', remark: '',
  });
  await harness.invoke(ACCOUNT_IPC_CHANNELS.updateRemark, { accountId: 'account-1', remark: 'Home' });
  await harness.invoke(ACCOUNT_IPC_CHANNELS.remove, { accountId: 'account-1' });
  await harness.invoke(ACCOUNT_IPC_CHANNELS.refresh, { accountId: 'account-2' });

  assert.deepEqual(calls, [
    ['loginPassword', { account: 'maker@example.com', password: 'secret', remark: '' }],
    ['updateRemark', 'account-1', 'Home'],
    ['removeAccount', 'account-1'],
    ['refreshAccounts', { accountId: 'account-2' }],
  ]);
  assert.equal(JSON.stringify(login).includes('private-token'), false);
  assert.equal(JSON.stringify(login).includes('private-code'), false);
  assert.equal(harness.emitted.length, 4);
  assert.equal(harness.emitted.every(({ channel }) => channel === 'accounts-changed'), true);
  assert.equal(JSON.stringify(harness.emitted).includes('private-code'), false);
});

test('resolves serial-only MQTT and camera payloads while retaining legacy explicit credentials', () => {
  const calls = [];
  let runtimeReads = 0;
  const runtime = {
    resolveMqttPayload(payload) {
      calls.push(['mqtt', payload]);
      return {
        serialNumber: 'SERIAL', mode: 'cloud', region: 'China', authToken: 'private-token', username: 'user',
      };
    },
    resolveCameraPayload(payload) {
      calls.push(['camera', payload]);
      return {
        serialNumber: 'SERIAL', ip: '192.168.1.50', accessCode: 'private-code', name: 'P1S',
      };
    },
  };
  const getRuntime = () => {
    runtimeReads += 1;
    return runtime;
  };

  assert.equal(resolveManagedMqttPayload(getRuntime, { serialNumber: 'serial' }).authToken, 'private-token');
  assert.equal(resolveManagedCameraPayload(getRuntime, { serialNumber: 'serial' }).accessCode, 'private-code');
  assert.deepEqual(calls, [
    ['mqtt', { serialNumber: 'serial' }],
    ['camera', { serialNumber: 'serial' }],
  ]);

  const legacyMqtt = { serialNumber: 'SERIAL', mode: 'local', ip: '10.0.0.2', accessCode: 'legacy-code' };
  const legacyCamera = { serialNumber: 'SERIAL', ip: '10.0.0.2', accessCode: 'legacy-code' };
  assert.deepEqual(resolveManagedMqttPayload(getRuntime, legacyMqtt), legacyMqtt);
  assert.deepEqual(resolveManagedCameraPayload(getRuntime, legacyCamera), legacyCamera);
  assert.notEqual(resolveManagedMqttPayload(getRuntime, legacyMqtt), legacyMqtt);
  assert.notEqual(resolveManagedCameraPayload(getRuntime, legacyCamera), legacyCamera);
  assert.deepEqual(resolveManagedMqttPayload(getRuntime, {}), {});
  assert.deepEqual(resolveManagedCameraPayload(getRuntime, {}), {});
  assert.equal(runtimeReads, 2);
});
