const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateDeviceInventories,
  aggregateDeviceRecords,
  normalizeSerial,
  toPublicAggregatedDevice,
} = require('./device-aggregation.cjs');

function privateAccount(accountId, label, overrides = {}) {
  return {
    accountId,
    label,
    account: `${accountId}@private.test`,
    accessToken: `token-${accountId}`,
    username: `user-${accountId}`,
    ...overrides,
  };
}

test('normalizes serials from id or dev_id and ignores devices without one', () => {
  assert.equal(normalizeSerial(' uuid:serial_a::mqtt '), 'SERIAL_A');

  const devices = aggregateDeviceInventories([
    {
      account: privateAccount('a', '公司'),
      devices: [
        { id: ' uuid:serial_a::mqtt ', name: 'A2L01' },
        { id: '', dev_id: 'serial_b', name: 'P1S01' },
        { name: 'Missing' },
        { id: '   ', name: 'Blank' },
      ],
    },
  ]);

  assert.deepEqual(devices.map(({ dev_id }) => dev_id), ['SERIAL_A', 'SERIAL_B']);
});

test('merges duplicate serials with labels in account insertion order', () => {
  const devices = aggregateDeviceInventories([
    {
      account: privateAccount('a', '公司'),
      devices: [{ id: 'serial', name: 'A2L01', model: 'P1S', online: true }],
    },
    {
      account: privateAccount('b', '工作室'),
      devices: [{ dev_id: 'SERIAL', name: 'Other name', model: 'P1S' }],
    },
    {
      account: privateAccount('c', '公司'),
      devices: [{ id: 'Serial', name: 'Third name' }],
    },
    {
      account: privateAccount('a', '重复账号'),
      devices: [{ id: 'SERIAL', name: 'Duplicate source' }],
    },
  ]);

  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].accountIds, ['a', 'b', 'c']);
  assert.deepEqual(devices[0].accountLabels, ['公司', '工作室']);
  assert.equal(devices[0].name, 'A2L01');
  assert.equal(devices[0].displayName, 'A2L01（公司 / 工作室）');
  assert.equal(devices[0].model, 'P1S');
  assert.equal(devices[0].online, true);
});

test('keeps private source metadata outside the public device projection', () => {
  const account = privateAccount('a', '', { accountMasked: 'a***@private.test' });
  const [record] = aggregateDeviceRecords([
    {
      account,
      devices: [{
        id: 'SERIAL',
        name: 'A2L01',
        accessCode: 'private-access-code',
        dev_access_code: 'private-dev-code',
        ip: '192.168.1.10',
        telemetry: { progress: 25, token: 'nested-token' },
      }],
    },
  ]);

  assert.equal(record.sources[0].account.accessToken, 'token-a');
  assert.equal(record.sources[0].account.account, 'a@private.test');
  assert.equal(record.sources[0].device.accessCode, 'private-access-code');

  const publicDevice = toPublicAggregatedDevice(record);
  assert.equal(publicDevice.displayName, 'A2L01（a***@private.test）');
  assert.equal(publicDevice.telemetry.progress, 25);
  assert.equal(Object.hasOwn(publicDevice, 'sources'), false);
  assert.equal(Object.hasOwn(publicDevice, 'ip'), false);

  const json = JSON.stringify(publicDevice);
  for (const secret of [
    'a@private.test',
    'token-a',
    'user-a',
    'private-access-code',
    'private-dev-code',
    'nested-token',
    '192.168.1.10',
  ]) {
    assert.equal(json.includes(secret), false, `public JSON leaked ${secret}`);
  }
});

test('removes common secret and address key variants recursively', () => {
  const privateFields = {
    local_ip: 'top-local-ip',
    localIp: 'top-localIp',
    api_secret: 'top-api-secret',
    session_token: 'top-session-token',
    credential_value: 'top-credential-value',
    raw_account: 'top-raw-account',
    privateAddress: 'top-private-address',
  };
  const nestedPrivateFields = {
    cached_local_ip_value: 'nested-local-ip',
    fallbackLocalIpValue: 'nested-localIp',
    api_secret_digest: 'nested-api-secret',
    previous_session_token_hash: 'nested-session-token',
    encrypted_credential_value_blob: 'nested-credential-value',
    legacy_raw_account_name: 'nested-raw-account',
    cachedPrivateAddressValue: 'nested-private-address',
  };
  const [device] = aggregateDeviceInventories([{
    account: privateAccount('a', '公司'),
    devices: [{
      id: 'SERIAL',
      name: 'A2L01',
      ...privateFields,
      temperature: { nozzle: 220, bed: 60 },
      progress: 42,
      status: 'printing',
      layer: '4 / 10',
      model: 'P1S',
      online: true,
      cameraPreview: 'rtsp://user:secret@192.168.1.5/live',
      secureCameraPreview: 'rtsps://user:secret@192.168.1.5/live',
      telemetry: {
        ...nestedPrivateFields,
        temperature: { chamber: 35 },
        progress: 43,
        status: 'active',
        layer: 4,
        model: 'AMS',
        online: false,
      },
    }],
  }]);

  for (const key of Object.keys(privateFields)) {
    assert.equal(Object.hasOwn(device, key), false, `public device kept ${key}`);
  }
  for (const key of Object.keys(nestedPrivateFields)) {
    assert.equal(Object.hasOwn(device.telemetry, key), false, `nested device kept ${key}`);
  }
  assert.equal(Object.hasOwn(device, 'cameraPreview'), false);
  assert.equal(Object.hasOwn(device, 'secureCameraPreview'), false);
  assert.deepEqual(device.temperature, { nozzle: 220, bed: 60 });
  assert.equal(device.progress, 42);
  assert.equal(device.status, 'printing');
  assert.equal(device.layer, '4 / 10');
  assert.equal(device.model, 'P1S');
  assert.equal(device.online, true);
  assert.deepEqual(device.telemetry, {
    temperature: { chamber: 35 },
    progress: 43,
    status: 'active',
    layer: 4,
    model: 'AMS',
    online: false,
  });

  const json = JSON.stringify(device);
  for (const secret of [...Object.values(privateFields), ...Object.values(nestedPrivateFields)]) {
    assert.equal(json.includes(secret), false, `public JSON leaked ${secret}`);
  }
});

test('projects only explicit safe device telemetry and AMS fields', () => {
  const [device] = aggregateDeviceInventories([{
    account: privateAccount('a', '公司'),
    devices: [{
      id: 'SERIAL',
      name: 'A2L01',
      model: 'P1S',
      modelCode: 'C12',
      dev_model_name: 'C12',
      dev_product_name: 'P1S',
      productName: 'P1S',
      printerType: 'CoreXY',
      nozzle: 0.4,
      online: true,
      cloudOnline: true,
      printStatus: 'RUNNING',
      print_status: 'RUNNING',
      connectionMode: 'cloud',
      connectionState: 'online',
      statusSource: 'cloud',
      status: 'printing',
      jobStatus: 'printing',
      lastJobStatus: 'printing',
      progress: 64,
      timeLeft: '1h 20m',
      temperature: { nozzle: 220, bed: 60, chamber: 35, apiKey: 'temperature-api-key' },
      fan: 50,
      speed: 100,
      layer: '4/10',
      filename: 'part.3mf',
      errorMsg: '',
      errorCode: 'ftp://error-user:error-password@example.test/private',
      remainingMinutesRaw: 80,
      remainingUpdatedAt: 123,
      remainingStatus: 'printing',
      lastTelemetryAt: 124,
      cameraMode: 'rtsps',
      hasLocalAddress: true,
      telemetry: {
        progress: 65,
        status: 'printing',
        temperature: { nozzle: 221, bed: 61, chamber: 36, cookie: 'temperature-cookie' },
        lastTelemetryAt: 125,
        filename: 'custom+tcp://telemetry-user:telemetry-password@example.test/private',
        apiKey: 'telemetry-api-key',
        arbitraryUnknown: 'nested-unknown',
      },
      ams: {
        activeAmsIndex: 0,
        activeTrayIndex: 1,
        apiKey: 'ams-api-key',
        units: [{
          index: 0,
          humidityIndex: 4,
          humidityRaw: 52.5,
          temperature: 24.6,
          cookie: 'unit-cookie',
          trays: [{
            id: 1,
            remain: 87,
            trayWeight: 1000,
            type: 'PLA',
            color: 'FF00AAFF',
            idx: 'GFA00',
            subBrand: 'Basic',
            name: 'PLA',
            trayUuid: 'tray-0-1',
            sessionToken: 'tray-session-token',
            arbitraryUnknown: 'tray-unknown',
          }],
          activeTray: {
            id: 1,
            remain: 87,
            trayWeight: 1000,
            type: 'PLA',
            color: 'FF00AAFF',
            idx: 'GFA00',
            subBrand: 'Basic',
            name: 'PLA',
            trayUuid: 'tray-0-1',
            apiKey: 'active-tray-api-key',
          },
        }],
      },
      apiKey: 'top-api-key',
      cookie: 'top-cookie',
      sessionToken: 'top-session-token',
      arbitraryUnknown: 'top-unknown',
      unknownObject: { progress: 99 },
      unknownArray: [{ status: 'private' }],
      supportUrl: 'https://support-user:support-password@example.test/private',
      cameraPreview: 'rtsp://camera-user:camera-password@example.test/live',
    }],
  }]);

  assert.equal(device.dev_id, 'SERIAL');
  assert.equal(device.name, 'A2L01');
  assert.equal(device.displayName, 'A2L01（公司）');
  assert.deepEqual(device.accountIds, ['a']);
  assert.deepEqual(device.accountLabels, ['公司']);
  assert.equal(device.model, 'P1S');
  assert.equal(device.modelCode, 'C12');
  assert.equal(device.cloudOnline, true);
  assert.equal(device.connectionState, 'online');
  assert.equal(device.jobStatus, 'printing');
  assert.equal(device.progress, 64);
  assert.equal(device.timeLeft, '1h 20m');
  assert.deepEqual(device.temperature, { nozzle: 220, bed: 60, chamber: 35 });
  assert.equal(device.fan, 50);
  assert.equal(device.speed, 100);
  assert.equal(device.layer, '4/10');
  assert.equal(device.filename, 'part.3mf');
  assert.equal(device.errorMsg, '');
  assert.equal(device.remainingMinutesRaw, 80);
  assert.equal(device.remainingUpdatedAt, 123);
  assert.equal(device.remainingStatus, 'printing');
  assert.equal(device.lastTelemetryAt, 124);
  assert.equal(device.cameraMode, 'rtsps');
  assert.equal(device.hasLocalAddress, true);
  assert.deepEqual(device.telemetry, {
    progress: 65,
    status: 'printing',
    temperature: { nozzle: 221, bed: 61, chamber: 36 },
    lastTelemetryAt: 125,
  });
  assert.deepEqual(device.ams, {
    activeAmsIndex: 0,
    activeTrayIndex: 1,
    units: [{
      index: 0,
      humidityIndex: 4,
      humidityRaw: 52.5,
      temperature: 24.6,
      trays: [{
        id: 1,
        remain: 87,
        trayWeight: 1000,
        type: 'PLA',
        color: 'FF00AAFF',
        idx: 'GFA00',
        subBrand: 'Basic',
        name: 'PLA',
        trayUuid: 'tray-0-1',
      }],
      activeTray: {
        id: 1,
        remain: 87,
        trayWeight: 1000,
        type: 'PLA',
        color: 'FF00AAFF',
        idx: 'GFA00',
        subBrand: 'Basic',
        name: 'PLA',
        trayUuid: 'tray-0-1',
      },
    }],
  });

  for (const key of [
    'apiKey',
    'cookie',
    'sessionToken',
    'arbitraryUnknown',
    'unknownObject',
    'unknownArray',
    'supportUrl',
    'cameraPreview',
    'errorCode',
  ]) {
    assert.equal(Object.hasOwn(device, key), false, `public device kept ${key}`);
  }
  const json = JSON.stringify(device);
  for (const secret of [
    'top-api-key',
    'top-cookie',
    'top-session-token',
    'top-unknown',
    'temperature-api-key',
    'telemetry-api-key',
    'temperature-cookie',
    'ams-api-key',
    'unit-cookie',
    'tray-session-token',
    'tray-unknown',
    'active-tray-api-key',
    'support-user',
    'error-user',
    'telemetry-user',
    'camera-user',
  ]) {
    assert.equal(json.includes(secret), false, `public JSON leaked ${secret}`);
  }
});

test('rejects credential URLs from synthesized names and account labels', () => {
  const [device] = aggregateDeviceInventories([{
    account: privateAccount('a', 'mqtt://label-user:label-password@example.test/private'),
    devices: [{
      id: 'SERIAL',
      name: 'https://name-user:name-password@example.test/private',
    }],
  }]);

  assert.equal(device.name, '');
  assert.equal(device.displayName, 'SERIAL');
  assert.deepEqual(device.accountIds, ['a']);
  assert.deepEqual(device.accountLabels, []);
  const json = JSON.stringify(device);
  assert.equal(json.includes('name-user'), false);
  assert.equal(json.includes('label-user'), false);
});

test('source removal retains a printer owned by another inventory', () => {
  const company = {
    account: privateAccount('a', '公司'),
    devices: [{ id: 'SERIAL', name: 'A2L01' }, { id: 'COMPANY_ONLY', name: 'X1C' }],
  };
  const studio = {
    account: privateAccount('b', '工作室'),
    devices: [{ id: 'SERIAL', name: 'A2L01' }],
  };

  const beforeRemoval = aggregateDeviceInventories([company, studio]);
  const afterRemoval = aggregateDeviceInventories([studio]);

  assert.deepEqual(beforeRemoval.map(({ dev_id }) => dev_id), ['SERIAL', 'COMPANY_ONLY']);
  assert.deepEqual(afterRemoval.map(({ dev_id }) => dev_id), ['SERIAL']);
  assert.deepEqual(afterRemoval[0].accountIds, ['b']);
  assert.deepEqual(afterRemoval[0].accountLabels, ['工作室']);
  assert.equal(afterRemoval[0].displayName, 'A2L01（工作室）');
});
