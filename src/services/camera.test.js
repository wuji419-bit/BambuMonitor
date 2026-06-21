import test from 'node:test';
import assert from 'node:assert/strict';

import { cameraCompatibilityNote, getCameraTransport, isAutoCameraSupported } from './camera.js';

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
