import test from 'node:test';
import assert from 'node:assert/strict';

import { createMiniPage, MINI_DEVICE_MIN_WIDTH } from './miniLayout.js';

const devices = ['A', 'B', 'C', 'D', 'E'];

test('falls back to one readable mini device when width is unavailable', () => {
  assert.deepEqual(createMiniPage(devices, 0, 0), {
    capacity: 1,
    pageCount: 5,
    pageIndex: 0,
    devices: ['A'],
  });
});

test('reveals more devices as the mini strip widens', () => {
  assert.equal(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 0).capacity, 2);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 3, 0).devices, ['A', 'B', 'C']);
});

test('rotates complete pages and wraps overflow indexes', () => {
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 1).devices, ['C', 'D']);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 2).devices, ['E']);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 3).devices, ['A', 'B']);
});

test('keeps an empty device list on a stable first page', () => {
  assert.deepEqual(createMiniPage([], MINI_DEVICE_MIN_WIDTH * 4, 8), {
    capacity: 1,
    pageCount: 1,
    pageIndex: 0,
    devices: [],
  });
});
