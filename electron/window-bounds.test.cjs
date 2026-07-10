const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampWindowSize,
  getMainWindowOptions,
} = require('./window-bounds.cjs');

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

test('never lowers maximum dimensions below the requested minimums', () => {
  assert.deepEqual(
    clampWindowSize(
      { width: 900, height: 700, minWidth: 400, minHeight: 320 },
      { width: 300, height: 200 },
    ),
    { width: 400, height: 320, minWidth: 400, minHeight: 320 },
  );
});
