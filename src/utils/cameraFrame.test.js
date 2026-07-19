import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCameraFrameUrl,
  createVisibilityAwareCameraPoller,
  isChamberSnapshotStream,
  usesCameraStartupTimeout,
} from './cameraFrame.js';

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

test('pauses NAS polling beyond startup timeout and resumes without exhausting it', async () => {
  assert.equal(usesCameraStartupTimeout({
    success: true,
    mode: 'nas-gateway',
    snapshotUrl: '/frame',
    url: '/stream',
  }), false);

  let nextTimer = 1;
  let now = 0;
  const timers = new Map();
  const requests = [];
  const poller = createVisibilityAwareCameraPoller({
    documentVisible: true,
    cardVisible: false,
    setTimeoutImpl(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    async poll(signal) {
      requests.push(signal);
      if (requests.length > 1) return;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });

  const runNext = async () => {
    const entry = [...timers.entries()].sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
    assert.ok(entry, 'expected a scheduled camera poll');
    const [id, timer] = entry;
    timers.delete(id);
    now = timer.dueAt;
    await timer.callback();
  };
  const advanceBy = async (duration) => {
    const target = now + duration;
    while ([...timers.values()].some((timer) => timer.dueAt <= target)) {
      await runNext();
    }
    now = target;
  };

  poller.start();
  assert.equal(timers.size, 0, 'offscreen cards do not start the timeout budget');
  poller.setVisibility({ cardVisible: true });
  const firstPoll = runNext();
  await Promise.resolve();
  assert.equal(requests.length, 1);

  poller.setVisibility({ documentVisible: false });
  await firstPoll;
  assert.equal(requests[0].aborted, true);
  await advanceBy(30_000);
  assert.equal(timers.size, 0, 'hidden time beyond eight seconds schedules no failures');
  assert.equal(requests.length, 1);

  poller.setVisibility({ documentVisible: true });
  await runNext();
  assert.equal(requests.length, 2, 'visibility restoration resumes requests');
  poller.stop();
  assert.equal(timers.size, 0);
});
