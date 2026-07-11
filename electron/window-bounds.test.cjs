const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  clampWindowSize,
  createWindowBoundsCloseHandshake,
  createWindowBoundsSaveRequestHandler,
  getMainWindowOptions,
  withCurrentWindowSize,
} = require('./window-bounds.cjs');
const packageJson = require('../package.json');

test('packages the native window bounds helper with the Electron main process', () => {
  assert.ok(packageJson.build.files.includes('electron/window-bounds.cjs'));
});

test('keeps the sandboxed preload free of local CommonJS imports', () => {
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.doesNotMatch(preload, /require\(['"]\.\//);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(['"]bambuApi['"]/);
});

test('builds native resizable window options while preserving supplied bounds', () => {
  const bounds = {
    width: 400,
    height: 580,
    x: 120,
    y: 80,
    frame: true,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
  };
  const snapshot = { ...bounds };

  const options = getMainWindowOptions(bounds);

  assert.deepEqual(options, {
    width: 400,
    height: 580,
    x: 120,
    y: 80,
    frame: false,
    transparent: false,
    backgroundColor: '#0b1017',
    hasShadow: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    useContentSize: true,
  });
  assert.deepEqual(bounds, snapshot);
  assert.equal(Object.hasOwn(options, 'webPreferences'), false);
  assert.equal(Object.hasOwn(options, 'alwaysOnTop'), false);
});

test('clamps the plan example to the display work area and default minimums', () => {
  assert.deepEqual(
    clampWindowSize(
      { width: 2000, height: 100 },
      { width: 1920, height: 1080 },
    ),
    { width: 1896, height: 300, minWidth: 320, minHeight: 300 },
  );
});

test('uses custom minimums, hard floors, and rounded requested dimensions', () => {
  assert.deepEqual(
    clampWindowSize(
      { width: 500.6, height: 400.4, minWidth: 340, minHeight: 260 },
      { width: 1000, height: 800 },
    ),
    { width: 501, height: 400, minWidth: 340, minHeight: 260 },
  );
  assert.deepEqual(
    clampWindowSize(
      { width: 1, height: 1, minWidth: 20, minHeight: 20 },
      { width: 1000, height: 800 },
    ),
    { width: 96, height: 56, minWidth: 96, minHeight: 56 },
  );
});

test('ceils fractional minimums before clamping rounded dimensions', () => {
  const result = clampWindowSize(
    { width: 320.1, height: 260.1, minWidth: 320.2, minHeight: 260.8 },
    { width: 1000, height: 800 },
  );

  assert.deepEqual(result, {
    width: 321,
    height: 261,
    minWidth: 321,
    minHeight: 261,
  });
  assert.ok(result.width >= result.minWidth);
  assert.ok(result.height >= result.minHeight);
});

test('caps unsafe and huge renderer dimensions to safe work area integers', () => {
  const result = clampWindowSize(
    {
      width: Number.MAX_VALUE,
      height: Number.MAX_SAFE_INTEGER + 1,
      minWidth: Number.MAX_VALUE,
      minHeight: Number.MAX_SAFE_INTEGER + 1,
    },
    { width: 1920, height: 1080 },
  );

  assert.deepEqual(result, {
    width: 1896,
    height: 1056,
    minWidth: 1896,
    minHeight: 1056,
  });
  assert.ok(Object.values(result).every(Number.isSafeInteger));
});

test('falls back safely for malformed bounds and work areas', () => {
  const result = clampWindowSize(
    {
      width: '2000',
      height: Number.NaN,
      minWidth: Number.POSITIVE_INFINITY,
      minHeight: '300',
    },
    {
      width: '1920',
      height: Number.NEGATIVE_INFINITY,
    },
  );

  assert.deepEqual(result, {
    width: 320,
    height: 300,
    minWidth: 320,
    minHeight: 300,
  });
  assert.ok(Object.values(result).every(Number.isFinite));
});

test('treats unsafe work area dimensions as malformed', () => {
  assert.deepEqual(
    clampWindowSize(
      { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
      { width: Number.MAX_VALUE, height: Number.MAX_SAFE_INTEGER + 1 },
    ),
    { width: 320, height: 300, minWidth: 320, minHeight: 300 },
  );
});

test('caps minimums to small work areas without crossing absolute floors', () => {
  assert.deepEqual(
    clampWindowSize(
      { width: 900, height: 700, minWidth: 400, minHeight: 320 },
      { width: 300, height: 200 },
    ),
    { width: 276, height: 176, minWidth: 276, minHeight: 176 },
  );
  assert.deepEqual(
    clampWindowSize(
      { width: 900, height: 700, minWidth: 400, minHeight: 320 },
      { width: 80, height: 40 },
    ),
    { width: 96, height: 56, minWidth: 96, minHeight: 56 },
  );
});

test('fills only omitted resize axes from the current content size', () => {
  assert.deepEqual(
    clampWindowSize(
      withCurrentWindowSize(
        { height: 700, minWidth: 320, minHeight: 300 },
        [640, 480],
      ),
      { width: 1920, height: 1080 },
    ),
    { width: 640, height: 700, minWidth: 320, minHeight: 300 },
  );
  assert.deepEqual(
    withCurrentWindowSize({ width: 'invalid' }, [640, 480]),
    { width: 'invalid', height: 480 },
  );
});

test('continues an ordinary window close once after a matching ack', () => {
  const sender = {};
  const otherSender = {};
  const requests = [];
  const timers = [];
  const clearedTimers = [];
  let windowCloseCount = 0;
  let appQuitCount = 0;
  const quitIntent = false;
  const handshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => 'request-1',
    sendRequest: (target, payload) => requests.push({ target, payload }),
    continueClose: () => {
      if (quitIntent) appQuitCount += 1;
      else windowCloseCount += 1;
    },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => clearedTimers.push(timer),
    timeoutMs: 300,
  });

  assert.equal(handshake.begin(sender, { width: 640, height: 480 }), true);
  assert.equal(handshake.begin(sender, { width: 800, height: 600 }), false);
  assert.deepEqual(requests, [{
    target: sender,
    payload: { requestId: 'request-1', width: 640, height: 480 },
  }]);
  assert.equal(timers[0].delay, 300);
  assert.equal(handshake.acknowledge(otherSender, 'request-1'), false);
  assert.equal(handshake.acknowledge(sender, 'wrong-request'), false);
  assert.equal(windowCloseCount, 0);
  assert.equal(appQuitCount, 0);
  assert.equal(handshake.isWaiting(), true);

  assert.equal(handshake.acknowledge(sender, 'request-1'), true);
  assert.equal(handshake.shouldAllowClose(), true);
  assert.equal(windowCloseCount, 1);
  assert.equal(appQuitCount, 0);
  assert.deepEqual(clearedTimers, [timers[0]]);

  assert.equal(handshake.acknowledge(sender, 'request-1'), false);
  timers[0].callback();
  assert.equal(windowCloseCount, 1);
  assert.equal(appQuitCount, 0);
});

test('continues app quit once after a matching ack', () => {
  const sender = {};
  const timers = [];
  let windowCloseCount = 0;
  let appQuitCount = 0;
  const quitIntent = true;
  const handshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => 'quit-ack-request',
    sendRequest: () => {},
    continueClose: () => {
      if (quitIntent) appQuitCount += 1;
      else windowCloseCount += 1;
    },
    setTimeoutFn: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
    timeoutMs: 300,
  });

  handshake.begin(sender, { width: 640, height: 480 });
  assert.equal(handshake.acknowledge(sender, 'quit-ack-request'), true);
  assert.equal(appQuitCount, 1);
  assert.equal(windowCloseCount, 0);

  assert.equal(handshake.acknowledge(sender, 'quit-ack-request'), false);
  timers[0]();
  assert.equal(appQuitCount, 1);
  assert.equal(windowCloseCount, 0);
});

test('continues app quit once after the fallback timeout', () => {
  const sender = {};
  const timeoutCallbacks = [];
  let windowCloseCount = 0;
  let appQuitCount = 0;
  const quitIntent = true;
  const handshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => 'quit-timeout-request',
    sendRequest: () => {},
    continueClose: () => {
      if (quitIntent) appQuitCount += 1;
      else windowCloseCount += 1;
    },
    setTimeoutFn: (callback) => {
      timeoutCallbacks.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
    timeoutMs: 300,
  });

  handshake.begin(sender, { width: 640, height: 480 });
  timeoutCallbacks[0]();
  timeoutCallbacks[0]();
  assert.equal(appQuitCount, 1);
  assert.equal(windowCloseCount, 0);
  assert.equal(handshake.shouldAllowClose(), true);
});

test('continues an ordinary timeout once and cancels timeout work when disposed', () => {
  const sender = {};
  const timeoutCallbacks = [];
  let timeoutCloseCount = 0;
  const timeoutHandshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => 'timeout-request',
    sendRequest: () => {},
    continueClose: () => { timeoutCloseCount += 1; },
    setTimeoutFn: (callback) => {
      timeoutCallbacks.push(callback);
      return callback;
    },
    clearTimeoutFn: () => {},
    timeoutMs: 300,
  });

  timeoutHandshake.begin(sender, { width: 640, height: 480 });
  timeoutCallbacks[0]();
  timeoutCallbacks[0]();
  assert.equal(timeoutCloseCount, 1);
  assert.equal(timeoutHandshake.shouldAllowClose(), true);

  const disposedCallbacks = [];
  const clearedTimers = [];
  let disposedCloseCount = 0;
  const disposedHandshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => 'disposed-request',
    sendRequest: () => {},
    continueClose: () => { disposedCloseCount += 1; },
    setTimeoutFn: (callback) => {
      disposedCallbacks.push(callback);
      return callback;
    },
    clearTimeoutFn: (timer) => clearedTimers.push(timer),
    timeoutMs: 300,
  });

  disposedHandshake.begin(sender, { width: 640, height: 480 });
  disposedHandshake.dispose();
  disposedCallbacks[0]();
  assert.equal(disposedCloseCount, 0);
  assert.deepEqual(clearedTimers, [disposedCallbacks[0]]);
  assert.equal(disposedHandshake.acknowledge(sender, 'disposed-request'), false);
});

test('acks a save request only after its async callback completes', async () => {
  const events = [];
  let resolveSave;
  const handler = createWindowBoundsSaveRequestHandler(
    async (payload) => {
      events.push(`start:${payload.requestId}`);
      await new Promise((resolve) => { resolveSave = resolve; });
      events.push(`saved:${payload.requestId}`);
    },
    (requestId) => events.push(`ack:${requestId}`),
  );

  const pending = handler({ requestId: 'async-request', width: 640, height: 480 });
  await Promise.resolve();
  assert.deepEqual(events, ['start:async-request']);

  resolveSave();
  await pending;
  assert.deepEqual(events, [
    'start:async-request',
    'saved:async-request',
    'ack:async-request',
  ]);
});

test('acks a save request when its callback throws', async () => {
  const acknowledgements = [];
  const handler = createWindowBoundsSaveRequestHandler(
    () => { throw new Error('save failed'); },
    (requestId) => acknowledgements.push(requestId),
  );

  await assert.doesNotReject(() => handler({ requestId: 'failed-request' }));
  assert.deepEqual(acknowledgements, ['failed-request']);
});
