import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettingsTransaction } from './settingsTransaction.js';

test('startup rejection never invokes local commit', async () => {
  const calls = [];
  await assert.rejects(applySettingsTransaction({ startupChanged: true, applyStartup: async () => { calls.push('startup'); throw new Error('denied'); }, commitLocal: async () => calls.push('commit'), rollbackStartup: async () => calls.push('rollback-startup'), rollbackLocal: async () => calls.push('rollback-local') }), /denied/);
  assert.deepEqual(calls, ['startup']);
});

test('successful startup is followed by local commit', async () => {
  const calls = [];
  await applySettingsTransaction({ startupChanged: true, applyStartup: async () => calls.push('startup'), commitLocal: async () => calls.push('commit'), rollbackStartup: async () => calls.push('rollback-startup'), rollbackLocal: async () => calls.push('rollback-local') });
  assert.deepEqual(calls, ['startup', 'commit']);
});

test('local commit failure rolls local state and startup back', async () => {
  const calls = [];
  await assert.rejects(applySettingsTransaction({ startupChanged: true, applyStartup: async () => calls.push('startup'), commitLocal: async () => { calls.push('commit'); throw new Error('disk full'); }, rollbackStartup: async () => calls.push('rollback-startup'), rollbackLocal: async () => calls.push('rollback-local') }), /disk full/);
  assert.deepEqual(calls, ['startup', 'commit', 'rollback-local', 'rollback-startup']);
});
