import test from 'node:test';
import assert from 'node:assert/strict';

import { getPrinterNotificationEvent } from './notifications.js';

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
