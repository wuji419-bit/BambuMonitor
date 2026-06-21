import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeviceSyncSnapshot } from './printerSync.js';

test('keeps all cloud devices and restores local IP from normalized device-name cache', () => {
  const cloudDevices = [
    { id: 'A1_SERIAL', name: 'A1mini', accessCode: 'a1', online: true, printStatus: 'RUNNING' },
    { id: 'H2D_SERIAL', name: 'H2D', accessCode: 'h2d', online: true, printStatus: 'PAUSE' },
    { id: 'A2L01_SERIAL', name: 'A2L01', accessCode: 'a2-1', online: true, printStatus: 'PREPARE' },
    { id: 'A2L02_SERIAL', name: 'A2L02', accessCode: 'a2-2', online: true, printStatus: 'RUNNING' },
    { id: 'P1SC_SERIAL', name: 'P1SC', accessCode: 'p1', online: true, printStatus: 'RUNNING' },
  ];

  const snapshot = buildDeviceSyncSnapshot({
    cloudDevices,
    scannedPrinters: [],
    cachedIps: {
      a2l01: '192.0.2.201',
    },
  });

  assert.equal(snapshot.initialPrinters.length, 5);

  const a2l01 = snapshot.initialPrinters.find((printer) => printer.name === 'A2L01');
  assert.equal(a2l01.ip, '192.0.2.201');
  assert.equal(a2l01.statusSource, 'local');
  assert.equal(a2l01.status, 'preparing');
  assert.equal(snapshot.cachedIps.A2L01_SERIAL, '192.0.2.201');
  assert.equal(snapshot.cachedIps.a2l01, '192.0.2.201');
});
