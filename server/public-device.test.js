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
