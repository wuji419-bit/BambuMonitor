import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./monitor.css', import.meta.url), 'utf8');

test('keeps the visible camera zoom identity draggable while actions remain clickable', () => {
  assert.match(
    css,
    /\.monitor-content \.camera-zoom__identity(?:,\s*\.monitor-content \.camera-zoom__identity \*)?\s*\{[^}]*-webkit-app-region:\s*drag;/s,
  );
  assert.match(
    css,
    /\.camera-zoom__actions\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
  );
});

test('keeps every mini device descendant draggable while actions remain clickable', () => {
  assert.match(
    css,
    /\.mini-monitor(?:,\s*\.mini-monitor \*)?\s*\{[^}]*-webkit-app-region:\s*drag;/s,
  );
  assert.match(
    css,
    /\.mini-actions(?:,\s*\.mini-actions \*)?\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
  );
  assert.match(
    css,
    /\.monitor-shell\.is-locked \.mini-monitor(?:,\s*\.monitor-shell\.is-locked \.mini-monitor \*)?\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
  );
});
