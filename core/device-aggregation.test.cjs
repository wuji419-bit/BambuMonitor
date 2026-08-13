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
