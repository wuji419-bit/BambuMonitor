import assert from 'node:assert/strict';
import test from 'node:test';
import { getPreviewViewMode, shouldLoadServerSettings } from './previewMode.js';

test('loads server settings only for a normal Web runtime', () => {
  assert.equal(shouldLoadServerSettings({ serverSettings: true }, false), true);
  assert.equal(shouldLoadServerSettings({ serverSettings: false }, false), false);
  assert.equal(shouldLoadServerSettings({ serverSettings: true }, true), false);
});

test('normalizes preview window modes from the query string', () => {
  assert.equal(getPreviewViewMode('?preview=dashboard&mode=compact'), 'compact');
  assert.equal(getPreviewViewMode('?mode=mini'), 'mini');
  assert.equal(getPreviewViewMode('?mode=zoom'), 'full');
  assert.equal(getPreviewViewMode(''), 'full');
});
