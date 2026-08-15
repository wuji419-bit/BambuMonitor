import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  buildCameraStartPayload,
  buildServerCameraConfig,
  cameraCompatibilityNote,
  createDefaultCameraConfig,
  getCameraTransport,
  isAutoCameraSupported,
  isServerManagedCameraSource,
  mergeCameraConfig,
} from './camera.js';

const require = createRequire(import.meta.url);

test('allows automatic RTSPS camera for H2D printers', () => {
  assert.equal(isAutoCameraSupported({ name: 'H2D', model: 'H2D' }), true);
  assert.equal(getCameraTransport({ name: 'H2D', model: 'H2D' }), 'rtsps');
  assert.equal(cameraCompatibilityNote({ name: 'H2D', model: 'H2D' }), '');
});

test('routes A1, P1, and A2L cameras through chamber-image transport', () => {
  const manualModels = [
    { name: 'A1mini', model: 'A1 mini' },
    { name: 'P1SC', model: 'P1S' },
    { name: 'A2L01', model: '' },
    { name: 'A2L02', model: '' },
  ];

  for (const printer of manualModels) {
    assert.equal(isAutoCameraSupported(printer), true);
    assert.equal(getCameraTransport(printer), 'chamber-image');
    assert.match(cameraCompatibilityNote(printer), /6000/);
  }
});

test('renderer camera transport matches the backend chamber-image classifier', () => {
  const { isChamberImageCamera } = require('../../electron/camera-stream.cjs');
  const fixtures = [
    { name: 'H2D', model: 'H2D' },
    { name: 'X1C', model: 'X1 Carbon' },
    { name: 'A1mini', model: 'A1 mini' },
    { name: 'P1SC', model: 'P1S' },
    { name: 'A2L01', model: '' },
    { model: 'P2S' },
    {},
    { model: 'X1E', cameraMode: 'chamber-image' },
    { model: 'A1', cameraMode: 'rtsps' },
  ];

  for (const printer of fixtures) {
    assert.equal(
      getCameraTransport(printer) === 'chamber-image',
      isChamberImageCamera(printer),
      `transport mismatch for ${JSON.stringify(printer)}`,
    );
  }
});

test('only sends the serial number to the NAS camera runtime', () => {
  const source = {
    key: 'SERIAL-1',
    cloudId: 'cloud-secret',
    name: 'A1 mini',
    model: 'A1',
    modelCode: 'N2S',
    cameraMode: 'chamber-image',
    ip: '192.168.1.2',
    accessCode: '12345678',
  };

  assert.deepEqual(buildCameraStartPayload({ kind: 'web' }, source), {
    serialNumber: 'SERIAL-1',
  });
  assert.deepEqual(buildCameraStartPayload({ kind: 'electron' }, source), {
    serialNumber: 'SERIAL-1',
    cloudId: 'cloud-secret',
    name: 'A1 mini',
    model: 'A1',
    modelCode: 'N2S',
    cameraMode: 'chamber-image',
    ip: '192.168.1.2',
    accessCode: '12345678',
  });
  assert.deepEqual(buildCameraStartPayload({ kind: 'electron', accounts: {} }, source), {
    serialNumber: 'SERIAL-1',
    ip: '192.168.1.2',
  });
});

test('managed desktop accounts resolve private camera credentials in the main process', () => {
  assert.equal(isServerManagedCameraSource({ accounts: {} }, { serverSettings: false }), true);
  assert.equal(isServerManagedCameraSource(null, { serverSettings: true }), true);
  assert.equal(isServerManagedCameraSource(null, { serverSettings: false }), false);
});

test('merges and serializes the server camera settings shape', () => {
  const merged = mergeCameraConfig(createDefaultCameraConfig(), {
    autoOpen: true,
    customUrls: { SERIAL: '/custom-camera' },
    ignored: 'value',
  });

  assert.deepEqual(merged, {
    autoOpen: true,
    customUrls: { SERIAL: '/custom-camera' },
  });
  assert.deepEqual(buildServerCameraConfig({ ...merged, ignored: 'value' }), merged);
});
