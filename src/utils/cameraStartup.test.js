import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInitialCameraState,
  cameraStartWithTimeout,
  cameraStartErrorState,
  cameraStartResultState,
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
