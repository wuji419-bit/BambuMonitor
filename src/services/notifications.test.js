import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildServerNotificationConfig,
  createDefaultNotificationConfig,
  getPrinterNotificationEvent,
  mergeNotificationConfig,
  sendTestNotification,
} from './notifications.js';

test('emits print completion from job status transition', () => {
  assert.equal(
    getPrinterNotificationEvent(
      { status: 'printing', connectionState: 'online' },
      { status: 'finished', connectionState: 'online' },
    ),
    'print_finished',
  );
});

test('emits disconnect while preserving an active print status', () => {
  assert.equal(
    getPrinterNotificationEvent(
      { status: 'printing', connectionState: 'online' },
      { status: 'printing', connectionState: 'offline' },
    ),
    'printer_disconnected',
  );
});

test('emits recovery from connection state transition', () => {
  assert.equal(
    getPrinterNotificationEvent(
      { status: 'printing', connectionState: 'offline' },
      { status: 'printing', connectionState: 'online' },
    ),
    'printer_recovered',
  );
});

test('does not notify for a transient reconnect state', () => {
  assert.equal(
    getPrinterNotificationEvent(
      { status: 'printing', connectionState: 'online' },
      { status: 'printing', connectionState: 'reconnecting' },
    ),
    null,
  );
});

test('keeps cooldown local while serializing server notification settings', () => {
  const merged = mergeNotificationConfig(createDefaultNotificationConfig(), {
    enabled: true,
    targets: [{ id: 'openclaw', enabled: true, url: 'https://notify.test', secret: 'server-secret' }],
    ignored: 'value',
  });

  assert.equal(merged.cooldownMs, 30_000);
  assert.equal(merged.targets[0].secret, 'server-secret');
  assert.deepEqual(buildServerNotificationConfig(merged), {
    enabled: true,
    targets: merged.targets,
  });
});

test('uses the selected runtime for Web notification tests', async () => {
  const calls = [];
  const runtime = {
    kind: 'web',
    notifications: {
      async send(...args) {
        calls.push(args);
        return { success: true, sent: true };
      },
    },
  };

  assert.deepEqual(await sendTestNotification({ id: 'openclaw' }, runtime), {
    success: true,
    sent: true,
  });
  assert.deepEqual(calls, [[]]);
});
