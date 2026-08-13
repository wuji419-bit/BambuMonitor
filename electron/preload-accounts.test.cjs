const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPreload() {
  const invokes = [];
  const listeners = new Map();
  let api;
  const ipcRenderer = {
    invoke(channel, payload) {
      invokes.push([channel, payload]);
      return Promise.resolve({ success: true });
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send() {},
  };
  const source = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
        ipcRenderer,
      };
    },
  });
  return { api, invokes, listeners };
}

test('preload exposes every desktop account operation on constrained IPC channels', async () => {
  const { api, invokes } = loadPreload();
  const payload = { accountId: 'account-1' };

  await api.accounts.list();
  await api.accounts.loginPassword(payload);
  await api.accounts.requestVerifyCode(payload);
  await api.accounts.loginCode(payload);
  await api.accounts.updateRemark(payload);
  await api.accounts.reauthenticate(payload);
  await api.accounts.remove(payload);
  await api.accounts.refresh(payload);

  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [
    ['accounts-list', null],
    ['accounts-login-password', payload],
    ['accounts-code-request', payload],
    ['accounts-login-code', payload],
    ['accounts-update-remark', payload],
    ['accounts-reauthenticate', payload],
    ['accounts-remove', payload],
    ['accounts-refresh', payload],
  ]);
});

test('preload does not expose legacy IPC channels that return credentials', () => {
  const { api } = loadPreload();
  const source = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');

  assert.equal(api.auth, undefined);
  for (const channel of [
    'cloud-login', 'cloud-login-code', 'get-device-list',
    'auth-session-get', 'auth-session-set', 'auth-session-clear',
  ]) {
    assert.equal(source.includes(`'${channel}'`), false, channel);
  }
});

test('preload account change subscription can be removed', () => {
  const { api, listeners } = loadPreload();
  const values = [];
  const unsubscribe = api.events.onAccountsChanged((value) => values.push(value));
  listeners.get('accounts-changed')({}, { accounts: [] });
  unsubscribe();

  assert.deepEqual(values, [{ accounts: [] }]);
  assert.equal(listeners.has('accounts-changed'), false);
});
