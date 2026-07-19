import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInitialCameraState,
  cameraStartWithTimeout,
  cameraStartErrorState,
  cameraStartResultState,
  getCameraRetryDelay,
  isCameraSourceRetryable,
} from './cameraStartup.js';

test('marks startable cameras as pending immediately', () => {
  const state = buildInitialCameraState({
    key: 'A2L02_SERIAL',
    name: 'A2L02',
    ip: '192.0.2.94',
    accessCode: '12345678',
    autoCameraSupported: true,
  });

  assert.equal(state.shouldStart, true);
  assert.deepEqual(state.stream, { success: false, pending: true });
  assert.deepEqual(state.imageState, { status: 'loading' });
});

test('starts server-managed cameras without browser credentials', () => {
  const state = buildInitialCameraState({
    key: 'NAS_SERIAL',
    serverManaged: true,
  });

  assert.equal(state.shouldStart, true);
  assert.deepEqual(state.stream, { success: false, pending: true });
  assert.deepEqual(state.imageState, { status: 'loading' });
});

test('times out a hung camera-start call', async () => {
  await assert.rejects(
    cameraStartWithTimeout(new Promise(() => {}), 5, 'A2L02'),
    /A2L02/,
  );
});

test('normalizes camera start results and errors', () => {
  assert.deepEqual(
    cameraStartResultState({ success: true, url: 'http://127.0.0.1/camera/a', mode: 'chamber-image-mjpeg' }),
    {
      stream: { success: true, url: 'http://127.0.0.1/camera/a', mode: 'chamber-image-mjpeg' },
      imageState: { status: 'loading' },
    },
  );

  assert.deepEqual(cameraStartErrorState(new Error('boom')), {
    stream: { success: false, error: 'boom' },
    imageState: { status: 'error', message: 'boom' },
  });
});

test('bounds automatic camera retries', () => {
  assert.equal(getCameraRetryDelay(0), 1500);
  assert.equal(getCameraRetryDelay(1), 4000);
  assert.equal(getCameraRetryDelay(2), null);
});

test('keeps server-managed custom camera sources retryable', () => {
  assert.equal(isCameraSourceRetryable({
    serverManaged: true,
    customUrl: 'https://camera.internal/stream',
  }), true);
  assert.equal(isCameraSourceRetryable({
    customUrl: 'https://camera.internal/stream',
    ip: '192.168.1.2',
    accessCode: '12345678',
    autoCameraSupported: true,
  }), false);
});
