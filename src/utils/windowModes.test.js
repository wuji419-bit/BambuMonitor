import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOW_SIZE_STORAGE_KEY,
  getWindowModeConfig,
  normalizeSavedWindowSize,
  readWindowSizeMap,
  updateWindowSizeMap,
} from './windowModes.js';

test('uses the persistent window size storage key', () => {
  assert.equal(WINDOW_SIZE_STORAGE_KEY, 'bambu_window_sizes_v1');
});

test('defines approved defaults and minimums for every desktop mode', () => {
  assert.deepEqual(getWindowModeConfig('full'), {
    defaultSize: { width: 720, height: 620 },
    minSize: { width: 320, height: 300 },
  });
  assert.deepEqual(getWindowModeConfig('compact'), {
    defaultSize: { width: 380, height: 500 },
    minSize: { width: 340, height: 260 },
  });
  assert.deepEqual(getWindowModeConfig('mini'), {
    defaultSize: { width: 300, height: 92 },
    minSize: { width: 240, height: 78 },
  });
  assert.deepEqual(getWindowModeConfig('zoom'), {
    defaultSize: { width: 960, height: 680 },
    minSize: { width: 480, height: 320 },
  });
  assert.deepEqual(getWindowModeConfig('login'), {
    defaultSize: { width: 860, height: 620 },
    minSize: { width: 420, height: 460 },
  });
});

test('falls back to the full configuration for an unknown mode', () => {
  assert.deepEqual(getWindowModeConfig('unknown'), getWindowModeConfig('full'));
});

test('falls back to the full configuration for inherited property names', () => {
  const fullConfig = getWindowModeConfig('full');

  for (const mode of ['toString', 'constructor', '__proto__']) {
    assert.deepEqual(getWindowModeConfig(mode), fullConfig);
  }
});

test('prevents callers from mutating canonical mode configuration', () => {
  const config = getWindowModeConfig('full');
  const snapshot = {
    defaultSize: { ...config.defaultSize },
    minSize: { ...config.minSize },
  };

  try {
    const mutations = [
      () => { config.defaultSize.width = 1; },
      () => { config.minSize.height = 1; },
    ];

    for (const mutate of mutations) {
      try {
        mutate();
      } catch (error) {
        assert.ok(error instanceof TypeError);
      }
    }

    assert.deepEqual(getWindowModeConfig('full'), snapshot);
  } finally {
    if (!Object.isFrozen(config.defaultSize)) Object.assign(config.defaultSize, snapshot.defaultSize);
    if (!Object.isFrozen(config.minSize)) Object.assign(config.minSize, snapshot.minSize);
  }
});

test('rejects non-finite and non-positive saved sizes', () => {
  const invalidSizes = [
    undefined,
    { width: Number.NaN, height: 620 },
    { width: 720, height: Number.POSITIVE_INFINITY },
    { width: 0, height: 620 },
    { width: 720, height: -1 },
  ];

  for (const size of invalidSizes) {
    assert.equal(normalizeSavedWindowSize('full', size), null);
  }
});

test('rejects non-number saved dimensions without coercion', () => {
  for (const value of [true, '720', [720]]) {
    assert.equal(normalizeSavedWindowSize('full', { width: value, height: 620 }), null);
    assert.equal(normalizeSavedWindowSize('full', { width: 720, height: value }), null);
  }
});

test('clamps saved sizes below the mode minimum and rounds valid values', () => {
  assert.deepEqual(
    normalizeSavedWindowSize('compact', { width: 120.4, height: 180.6 }),
    { width: 340, height: 260 },
  );
  assert.deepEqual(
    normalizeSavedWindowSize('zoom', { width: 960.4, height: 680.6 }),
    { width: 960, height: 681 },
  );
});

test('reads valid object storage and treats corrupt or non-object JSON as empty', () => {
  const saved = { full: { width: 700, height: 600 } };

  assert.deepEqual(readWindowSizeMap(JSON.stringify(saved)), saved);
  assert.deepEqual(readWindowSizeMap('{broken'), {});
  assert.deepEqual(readWindowSizeMap('null'), {});
  assert.deepEqual(readWindowSizeMap('42'), {});
  assert.deepEqual(readWindowSizeMap('"sizes"'), {});
  assert.deepEqual(readWindowSizeMap('[]'), {});
});

test('updates one mode without changing other saved modes', () => {
  const current = { full: { width: 700, height: 600 } };

  assert.deepEqual(
    updateWindowSizeMap(current, 'mini', { width: 320.2, height: 92.4 }),
    {
      full: { width: 700, height: 600 },
      mini: { width: 320, height: 92 },
    },
  );
  assert.deepEqual(current, { full: { width: 700, height: 600 } });
});

test('ignores an invalid window size update', () => {
  const current = { full: { width: 700, height: 600 } };
  const snapshot = { full: { ...current.full } };
  const updated = updateWindowSizeMap(current, 'mini', { width: 0, height: 92 });

  assert.deepEqual(updated, snapshot);
  assert.notStrictEqual(updated, current);
  assert.deepEqual(current, snapshot);
});
