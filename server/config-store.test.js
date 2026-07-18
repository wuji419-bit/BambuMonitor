import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfigStore } from './config-store.js';
import { createStorage } from './storage.js';

const DEFAULT_CONFIG = {
  version: 1,
  camera: { autoOpen: false, customUrls: {} },
  notifications: { enabled: false, targets: [] },
  debug: false,
};
const DEFAULT_CACHE = { version: 1, devices: {} };

async function realStorage(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-config-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, storage: await createStorage({ dataDir }) };
}

function memoryStorage(initial = {}, { failWrites = 0 } = {}) {
  const files = structuredClone(initial);
  const backups = [];
  let remainingFailures = failWrites;
  return {
    files,
    backups,
    async readJson(name, fallback) {
      return Object.hasOwn(files, name) ? structuredClone(files[name]) : structuredClone(fallback);
    },
    async writeJson(name, value) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('simulated write failure');
      }
      files[name] = structuredClone(value);
    },
    async backup(name, backupName) {
      backups.push([name, backupName]);
      if (Object.hasOwn(files, backupName)) return false;
      files[backupName] = structuredClone(files[name]);
      return true;
    },
  };
}

test('persists defaults, restores updates, and returns defensive deep clones', async (t) => {
  const { storage } = await realStorage(t);
  const first = await createConfigStore({ storage, now: () => 100 });
  assert.deepEqual(first.get(), DEFAULT_CONFIG);
  assert.deepEqual(first.getDeviceCache(), DEFAULT_CACHE);

  const configClone = first.get();
  configClone.camera.customUrls.changed = 'http://evil.test';
  const cacheClone = first.getDeviceCache();
  cacheClone.devices.changed = { ip: '10.0.0.1' };
  assert.deepEqual(first.get(), DEFAULT_CONFIG);
  assert.deepEqual(first.getDeviceCache(), DEFAULT_CACHE);

  await first.update({ camera: { autoOpen: true, customUrls: { A1: ' https://cam.example/live ' } }, debug: true });
  await first.updateDevice('01P', { ip: ' 192.168.1.50 ', name: ' A1 mini ', model: ' N2S ' });
  const restarted = await createConfigStore({ storage, now: () => 200 });
  assert.deepEqual(restarted.get().camera, { autoOpen: true, customUrls: { A1: 'https://cam.example/live' } });
  assert.deepEqual(restarted.getDeviceCache().devices['01P'], {
    ip: '192.168.1.50', name: 'A1 mini', model: 'N2S', updatedAt: 100,
  });
});

test('partially merges config while stripping unknown and dangerous keys', async () => {
  const storage = memoryStorage();
  const store = await createConfigStore({ storage });
  await store.update({
    camera: { autoOpen: true, customUrls: { first: 'http://one.test' }, ignored: true },
    notifications: { enabled: true },
    unknown: 'drop',
    ['__proto__']: { polluted: true },
  });
  await store.update({ camera: { customUrls: { second: 'https://two.test/path' } } });
  assert.deepEqual(store.get(), {
    version: 1,
    camera: { autoOpen: true, customUrls: { second: 'https://two.test/path' } },
    notifications: { enabled: true, targets: [] },
    debug: false,
  });
  assert.equal({}.polluted, undefined);
});

test('an explicit custom URL map replaces prior entries and an empty map clears them on restart', async (t) => {
  const { storage } = await realStorage(t);
  const store = await createConfigStore({ storage });
  await store.update({ camera: { customUrls: {
    first: 'https://cam.example/first',
    second: 'https://cam.example/second',
  } } });
  await store.update({ camera: { customUrls: { second: 'https://cam.example/replaced' } } });
  assert.deepEqual(store.get().camera.customUrls, { second: 'https://cam.example/replaced' });

  await store.update({ camera: { customUrls: {} } });
  assert.deepEqual(store.get().camera.customUrls, {});
  const restarted = await createConfigStore({ storage });
  assert.deepEqual(restarted.get().camera.customUrls, {});
});

test('rejects malformed config patches, unsafe URL keys, protocols, and bounds', async () => {
  const store = await createConfigStore({ storage: memoryStorage() });
  const invalid = [
    null,
    [],
    { debug: 'yes' },
    { camera: [] },
    { camera: { customUrls: { '../serial': 'https://cam.test' } } },
    { camera: { customUrls: { serial: 'file:///etc/passwd' } } },
    { camera: { customUrls: { ['x'.repeat(129)]: 'https://cam.test' } } },
    { camera: { customUrls: { serial: `https://cam.test/${'x'.repeat(2048)}` } } },
  ];
  for (const patch of invalid) await assert.rejects(store.update(patch), /Invalid configuration/);
});

test('accepts 100 custom camera URLs and rejects 101 without changing memory', async () => {
  const store = await createConfigStore({ storage: memoryStorage() });
  const atLimit = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`serial-${index}`, `https://cam.example/${index}`]),
  );
  await store.update({ camera: { customUrls: atLimit } });
  assert.equal(Object.keys(store.get().camera.customUrls).length, 100);

  const overLimit = { ...atLimit, 'serial-100': 'https://cam.example/100' };
  await assert.rejects(
    store.update({ camera: { customUrls: overLimit } }),
    /Invalid configuration field: camera\.customUrls/,
  );
  assert.equal(Object.keys(store.get().camera.customUrls).length, 100);
});

test('normalizes bounded notification targets and removes unknown fields', async () => {
  const store = await createConfigStore({ storage: memoryStorage() });
  await store.update({ notifications: { enabled: true, targets: [{
    id: ' hook-1 ', name: ' Webhook ', type: ' custom ', enabled: true,
    url: ' https://hooks.example/path ', secret: 'secret', token: 'token',
    headers: { 'X-Trace-Id': ' abc ', Authorization: 'Bearer hidden' }, ignored: 'drop',
  }] } });
  assert.deepEqual(store.get().notifications.targets, [{
    id: 'hook-1', name: 'Webhook', type: 'custom', enabled: true,
    url: 'https://hooks.example/path', secret: 'secret', token: 'token',
    headers: { 'X-Trace-Id': ' abc ', Authorization: 'Bearer hidden' },
  }]);
});

test('preserves opaque notification credentials and header values exactly across restart', async (t) => {
  const { storage } = await realStorage(t);
  const first = await createConfigStore({ storage });
  const target = {
    id: 'opaque',
    secret: '  secret with surrounding whitespace\t',
    token: '\ttoken with whitespace  ',
    headers: { Authorization: '  Bearer exact-token  ', 'X-Opaque': '\tvalue\t' },
  };
  await first.update({ notifications: { targets: [target] } });
  assert.deepEqual(first.get().notifications.targets[0], target);

  const restarted = await createConfigStore({ storage });
  assert.deepEqual(restarted.get().notifications.targets[0], target);
});

test('enforces notification target, URL, header, and string bounds without echoing secrets', async () => {
  const store = await createConfigStore({ storage: memoryStorage() });
  const secret = 'DO_NOT_ECHO_SECRET';
  const cases = [
    { notifications: { targets: new Array(101).fill({ id: 'x' }) } },
    { notifications: { targets: [{ url: 'ftp://hooks.example', secret }] } },
    { notifications: { targets: [{ id: 'x'.repeat(129), secret }] } },
    { notifications: { targets: [{ name: 'x'.repeat(257), secret }] } },
    { notifications: { targets: [{ secret: 'x'.repeat(4097) }] } },
    { notifications: { targets: [{ headers: { 'Bad Header': 'value' }, secret }] } },
    { notifications: { targets: [{ headers: { Good: 'bad\r\nInjected: yes' }, secret }] } },
    { notifications: { targets: [{ headers: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`X-${i}`, 'v'])) }] } },
  ];
  for (const patch of cases) {
    await assert.rejects(store.update(patch), (error) => /Invalid configuration/.test(error.message)
      && !error.message.includes(secret));
  }
});

test('serializes concurrent config and device mutations without lost updates', async () => {
  let tick = 0;
  const store = await createConfigStore({ storage: memoryStorage(), now: () => ++tick });
  await Promise.all([
    store.update({ camera: { autoOpen: true } }),
    store.update({ debug: true }),
    store.update({ camera: { customUrls: { A: 'http://a.test' } } }),
    store.updateDevice('A', { ip: '10.0.0.1' }),
    store.updateDevice('B', { ip: '10.0.0.2' }),
  ]);
  assert.equal(store.get().camera.autoOpen, true);
  assert.equal(store.get().debug, true);
  assert.equal(store.get().camera.customUrls.A, 'http://a.test/');
  assert.deepEqual(Object.keys(store.getDeviceCache().devices).sort(), ['A', 'B']);
});

test('device updates validate serial and address and persist only allowed normalized fields', async () => {
  const storage = memoryStorage();
  const store = await createConfigStore({ storage, now: () => 1234 });
  const device = await store.updateDevice(' SERIAL_01 ', {
    ip: ' printer.local ', name: ' Printer ', model: ' X1C ', updatedAt: 1,
    accessCode: '12345678', token: 'hidden', password: 'hidden', unknown: 'drop',
  });
  assert.deepEqual(device, { ip: 'printer.local', name: 'Printer', model: 'X1C', updatedAt: 1234 });
  assert.deepEqual(storage.files['device-cache.json'].devices.SERIAL_01, device);
  for (const serial of ['', '../bad', 'x'.repeat(129)]) {
    await assert.rejects(store.updateDevice(serial, { ip: '10.0.0.1' }), /Invalid device/);
  }
  await assert.rejects(store.updateDevice('SERIAL_01', { ip: 'https://bad.example' }), /Invalid device/);
  await assert.rejects(store.updateDevice('SERIAL_01', { name: 'x'.repeat(257) }), /Invalid device/);
});

test('device removal is idempotent and write-before-memory', async () => {
  const storage = memoryStorage();
  const store = await createConfigStore({ storage, now: () => 10 });
  await store.updateDevice('A', { ip: '10.0.0.1' });
  await store.removeDevice('missing');
  await store.removeDevice('A');
  await store.removeDevice('A');
  assert.deepEqual(store.getDeviceCache(), DEFAULT_CACHE);
});

test('failed config and device writes leave memory unchanged and can be retried', async () => {
  const storage = memoryStorage();
  const store = await createConfigStore({ storage, now: () => 5 });
  const originalWrite = storage.writeJson.bind(storage);
  let failures = 2;
  storage.writeJson = async (...args) => {
    if (failures-- > 0) throw new Error('simulated write failure');
    return originalWrite(...args);
  };
  await assert.rejects(store.update({ debug: true }), /simulated write failure/);
  assert.equal(store.get().debug, false);
  await assert.rejects(store.updateDevice('A', { ip: '10.0.0.1' }), /simulated write failure/);
  assert.deepEqual(store.getDeviceCache(), DEFAULT_CACHE);
  await store.update({ debug: true });
  await store.updateDevice('A', { ip: '10.0.0.1' });
  assert.equal(store.get().debug, true);
  assert.equal(store.getDeviceCache().devices.A.ip, '10.0.0.1');
});

test('cleans version 1 files and only writes when normalized content changes', async () => {
  const writes = [];
  const storage = memoryStorage({
    'config.json': { ...DEFAULT_CONFIG, extra: true },
    'device-cache.json': { version: 1, devices: { A: { ip: ' 10.0.0.1 ', token: 'drop', updatedAt: 8 } } },
  });
  const write = storage.writeJson.bind(storage);
  storage.writeJson = async (name, value) => { writes.push(name); await write(name, value); };
  await createConfigStore({ storage });
  assert.deepEqual(writes.sort(), ['config.json', 'device-cache.json']);
  writes.length = 0;
  await createConfigStore({ storage });
  assert.deepEqual(writes, []);
});

test('plans both files before changing a normalizable config with a future cache', async () => {
  const config = { ...DEFAULT_CONFIG, extra: 'would-be-cleaned' };
  const cache = { ...DEFAULT_CACHE, version: 2 };
  const storage = memoryStorage({ 'config.json': config, 'device-cache.json': cache });

  await assert.rejects(createConfigStore({ storage }), /Unsupported device-cache\.json version/);
  assert.deepEqual(storage.files['config.json'], config);
  assert.deepEqual(storage.files['device-cache.json'], cache);
  assert.deepEqual(storage.backups, []);
});

test('plans both files before changing a normalizable cache with a future config', async () => {
  const config = { ...DEFAULT_CONFIG, version: 2 };
  const cache = { version: 1, devices: {}, extra: 'would-be-cleaned' };
  const storage = memoryStorage({ 'config.json': config, 'device-cache.json': cache });

  await assert.rejects(createConfigStore({ storage }), /Unsupported config\.json version/);
  assert.deepEqual(storage.files['config.json'], config);
  assert.deepEqual(storage.files['device-cache.json'], cache);
  assert.deepEqual(storage.backups, []);
});

test('does not back up a v0 file before the other file version validates', async () => {
  const config = { version: 0, debug: true };
  const cache = { ...DEFAULT_CACHE, version: 2 };
  const storage = memoryStorage({ 'config.json': config, 'device-cache.json': cache });

  await assert.rejects(createConfigStore({ storage }), /Unsupported device-cache\.json version/);
  assert.deepEqual(storage.files['config.json'], config);
  assert.deepEqual(storage.files['device-cache.json'], cache);
  assert.deepEqual(storage.backups, []);
});

test('allows existing device updates at capacity but rejects insertion and loading overflow', async () => {
  const devices = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [`SERIAL_${index}`, { updatedAt: index }]),
  );
  const storage = memoryStorage({
    'config.json': DEFAULT_CONFIG,
    'device-cache.json': { version: 1, devices },
  });
  const store = await createConfigStore({ storage, now: () => 2000 });
  await store.updateDevice('SERIAL_0', { name: 'Updated' });
  assert.equal(store.getDeviceCache().devices.SERIAL_0.name, 'Updated');
  assert.equal(Object.keys(store.getDeviceCache().devices).length, 1000);

  await assert.rejects(store.updateDevice('SERIAL_OVERFLOW', { name: 'Rejected' }), /Invalid device field: devices/);
  assert.equal(Object.keys(store.getDeviceCache().devices).length, 1000);
  assert.equal(Object.hasOwn(storage.files['device-cache.json'].devices, 'SERIAL_OVERFLOW'), false);

  const overflowDevices = { ...devices, SERIAL_OVERFLOW: { updatedAt: 2000 } };
  const overflowStorage = memoryStorage({
    'config.json': DEFAULT_CONFIG,
    'device-cache.json': { version: 1, devices: overflowDevices },
  });
  await assert.rejects(createConfigStore({ storage: overflowStorage }), /Invalid device field: devices/);
  assert.deepEqual(overflowStorage.files['device-cache.json'].devices, overflowDevices);
  assert.deepEqual(overflowStorage.backups, []);
});

for (const name of ['config.json', 'device-cache.json']) {
  test(`${name} existing null fails validation without overwrite or backup`, async (t) => {
    const { dataDir, storage } = await realStorage(t);
    if (name === 'device-cache.json') await storage.writeJson('config.json', DEFAULT_CONFIG);
    const original = Buffer.from('null\n');
    await fs.writeFile(path.join(dataDir, name), original);

    await assert.rejects(createConfigStore({ storage }), new RegExp(`Unsupported ${name} version`));
    assert.deepEqual(await fs.readFile(path.join(dataDir, name)), original);
    await assert.rejects(fs.stat(path.join(dataDir, `${name}.bak-v0`)), { code: 'ENOENT' });
  });
}

for (const name of ['config.json', 'device-cache.json']) {
  test(`${name} v0 backup precedes migration validation failure`, async (t) => {
    const { dataDir, storage } = await realStorage(t);
    if (name === 'device-cache.json') await storage.writeJson('config.json', DEFAULT_CONFIG);
    const original = name === 'config.json'
      ? Buffer.from('{\n  "version": 0, "debug": "invalid"\n}\n')
      : Buffer.from('{\n  "version": 0, "devices": []\n}\n');
    await fs.writeFile(path.join(dataDir, name), original);

    await assert.rejects(createConfigStore({ storage }), /Invalid (configuration|device) field/);
    assert.deepEqual(await fs.readFile(path.join(dataDir, `${name}.bak-v0`)), original);
    assert.deepEqual(await fs.readFile(path.join(dataDir, name)), original);
  });
}

for (const name of ['config.json', 'device-cache.json']) {
  test(`${name} v0 migration creates one byte-identical backup and is idempotent`, async (t) => {
    const { dataDir, storage } = await realStorage(t);
    const fixture = name === 'config.json'
      ? Buffer.from('{\n  "version": 0, "debug": true, "legacy": "keep-in-backup"\n}\n')
      : Buffer.from('{\n  "version": 0, "devices": {"A":{"ip":"10.0.0.8","token":"secret"}}\n}\n');
    await fs.writeFile(path.join(dataDir, name), fixture);
    await createConfigStore({ storage });
    assert.deepEqual(await fs.readFile(path.join(dataDir, `${name}.bak-v0`)), fixture);
    const backupBefore = await fs.readFile(path.join(dataDir, `${name}.bak-v0`));
    await createConfigStore({ storage });
    assert.deepEqual(await fs.readFile(path.join(dataDir, `${name}.bak-v0`)), backupBefore);
    assert.equal((await storage.readJson(name, null)).version, 1);
  });
}

test('a failed v0 migration preserves the original and retries with the unchanged backup', async () => {
  const original = { version: 0, debug: true, marker: 'original' };
  const storage = memoryStorage({ 'config.json': original }, { failWrites: 1 });
  await assert.rejects(createConfigStore({ storage }), /simulated write failure/);
  assert.deepEqual(storage.files['config.json'], original);
  assert.deepEqual(storage.files['config.json.bak-v0'], original);
  await createConfigStore({ storage });
  assert.equal(storage.files['config.json'].version, 1);
  assert.deepEqual(storage.files['config.json.bak-v0'], original);
});

test('future, negative, and noninteger versions fail without backup or overwrite for both files', async () => {
  for (const name of ['config.json', 'device-cache.json']) {
    for (const version of [2, -1, 0.5, '1']) {
      const value = name === 'config.json' ? { ...DEFAULT_CONFIG, version } : { ...DEFAULT_CACHE, version };
      const storage = memoryStorage({ [name]: value });
      await assert.rejects(createConfigStore({ storage }), /Unsupported .* version/);
      assert.deepEqual(storage.files[name], value);
      assert.deepEqual(storage.backups, []);
    }
  }
});
