import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCameraFrameUrl, isChamberSnapshotStream } from './cameraFrame.js';

test('recognizes chamber snapshot streams that should be actively repainted', () => {
  assert.equal(isChamberSnapshotStream({ mode: 'chamber-image-mjpeg', snapshotUrl: 'http://127.0.0.1:2322/camera-frame/a' }), true);
  assert.equal(isChamberSnapshotStream({ mode: 'rtsps-mjpeg', snapshotUrl: 'http://127.0.0.1:2322/camera-frame/a' }), false);
  assert.equal(isChamberSnapshotStream({ mode: 'chamber-image-mjpeg', url: 'http://127.0.0.1:2322/camera/a' }), false);
});

test('builds a fresh frame URL without losing the original snapshot token', () => {
  assert.equal(
    buildCameraFrameUrl('http://127.0.0.1:2322/camera-frame/A2L02?v=123', 42),
    'http://127.0.0.1:2322/camera-frame/A2L02?v=123&frame=42',
  );

  assert.equal(
    buildCameraFrameUrl('http://127.0.0.1:2322/camera-frame/A2L02?v=123&frame=41', 42),
    'http://127.0.0.1:2322/camera-frame/A2L02?v=123&frame=42',
  );
});
