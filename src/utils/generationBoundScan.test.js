import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerationBoundScan } from './generationBoundScan.js';

test('stale scan performs no snapshot or cache mutation', async () => {
  let builds = 0;
  const merged = await runGenerationBoundScan({ scan: async () => ['device'], expectedGeneration: 2, isCurrent: () => false, buildSnapshot: () => { builds += 1; }, mergeSnapshot: () => {} });
  assert.equal(merged, false);
  assert.equal(builds, 0);
});

test('current scan builds and merges once', async () => {
  let builds = 0; let merges = 0;
  const merged = await runGenerationBoundScan({ scan: async () => ['device'], expectedGeneration: 2, isCurrent: () => true, buildSnapshot: (devices) => { builds += 1; return devices; }, mergeSnapshot: () => { merges += 1; } });
  assert.equal(merged, true);
  assert.equal(builds, 1);
  assert.equal(merges, 1);
});
