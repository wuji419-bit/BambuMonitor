import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWithConcurrency } from './asyncPool.js';

test('limits concurrent work and preserves result order', async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];

  const work = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return value * 10;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 2);
  releases.splice(0, 2).forEach((release) => release());

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 2);
  releases.splice(0, 2).forEach((release) => release());

  assert.deepEqual(await work, [10, 20, 30, 40]);
  assert.equal(maxActive, 2);
});

test('returns an empty result without invoking the worker', async () => {
  let calls = 0;
  const result = await mapWithConcurrency([], 2, async () => {
    calls += 1;
  });

  assert.deepEqual(result, []);
  assert.equal(calls, 0);
});
