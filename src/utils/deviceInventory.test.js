import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRemovedPrinterIds,
  reconcilePrinterInventory,
} from './deviceInventory.js';

test('adds newly bound devices while preserving live telemetry', () => {
  const current = [{
    dev_id: 'A1_LOCAL_SERIAL',
    cloudId: 'A1_CLOUD_ID',
    name: 'Old A1 name',
    status: 'printing',
    progress: 47,
    temperature: { nozzle: 220, bed: 60 },
    ip: '192.168.1.10',
  }];
  const synced = [
    {
      dev_id: 'A1_LOCAL_SERIAL',
      cloudId: 'A1_CLOUD_ID',
      name: 'A1 mini',
      status: 'connecting',
      progress: 0,
      temperature: { nozzle: 0, bed: 0 },
      ip: '192.168.1.11',
    },
    {
      dev_id: 'P1_SERIAL',
      cloudId: 'P1_CLOUD_ID',
      name: 'P1S',
      status: 'connecting',
      progress: 0,
    },
  ];

  const next = reconcilePrinterInventory(current, synced);

  assert.equal(next.length, 2);
  assert.deepEqual(next[0], {
    ...current[0],
    name: 'A1 mini',
    ip: '192.168.1.11',
  });
  assert.equal(next[1].name, 'P1S');
});

test('uses cloud id to preserve telemetry when local serial changes', () => {
  const next = reconcilePrinterInventory(
    [{ dev_id: 'OLD_SERIAL', cloudId: 'CLOUD_ID', status: 'printing', progress: 81 }],
    [{ dev_id: 'NEW_SERIAL', cloudId: 'CLOUD_ID', status: 'connecting', progress: 0 }],
  );

  assert.equal(next[0].dev_id, 'NEW_SERIAL');
  assert.equal(next[0].status, 'printing');
  assert.equal(next[0].progress, 81);
});

test('removes devices absent from the authoritative sync list', () => {
  const current = [
    { dev_id: 'KEEP', cloudId: 'KEEP' },
    { dev_id: 'REMOVE', cloudId: 'REMOVE' },
  ];
  const synced = [{ dev_id: 'KEEP', cloudId: 'KEEP' }];

  assert.deepEqual(reconcilePrinterInventory(current, synced), [synced[0]]);
  assert.deepEqual(getRemovedPrinterIds(current, synced), ['REMOVE']);
});
