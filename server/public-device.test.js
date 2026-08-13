import test from 'node:test';
import assert from 'node:assert/strict';

import { projectPublicDevice, projectPublicDeviceEvent } from './public-device.js';

test('projects aggregate account labels while removing nested source credentials', () => {
  const device = projectPublicDevice({
    dev_id: 'SERIAL_A',
    name: 'Printer',
    displayName: 'Printer（Office）',
    accountIds: ['office'],
    accountLabels: ['Office'],
    sources: [{ account: { accessToken: 'token-secret', username: 'private-user' }, device: { accessCode: 'code-secret', ip: '192.168.1.3' } }],
    ip: '192.168.1.2',
  });

  assert.deepEqual(device.accountLabels, ['Office']);
  assert.equal(device.hasLocalAddress, true);
  assert.equal(JSON.stringify(device).includes('secret'), false);
  assert.equal(JSON.stringify(projectPublicDeviceEvent({ type: 'devices.snapshot', devices: [device] })).includes('private-user'), false);
});

test('fails closed for unknown public fields and credential-bearing presentation strings', () => {
  const device = projectPublicDevice({
    dev_id: 'SERIAL_A',
    name: 'https://user:password@printer.example.test',
    displayName: 'rtsps://user:password@printer.example.test/live',
    accountIds: ['office'],
    accountLabels: ['https://user:password@example.test'],
    apiKey: 'private-key',
    username: 'private-user',
    telemetry: { progress: 42, apiKey: 'private-telemetry-key' },
    ams: { units: [{ index: 0, trays: [{ id: 'A', name: 'PLA', token: 'private-tray-token' }] }] },
    ip: '192.168.1.2',
  });
  assert.equal(device.name, 'SERIAL_A');
  assert.equal(device.displayName, 'SERIAL_A');
  assert.deepEqual(device.accountIds, ['office']);
  assert.deepEqual(device.accountLabels, []);
  assert.equal('apiKey' in device, false);
  assert.equal('username' in device, false);
  assert.equal('apiKey' in device.telemetry, false);
  assert.equal('token' in device.ams.units[0].trays[0], false);
  assert.deepEqual(projectPublicDeviceEvent({ type: 'account.updated', accountId: 'office', state: { connectionState: 'connected', deviceCount: 1, username: 'private-user' } }), {
    type: 'account.updated', accountId: 'office', state: { connectionState: 'connected', errorCode: null, syncedAt: null, deviceCount: 1 },
  });
  assert.equal(projectPublicDeviceEvent({ type: 'unknown', token: 'private' }), null);
});
