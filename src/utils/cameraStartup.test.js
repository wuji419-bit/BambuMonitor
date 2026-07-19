import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInitialCameraState,
  activateCameraWorkspace,
  cameraStartWithTimeout,
  cameraStartErrorState,
  cameraStartResultState,
  cleanupCameraWorkspace,
  createCameraWorkspaceLifecycle,
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

test('unmount cleanup invalidates pending camera starts and releases timers and runtime', async () => {
  const lifecycle = createCameraWorkspaceLifecycle();
  lifecycle.activate();
  const token = lifecycle.capture();
  let resolveStart;
  const pendingStart = new Promise((resolve) => { resolveStart = resolve; });
  let stateWrites = 0;
  let restarts = 0;
  const completion = pendingStart.then(() => lifecycle.runIfCurrent(token, () => {
    stateWrites += 1;
    restarts += 1;
  }));
  const cleared = [];
  let stopAllCalls = 0;
  const cameraWallOpenRef = { current: true };
  const cameraRetryTimersRef = { current: { A: 11, B: 12 } };
  const cameraRetryAttemptsRef = { current: { A: 2 } };
  const restartCameraRef = { current: () => { restarts += 1; } };

  await cleanupCameraWorkspace({
    lifecycle,
    cameraWallOpenRef,
    cameraRetryTimersRef,
    cameraRetryAttemptsRef,
    restartCameraRef,
    clearTimeoutImpl: (timer) => cleared.push(timer),
    stopAll: async () => { stopAllCalls += 1; },
  });
  resolveStart({ success: true });
  await completion;

  assert.deepEqual(cleared.sort(), [11, 12]);
  assert.deepEqual(cameraRetryTimersRef.current, {});
  assert.deepEqual(cameraRetryAttemptsRef.current, {});
  assert.equal(cameraWallOpenRef.current, false);
  assert.equal(restartCameraRef.current, null);
  assert.equal(stopAllCalls, 1);
  assert.equal(stateWrites, 0);
  assert.equal(restarts, 0);
});

test('runtime replacement reactivates camera state after the old runtime cleanup', async () => {
  const lifecycle = createCameraWorkspaceLifecycle();
  const cameraWallOpenRef = { current: true };
  await cleanupCameraWorkspace({ lifecycle, cameraWallOpenRef, stopAll: async () => {} });
  assert.equal(cameraWallOpenRef.current, false);

  const token = activateCameraWorkspace({ lifecycle, cameraWallOpenRef });
  assert.equal(cameraWallOpenRef.current, true);
  assert.equal(lifecycle.isCurrent(token), true);
});
