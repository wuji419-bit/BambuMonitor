import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPrinterTelemetry,
  formatPrinterRemainingTime,
  refreshPrinterRemainingTime,
} from './printerTelemetry.js';

const NOW = 1_700_000_000_000;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertNoNaN(value) {
  if (typeof value === 'number') {
    assert.equal(Number.isNaN(value), false);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const child of Object.values(value)) assertNoNaN(child);
}

function createPrinter(overrides = {}) {
  return {
    dev_id: 'SERIAL_A',
    status: 'printing',
    jobStatus: 'printing',
    connectionState: 'reconnecting',
    progress: 10,
    timeLeft: '45m',
    layer: '1/10',
    temperature: { nozzle: 200, bed: 60, chamber: 35 },
    fan: 30,
    speed: 100,
    filename: 'old.3mf',
    ams: {
      activeAmsIndex: 0,
      activeTrayIndex: 1,
      units: [{ index: 0, trays: [{ id: 1, name: 'PLA' }] }],
    },
    untouched: { keep: true },
    ...overrides,
  };
}

test('applies wrapped print telemetry without mutating prior nested state', () => {
  const previous = createPrinter();
  const snapshot = structuredClone(previous);
  deepFreeze(previous);

  const next = applyPrinterTelemetry(previous, {
    print: {
      mc_percent: 125,
      gcode_state: 'RUNNING',
      mc_remaining_time: 125,
      layer_num: 12,
      total_layer_num: 200,
      nozzle_temper: 219.6,
      bed_temper: 59.5,
      chamber_temper: 37.4,
      cooling_fan_speed: 127.5,
      spd_lvl: 4,
      subtask_name: 'C:\\jobs\\part.3mf',
    },
  }, { now: NOW });

  assert.notEqual(next, previous);
  assert.notEqual(next.temperature, previous.temperature);
  assert.equal(next.ams, previous.ams);
  assert.equal(next.untouched, previous.untouched);
  assert.deepEqual(previous, snapshot);
  assert.deepEqual(next.temperature, { nozzle: 220, bed: 60, chamber: 37 });
  assert.equal(next.connectionState, 'online');
  assert.equal(next.lastTelemetryAt, NOW);
  assert.equal(next.status, 'printing');
  assert.equal(next.jobStatus, 'printing');
  assert.equal(next.progress, 100);
  assert.equal(next.timeLeft, '2h 5m');
  assert.equal(next.remainingMinutesRaw, 125);
  assert.equal(next.remainingUpdatedAt, NOW);
  assert.equal(next.remainingStatus, 'printing');
  assert.equal(next.layer, '12/200');
  assert.equal(next.fan, 50);
  assert.equal(next.speed, 166);
  assert.equal(next.filename, 'part.3mf');
});

test('handles direct telemetry, clamps low progress, and maps filament drying', () => {
  const next = applyPrinterTelemetry(createPrinter(), {
    mc_percent: -12,
    gcode_state: 'RUNNING',
    gcode_file: '/cache/filament_drying.gcode',
    remaining_time: 2.2,
  }, { now: NOW });

  assert.equal(next.progress, 0);
  assert.equal(next.status, 'drying');
  assert.equal(next.jobStatus, 'drying');
  assert.equal(next.filename, 'filament_drying.gcode');
  assert.equal(next.timeLeft, '3m');
});

test('accepts every current remaining-time candidate with the injected clock', () => {
  const candidates = [
    'mc_remaining_time',
    'remaining_time',
    'remain_time',
    'print_remaining_time',
    'left_time',
  ];

  for (const key of candidates) {
    const next = applyPrinterTelemetry(createPrinter(), { [key]: '61.2' }, { now: NOW });
    assert.equal(next.remainingMinutesRaw, 61.2, key);
    assert.equal(next.remainingUpdatedAt, NOW, key);
    assert.equal(next.remainingStatus, 'printing', key);
    assert.equal(next.timeLeft, '1h 2m', key);
  }
});

test('clears remaining values for finished, idle, error, and disconnected states', () => {
  const cases = [
    { previousStatus: 'printing', telemetry: { gcode_state: 'FINISH' }, expected: 'finished' },
    { previousStatus: 'printing', telemetry: { gcode_state: 'IDLE' }, expected: 'idle' },
    { previousStatus: 'printing', telemetry: { gcode_state: 'FAILED' }, expected: 'error' },
    { previousStatus: 'disconnected', telemetry: {}, expected: 'disconnected' },
  ];

  for (const { previousStatus, telemetry, expected } of cases) {
    const next = applyPrinterTelemetry(createPrinter({
      status: previousStatus,
      remainingMinutesRaw: 45,
      remainingUpdatedAt: NOW - 60000,
      remainingStatus: previousStatus,
    }), {
      ...telemetry,
      left_time: 30,
    }, { now: NOW });

    assert.equal(next.status, expected);
    assert.equal(next.timeLeft, '--');
    assert.equal('remainingMinutesRaw' in next, false);
    assert.equal('remainingUpdatedAt' in next, false);
    assert.equal('remainingStatus' in next, false);
  }
});

test('formats and refreshes live remaining time without unnecessary objects', () => {
  const printer = createPrinter({
    remainingMinutesRaw: 90,
    remainingUpdatedAt: NOW,
    timeLeft: '1h 30m',
  });

  assert.equal(formatPrinterRemainingTime(printer, NOW + (30 * 60000)), '1h 0m');
  assert.equal(formatPrinterRemainingTime({
    ...printer,
    status: 'paused',
  }, NOW + (30 * 60000)), '1h 30m');
  assert.equal(formatPrinterRemainingTime({ status: 'printing' }, NOW), '--');

  const refreshed = refreshPrinterRemainingTime(printer, NOW + (30 * 60000));
  assert.notEqual(refreshed, printer);
  assert.equal(refreshed.timeLeft, '1h 0m');
  assert.equal(printer.timeLeft, '1h 30m');
  assert.equal(refreshPrinterRemainingTime(refreshed, NOW + (30 * 60000)), refreshed);

  const withoutRemaining = createPrinter();
  assert.equal(refreshPrinterRemainingTime(withoutRemaining, NOW), withoutRemaining);
});

test('preserves omitted AMS state and clears it only for explicit null', () => {
  const previous = createPrinter();
  const ordinary = applyPrinterTelemetry(previous, { mc_percent: 20 }, { now: NOW });
  const cleared = applyPrinterTelemetry(previous, { ams: null }, { now: NOW });

  assert.equal(ordinary.ams, previous.ams);
  assert.equal(cleared.ams, null);
  assert.notEqual(cleared, previous);
});

test('parses AMS units, trays, and extruder-selected active tray like BambuClient', () => {
  const previous = createPrinter();
  deepFreeze(previous);
  const next = applyPrinterTelemetry(previous, {
    ams: {
      tray_now: 0,
      ams: [
        {
          id: '0',
          humidity: '4',
          humidity_raw: '52.5',
          temp: '24.6',
          tray: [
            {
              id: '2',
              remain: '87',
              tray_weight: '1000',
              tray_type: 'PLA',
              tray_color: 'FF00AAFF',
              tray_info_idx: 'GFA00',
              tray_sub_brands: 'Basic',
              tray_uuid: 'tray-0-2',
            },
          ],
        },
        {
          id: 1,
          humidity: 3,
          humidity_raw: 48,
          temp: 25,
          tray: [{ id: 2, remain: 50, tray_type: 'PETG' }],
        },
      ],
    },
    device: {
      extruder: {
        info: [{ id: '0', snow: 0x0102 }],
      },
    },
  }, { now: NOW });

  assert.notEqual(next.ams, previous.ams);
  assert.equal(next.ams.activeAmsIndex, 1);
  assert.equal(next.ams.activeTrayIndex, 2);
  assert.deepEqual(next.ams.units[0], {
    index: 0,
    humidityIndex: 4,
    humidityRaw: 52.5,
    temperature: 24.6,
    trays: [{
      id: 2,
      remain: 87,
      trayWeight: 1000,
      type: 'PLA',
      color: 'FF00AAFF',
      idx: 'GFA00',
      subBrand: 'Basic',
      name: 'PLA',
      trayUuid: 'tray-0-2',
    }],
    activeTray: {
      id: 2,
      remain: 87,
      trayWeight: 1000,
      type: 'PLA',
      color: 'FF00AAFF',
      idx: 'GFA00',
      subBrand: 'Basic',
      name: 'PLA',
      trayUuid: 'tray-0-2',
    },
  });
  assert.equal(next.ams.units[0].activeTray, next.ams.units[0].trays[0]);
  assert.equal(next.ams.units[1].activeTray, next.ams.units[1].trays[0]);
});

test('decodes every tray_now fallback sentinel exactly as before', () => {
  const cases = [
    { trayNow: 255, activeAmsIndex: null, activeTrayIndex: null },
    { trayNow: 254, activeAmsIndex: 255, activeTrayIndex: 0 },
    { trayNow: 83, activeAmsIndex: 83, activeTrayIndex: 0 },
    { trayNow: 6, activeAmsIndex: 1, activeTrayIndex: 2 },
  ];

  for (const expected of cases) {
    const next = applyPrinterTelemetry(createPrinter(), {
      ams: { ams: [], tray_now: expected.trayNow },
    }, { now: NOW });
    assert.equal(next.ams.activeAmsIndex, expected.activeAmsIndex);
    assert.equal(next.ams.activeTrayIndex, expected.activeTrayIndex);
  }
});

test('malformed numeric telemetry never introduces NaN into public state', () => {
  const next = applyPrinterTelemetry(createPrinter(), {
    mc_percent: 'not-progress',
    mc_remaining_time: 'not-time',
    layer_num: 'not-layer',
    total_layer_num: 'not-total',
    nozzle_temper: 'not-nozzle',
    bed_temper: {},
    chamber_temper: undefined,
    cooling_fan_speed: 'not-fan',
    spd_lvl: 'not-speed',
    ams: {
      tray_now: 'not-tray',
      ams: [{
        id: 'not-unit',
        humidity: 'not-humidity',
        humidity_raw: {},
        temp: 'not-temp',
        tray: [{
          id: 'not-id',
          remain: 'not-remain',
          tray_weight: 'not-weight',
        }],
      }],
    },
  }, { now: NOW });

  assert.equal(next.progress, 10);
  assert.equal(next.temperature.nozzle, 200);
  assert.equal(next.temperature.bed, 60);
  assert.equal(next.fan, 30);
  assert.equal(next.layer, '?/?');
  assert.equal(next.ams.units[0].index, null);
  assert.equal(next.ams.units[0].trays[0].id, null);
  assert.equal(next.ams.units[0].trays[0].remain, null);
  assert.equal(next.ams.units[0].trays[0].trayWeight, null);
  assertNoNaN(next);
});
