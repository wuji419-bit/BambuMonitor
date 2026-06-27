import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCameraZoomState } from './cameraZoom.js';

test('builds zoom state for chamber snapshot streams', () => {
  const state = buildCameraZoomState({
    key: 'A2L02',
    printer: { name: 'A2L02', ip: '192.0.2.94' },
    stream: {
      success: true,
      mode: 'chamber-image-mjpeg',
      snapshotUrl: 'http://127.0.0.1:1234/camera-frame/A2L02?v=1',
    },
    imageState: { status: 'ready' },
  });

  assert.equal(state.canZoom, true);
  assert.equal(state.isSnapshotStream, true);
  assert.equal(state.imageUrl, 'http://127.0.0.1:1234/camera-frame/A2L02?v=1');
  assert.equal(state.title, 'A2L02');
});

test('does not zoom cameras without a ready image URL', () => {
  const state = buildCameraZoomState({
    key: 'P1SC',
    printer: { name: 'P1SC' },
    stream: { success: false, pending: true },
    imageState: { status: 'loading' },
  });

  assert.equal(state.canZoom, false);
});
