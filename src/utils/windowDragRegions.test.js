import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dragRegionStyle,
  legacySurfaceDragStyle,
  miniSurfaceDragStyle,
  noDragRegionStyle,
} from './windowDragRegions.js';

test('keeps zoom preview title bar draggable while controls stay clickable', () => {
  assert.deepEqual(dragRegionStyle(false), {
    WebkitAppRegion: 'drag',
    cursor: 'move',
  });
  assert.deepEqual(noDragRegionStyle(), {
    WebkitAppRegion: 'no-drag',
  });
});

test('disables drag regions when the widget is locked', () => {
  assert.deepEqual(dragRegionStyle(true), {
    WebkitAppRegion: 'no-drag',
    cursor: 'default',
  });
});

test('makes the mini surface draggable only in unlocked Electron windows', () => {
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: false, isNativeWindow: true }), {
    WebkitAppRegion: 'drag',
    cursor: 'move',
  });
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: true, isNativeWindow: true }), {
    WebkitAppRegion: 'no-drag',
    cursor: 'default',
  });
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: false, isNativeWindow: false }), {
    WebkitAppRegion: 'no-drag',
    cursor: 'default',
  });
});

test('keeps the legacy container draggable around the mini surface', () => {
  assert.deepEqual(legacySurfaceDragStyle({
    isMini: true,
    isLocked: false,
    isNativeWindow: true,
  }), {
    WebkitAppRegion: 'drag',
    cursor: 'move',
  });
  assert.deepEqual(legacySurfaceDragStyle({
    isMini: true,
    isLocked: true,
    isNativeWindow: true,
  }), {
    WebkitAppRegion: 'no-drag',
  });
  assert.deepEqual(legacySurfaceDragStyle({
    isMini: false,
    isLocked: false,
    isNativeWindow: true,
  }), {
    WebkitAppRegion: 'no-drag',
  });
});
