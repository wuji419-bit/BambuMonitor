const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('../package.json');

test('main process wires the protected account store, runtime, and constrained IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  assert.match(main, /require\(['"]\.\/account-store\.cjs['"]\)/);
  assert.match(main, /require\(['"]\.\/account-runtime\.cjs['"]\)/);
  assert.match(main, /require\(['"]\.\/account-ipc\.cjs['"]\)/);
  assert.match(main, /registerAccountIpc\(\{/);
  assert.match(main, /getRuntime:\s*getAccountRuntime/);
  assert.match(main, /reconcileConnections:\s*reconcileAccountConnections/);
  assert.match(main, /mqttConnectionManager\.disconnect\(serialNumber\)/);
  assert.match(main, /cameraSources\.delete\(serialNumber\)/);
});

test('main process resolves serial-only MQTT and camera requests without registering secret-returning legacy handlers', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

  assert.match(main, /resolveManagedMqttPayload\(getAccountRuntime,\s*payload\)/);
  assert.match(main, /resolveManagedCameraPayload\(getAccountRuntime,\s*payload\)/);
  assert.match(main, /ipcMain\.handle\(['"]mqtt-connect['"]/);
  assert.match(main, /ipcMain\.handle\(['"]camera-start['"]/);
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]cloud-login['"]/);
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]auth-session-get['"]/);
  assert.doesNotMatch(main, /require\(['"]\.\/auth-session\.cjs['"]\)/);
});

test('desktop package includes the account runtime and IPC tests', () => {
  for (const file of ['electron/account-runtime.cjs', 'electron/account-ipc.cjs']) {
    assert.equal(packageJson.build.files.includes(file), true);
  }
  for (const testFile of [
    'electron/account-runtime.test.cjs',
    'electron/account-ipc.test.cjs',
    'electron/preload-accounts.test.cjs',
    'electron/main-account-wiring.test.cjs',
  ]) {
    assert.match(packageJson.scripts.test, new RegExp(testFile.replaceAll('.', '\\.')));
  }
});
