import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPrintTaskName,
  isFilamentDryingTask,
  mapTelemetryStatus,
} from './printTaskStatus.js';

test('detects filament drying tasks from Bambu drying gcode names', () => {
  assert.equal(isFilamentDryingTask('filament_drying.gcode'), true);
  assert.equal(isFilamentDryingTask('/cache/filament-drying.gcode'), true);
  assert.equal(isFilamentDryingTask('0.2mm 层高，2 层墙，15% 填充.3mf'), false);
});

test('maps running filament drying telemetry to drying status', () => {
  assert.equal(mapTelemetryStatus({
    gcode_state: 'RUNNING',
    gcode_file: 'filament_drying.gcode',
  }), 'drying');
});

test('keeps regular running telemetry as printing status', () => {
  assert.equal(mapTelemetryStatus({
    gcode_state: 'RUNNING',
    gcode_file: 'part_plate_1.3mf',
  }), 'printing');
});

test('uses subtask name before file path for task display', () => {
  assert.equal(getPrintTaskName({
    gcode_file: '/cache/old.gcode',
    subtask_name: 'filament_drying.gcode',
  }), 'filament_drying.gcode');
});
