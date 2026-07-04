import test from 'node:test';
import assert from 'node:assert/strict';

import { dragRegionStyle, noDragRegionStyle } from './windowDragRegions.js';

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
