const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountStore } = require('./account-store.cjs');
const { createAccountRuntime } = require('./account-runtime.cjs');

function createStore(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-account-runtime-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  let nextId = 0;
  return createAccountStore({
    userDataPath,
    randomId: () => `account-${nextId += 1}`,
    now: () => 100,
  });
}

test('desktop refresh returns one safe device and resolves local MQTT and camera data privately', async (t) => {
  const store = createStore(t);
  store.addAccount({
    account: 'first@example.com',
    accessToken: 'token-a',
    username: 'user-a',
    remark: 'Company',
  });
  store.addAccount({
    account: 'second@example.com',
    accessToken: 'token-b',
    username: 'user-b',
    remark: 'Home',
  });

  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async listDevices(accessToken) {
        return {
          success: true,
          username: accessToken === 'token-a' ? 'user-a' : 'user-b',
          devices: [{
            id: 'serial-one',
            name: 'A2L01',
            model: 'A2',
            modelCode: 'A2',
            accessCode: accessToken === 'token-a' ? 'code-a' : 'code-b',
            online: true,
          }],
        };
      },
    },
    scan: async () => [{ serial: 'SERIAL-ONE', ip: '192.168.1.50' }],
  });

  const snapshot = await runtime.refreshAccounts();

  assert.equal(snapshot.devices.length, 1);
  assert.deepEqual(snapshot.devices[0].accountLabels, ['Company', 'Home']);
  assert.equal(snapshot.devices[0].displayName, 'A2L01（Company / Home）');
  assert.equal(JSON.stringify(snapshot).includes('token-a'), false);
  assert.equal(JSON.stringify(snapshot).includes('code-a'), false);
  assert.equal(JSON.stringify(snapshot).includes('192.168.1.50'), false);

  assert.deepEqual(runtime.resolveMqttPayload({ serialNumber: 'serial-one' }), {
    serialNumber: 'SERIAL-ONE',
    mode: 'local',
    ip: '192.168.1.50',
    accessCode: 'code-a',
  });
  assert.deepEqual(runtime.resolveCameraPayload({ serialNumber: 'serial-one' }), {
    serialNumber: 'SERIAL-ONE',
    dev_id: 'SERIAL-ONE',
    name: 'A2L01',
    model: 'A2',
    modelCode: 'A2',
    ip: '192.168.1.50',
    accessCode: 'code-a',
  });
});

test('account-scoped refresh updates only the selected account and preserves other inventories', async (t) => {
  const store = createStore(t);
  const first = store.addAccount({
    account: 'first@example.com', accessToken: 'token-a', username: 'user-a', remark: 'Office',
  });
  store.addAccount({
    account: 'second@example.com', accessToken: 'token-b', username: 'user-b', remark: 'Home',
  });
  const calls = [];
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async listDevices(accessToken) {
        calls.push(accessToken);
        return {
          success: true,
          username: accessToken === 'token-a' ? 'user-a' : 'user-b',
          devices: [{
            id: accessToken === 'token-a' ? 'OFFICE' : 'HOME',
            name: accessToken === 'token-a' ? 'Office printer' : 'Home printer',
          }],
        };
      },
    },
    scan: async () => [],
  });

  await runtime.refreshAccounts();
  calls.length = 0;
  const snapshot = await runtime.refreshAccounts({ accountId: first.accountId });

  assert.deepEqual(calls, ['token-a']);
  assert.deepEqual(snapshot.devices.map(({ dev_id }) => dev_id), ['OFFICE', 'HOME']);
});

test('password login adds an account with an optional remark without returning credentials', async (t) => {
  const store = createStore(t);
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async loginPassword(payload) {
        assert.deepEqual(payload, { account: 'maker@example.com', password: 'private-password' });
        return { success: true, accessToken: 'private-token' };
      },
      async listDevices(accessToken) {
        assert.equal(accessToken, 'private-token');
        return {
          success: true,
          username: 'cloud-user',
          devices: [{ id: 'SERIAL-LOGIN', name: 'P1S', accessCode: 'private-code' }],
        };
      },
    },
    scan: async () => [],
  });

  const result = await runtime.loginPassword({
    account: 'maker@example.com',
    password: 'private-password',
    remark: 'Studio',
  });

  assert.equal(result.success, true);
  assert.equal(result.account.label, 'Studio');
  assert.equal(result.snapshot.devices[0].displayName, 'P1S（Studio）');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('private-password'), false);
  assert.equal(JSON.stringify(result).includes('private-code'), false);
  assert.equal(store.getPrivateAccounts()[0].accessToken, 'private-token');
  assert.equal(store.getPrivateAccounts()[0].username, 'cloud-user');

  const refreshed = await runtime.loginPassword({
    account: 'maker@example.com',
    password: 'private-password',
  });
  assert.equal(refreshed.account.accountId, result.account.accountId);
  assert.equal(refreshed.account.remark, 'Studio');
});

test('verification-code request and login expose only safe account results', async (t) => {
  const store = createStore(t);
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async requestVerifyCode(payload) {
        assert.deepEqual(payload, { account: '13800138000' });
        return { success: true, message: 'sent', providerDetail: 'private-provider-value' };
      },
      async loginCode(payload) {
        assert.deepEqual(payload, { account: '13800138000', code: '654321' });
        return { success: true, accessToken: 'code-token' };
      },
      async listDevices() {
        return { success: true, username: 'phone-user', devices: [] };
      },
    },
    scan: async () => [],
  });

  assert.deepEqual(
    await runtime.requestVerifyCode({ account: ' 13800138000 ' }),
    { success: true, message: 'sent' },
  );
  const result = await runtime.loginCode({
    account: ' 13800138000 ',
    code: '654321',
  });

  assert.equal(result.success, true);
  assert.equal(result.account.accountMasked, '138****8000');
  assert.equal(JSON.stringify(result).includes('654321'), false);
  assert.equal(JSON.stringify(result).includes('code-token'), false);
  assert.equal(JSON.stringify(result).includes('private-provider-value'), false);
});

test('listing, renaming, and removing accounts keeps duplicate printers until the final source is removed', async (t) => {
  const store = createStore(t);
  const first = store.addAccount({
    account: 'first@example.com', accessToken: 'token-a', username: 'user-a', remark: 'First',
  });
  const second = store.addAccount({
    account: 'second@example.com', accessToken: 'token-b', username: 'user-b', remark: 'Second',
  });
  let cloudCalls = 0;
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async listDevices(accessToken) {
        cloudCalls += 1;
        return {
          success: true,
          username: accessToken === 'token-a' ? 'user-a' : 'user-b',
          devices: [{ id: 'DUPLICATE', name: 'A1 mini', accessCode: `code-${accessToken}` }],
        };
      },
    },
    scan: async () => [],
  });
  await runtime.refreshAccounts();

  const listed = runtime.listAccounts();
  assert.deepEqual(listed.accounts.map(({ accountId }) => accountId), [first.accountId, second.accountId]);
  assert.equal(JSON.stringify(listed).includes('token-a'), false);

  const renamed = await runtime.updateRemark(first.accountId, 'Workshop');
  assert.equal(renamed.account.label, 'Workshop');
  assert.equal(renamed.snapshot.devices[0].displayName, 'A1 mini（Workshop / Second）');
  assert.equal(cloudCalls, 2);

  const oneRemoved = await runtime.removeAccount(first.accountId);
  assert.equal(oneRemoved.removed.accountId, first.accountId);
  assert.equal(oneRemoved.snapshot.devices.length, 1);
  assert.deepEqual(oneRemoved.snapshot.devices[0].accountIds, [second.accountId]);

  const finalRemoved = await runtime.removeAccount(second.accountId);
  assert.equal(finalRemoved.snapshot.accounts.length, 0);
  assert.equal(finalRemoved.snapshot.devices.length, 0);
});

test('reauthentication resolves the private account identity and replaces credentials without exposing them', async (t) => {
  const store = createStore(t);
  const account = store.addAccount({
    account: 'owner@example.com', accessToken: 'old-token', username: 'old-user', remark: 'Owner',
  });
  let passwordLoginCalls = 0;
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async requestVerifyCode(payload) {
        assert.deepEqual(payload, { account: 'owner@example.com' });
        return { success: true, message: 'sent' };
      },
      async loginPassword(payload) {
        passwordLoginCalls += 1;
        assert.deepEqual(payload, { account: 'owner@example.com', password: 'new-password' });
        return { success: true, accessToken: 'renewed-token' };
      },
      async listDevices(accessToken) {
        return {
          success: true,
          username: accessToken === 'renewed-token' ? 'renewed-user' : 'old-user',
          devices: [{ id: 'REAUTH-SERIAL', name: 'H2D' }],
        };
      },
    },
    scan: async () => [],
  });

  assert.deepEqual(
    await runtime.requestVerifyCode({ accountId: account.accountId }),
    { success: true, message: 'sent' },
  );
  const result = await runtime.reauthenticate({
    accountId: account.accountId,
    method: 'password',
    password: 'new-password',
  });

  assert.equal(result.success, true);
  assert.equal(result.account.label, 'Owner');
  assert.equal(store.getPrivateAccount(account.accountId).accessToken, 'renewed-token');
  assert.equal(store.getPrivateAccount(account.accountId).username, 'renewed-user');
  assert.equal(JSON.stringify(result).includes('renewed-token'), false);
  assert.equal(JSON.stringify(result).includes('new-password'), false);

  const rejected = await runtime.reauthenticate({
    accountId: account.accountId,
    account: 'different@example.com',
    method: 'password',
    password: 'new-password',
  });
  assert.equal(rejected.success, false);
  assert.equal(passwordLoginCalls, 1);
});

test('serializes account mutations so removal cannot invalidate an in-flight reauthentication', async (t) => {
  const store = createStore(t);
  const account = store.addAccount({
    account: 'owner@example.com', accessToken: 'old-token', username: 'old-user',
  });
  let releaseLogin;
  let notifyLoginStarted;
  const loginStarted = new Promise((resolve) => { notifyLoginStarted = resolve; });
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async loginPassword() {
        notifyLoginStarted();
        await loginGate;
        return { success: true, accessToken: 'new-token' };
      },
      async listDevices() {
        return { success: true, username: 'new-user', devices: [] };
      },
    },
    scan: async () => [],
  });

  const reauthentication = runtime.reauthenticate({
    accountId: account.accountId,
    method: 'password',
    password: 'new-password',
  });
  await loginStarted;
  const removal = runtime.removeAccount(account.accountId);
  assert.equal(store.getPrivateAccount(account.accountId).accessToken, 'old-token');
  releaseLogin();

  const [reauthenticated, removed] = await Promise.all([reauthentication, removal]);
  assert.equal(reauthenticated.success, true);
  assert.equal(reauthenticated.account.accountId, account.accountId);
  assert.equal(removed.success, true);
  assert.deepEqual(runtime.listAccounts().accounts, []);
});

test('serializes duplicate login before a later removal', async (t) => {
  const store = createStore(t);
  const account = store.addAccount({
    account: 'owner@example.com', accessToken: 'old-token', username: 'old-user',
  });
  let releaseLogin;
  let notifyLoginStarted;
  const loginStarted = new Promise((resolve) => { notifyLoginStarted = resolve; });
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async loginPassword() {
        notifyLoginStarted();
        await loginGate;
        return { success: true, accessToken: 'new-token' };
      },
      async listDevices() {
        return { success: true, username: 'new-user', devices: [] };
      },
    },
    scan: async () => [],
  });

  const login = runtime.loginPassword({
    account: 'owner@example.com',
    password: 'new-password',
  });
  await loginStarted;
  const removal = runtime.removeAccount(account.accountId);
  releaseLogin();

  const [loggedIn, removed] = await Promise.all([login, removal]);
  assert.equal(loggedIn.account.accountId, account.accountId);
  assert.equal(removed.removed.accountId, account.accountId);
  assert.deepEqual(runtime.listAccounts().accounts, []);
});

test('serializes refresh with reauthentication so stale inventory cannot overwrite new credentials', async (t) => {
  const store = createStore(t);
  const account = store.addAccount({
    account: 'owner@example.com', accessToken: 'old-token', username: 'old-user',
  });
  let releaseOldRefresh;
  let notifyOldRefresh;
  const oldRefreshStarted = new Promise((resolve) => { notifyOldRefresh = resolve; });
  const oldRefreshGate = new Promise((resolve) => { releaseOldRefresh = resolve; });
  let reauthenticationStarted = false;
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async loginPassword() {
        reauthenticationStarted = true;
        return { success: true, accessToken: 'new-token' };
      },
      async listDevices(accessToken) {
        if (accessToken === 'old-token') {
          notifyOldRefresh();
          await oldRefreshGate;
          return { success: true, username: 'old-user', devices: [{ id: 'SERIAL', name: 'OLD' }] };
        }
        return { success: true, username: 'new-user', devices: [{ id: 'SERIAL', name: 'NEW' }] };
      },
    },
    scan: async () => [],
  });

  const staleRefresh = runtime.refreshAccounts();
  await oldRefreshStarted;
  const reauthentication = runtime.reauthenticate({
    accountId: account.accountId,
    method: 'password',
    password: 'new-password',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reauthenticationStarted, false);
  releaseOldRefresh();
  await Promise.all([staleRefresh, reauthentication]);

  assert.equal(runtime.snapshot().devices[0].name, 'NEW');
  assert.equal(store.getPrivateAccount(account.accountId).accessToken, 'new-token');
});

test('private connection fingerprints change with credentials without exposing their values', async (t) => {
  const store = createStore(t);
  const account = store.addAccount({
    account: 'owner@example.com', accessToken: 'old-token', username: 'old-user',
  });
  const runtime = createAccountRuntime({
    accountStore: store,
    cloud: {
      async loginPassword() { return { success: true, accessToken: 'new-token' }; },
      async listDevices(accessToken) {
        return {
          success: true,
          username: accessToken === 'old-token' ? 'old-user' : 'new-user',
          devices: [{ id: 'SERIAL', name: 'P1S', accessCode: 'private-code' }],
        };
      },
    },
    scan: async () => [],
  });
  await runtime.refreshAccounts();
  const before = runtime.getConnectionFingerprints();
  await runtime.reauthenticate({
    accountId: account.accountId,
    method: 'password',
    password: 'new-password',
  });
  const after = runtime.getConnectionFingerprints();

  assert.match(before.SERIAL, /^[a-f0-9]{64}$/);
  assert.match(after.SERIAL, /^[a-f0-9]{64}$/);
  assert.notEqual(before.SERIAL, after.SERIAL);
  assert.equal(JSON.stringify({ before, after }).includes('old-token'), false);
  assert.equal(JSON.stringify({ before, after }).includes('new-token'), false);
  assert.equal(JSON.stringify({ before, after }).includes('private-code'), false);
});
