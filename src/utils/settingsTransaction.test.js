import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettingsTransaction, updateServerSettingsWhenReady } from './settingsTransaction.js';

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

test('opening before Web settings GET resolves cannot PUT default settings', async () => {
  let resolveGet;
  let ready = false;
  const updates = [];
  const serverSettings = {
    camera: { autoOpen: true, customUrls: { SERIAL: 'https://camera.example/live' } },
    notifications: {
      enabled: true,
      targets: [{ id: 'private', url: 'https://notify.example', secret: 'write-only' }],
    },
  };
  const pendingGet = new Promise((resolve) => { resolveGet = resolve; })
    .then((settings) => { ready = true; return settings; });
  const runtime = {
    settings: {
      async update(settings) {
        updates.push(settings);
        return { success: true, settings };
      },
    },
  };

  await assert.rejects(
    updateServerSettingsWhenReady({
      runtime,
      ready,
      settings: {
        camera: { autoOpen: false, customUrls: {} },
        notifications: { enabled: false, targets: [] },
      },
    }),
    /仍在加载/,
  );
  assert.equal(updates.length, 0);

  resolveGet(serverSettings);
  const loadedSettings = await pendingGet;
  await updateServerSettingsWhenReady({ runtime, ready, settings: loadedSettings });
  assert.deepEqual(updates, [serverSettings]);
});
