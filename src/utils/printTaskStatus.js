const DRYING_PATTERNS = [
  /filament[_\s-]*dry/i,
  /drying/i,
  /dry[_\s-]*filament/i,
  /烘干/,
  /干燥/,
];

export function isFilamentDryingTask(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return DRYING_PATTERNS.some((pattern) => pattern.test(text));
}

export function getPrintTaskName(data = {}, printer = {}) {
  const rawName = data.subtask_name || data.gcode_file || printer.filename || '';
  const parts = String(rawName).split(/[\\/]/);
  return parts[parts.length - 1] || String(rawName);
}

export function mapTelemetryStatus(data = {}, printer = {}) {
  const gcodeState = String(data.gcode_state || '').toUpperCase();
  const taskName = getPrintTaskName(data, printer);

  if (gcodeState === 'RUNNING' && isFilamentDryingTask(taskName)) {
    return 'drying';
  }

  const stateMap = {
    RUNNING: 'printing',
    PAUSE: 'paused',
    IDLE: 'idle',
    FINISH: 'finished',
    FAILED: 'error',
    PREPARE: 'preparing',
  };

  return stateMap[gcodeState] || gcodeState.toLowerCase();
}
