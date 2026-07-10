import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPrinterConnectionState,
  getPrinterJobStatus,
  getPrinterSummary,
  sortPrintersForDisplay,
} from './printerPresentation.js';

test('keeps job status independent from reconnecting transport state', () => {
  const printer = {
    status: 'printing',
    connectionState: 'reconnecting',
    progress: 63,
  };

  assert.equal(getPrinterJobStatus(printer), 'printing');
  assert.equal(getPrinterConnectionState(printer), 'reconnecting');
});

test('does not count reconnecting printers as online or lose active print count', () => {
  const summary = getPrinterSummary([
    { dev_id: 'A', status: 'printing', connectionState: 'online' },
    { dev_id: 'B', status: 'printing', connectionState: 'reconnecting' },
    { dev_id: 'C', status: 'paused', connectionState: 'offline' },
    { dev_id: 'D', status: 'idle', connectionState: 'online' },
  ]);

  assert.deepEqual(summary, {
    total: 4,
    online: 2,
    printing: 2,
    reconnecting: 1,
    attention: 2,
  });
});

test('infers connection state for legacy printer snapshots', () => {
  assert.equal(getPrinterConnectionState({ status: 'printing' }), 'online');
  assert.equal(getPrinterConnectionState({ status: 'connecting' }), 'connecting');
  assert.equal(getPrinterConnectionState({ status: 'disconnected' }), 'offline');
  assert.equal(getPrinterConnectionState({ status: 'cloud_offline' }), 'offline');
});

test('sorts attention and active work before idle and completed printers', () => {
  const printers = [
    { dev_id: 'finished', status: 'finished', connectionState: 'online' },
    { dev_id: 'idle', status: 'idle', connectionState: 'online' },
    { dev_id: 'printing', status: 'printing', connectionState: 'online' },
    { dev_id: 'paused', status: 'paused', connectionState: 'online' },
    { dev_id: 'offline', status: 'printing', connectionState: 'offline' },
  ];

  assert.deepEqual(
    sortPrintersForDisplay(printers).map((printer) => printer.dev_id),
    ['offline', 'paused', 'printing', 'idle', 'finished'],
  );
});
