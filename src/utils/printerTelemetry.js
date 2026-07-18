import { getPrintTaskName, mapTelemetryStatus } from './printTaskStatus.js';

const REMAINING_TIME_FIELDS = [
  'mc_remaining_time',
  'remaining_time',
  'remain_time',
  'print_remaining_time',
  'left_time',
];
const TERMINAL_STATUSES = new Set(['finished', 'idle', 'error', 'disconnected']);
const SPEED_PERCENTAGES = { 1: 50, 2: 100, 3: 125, 4: 166 };

function toFiniteNumber(value) {
  try {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function getRemainingMinutes(data) {
  for (const field of REMAINING_TIME_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    const minutes = toFiniteNumber(value);
    if (minutes !== null && minutes >= 0) return minutes;
  }
  return null;
}

function formatMinutes(minutes) {
  const totalMinutes = Math.ceil(Number(minutes));
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return '--';
  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

export function formatPrinterRemainingTime(printer, now = Date.now()) {
  const baseMinutes = toFiniteNumber(printer?.remainingMinutesRaw);
  if (baseMinutes === null || baseMinutes < 0) return '--';

  let liveMinutes = baseMinutes;
  if (printer?.status === 'printing') {
    const updatedAt = toFiniteNumber(printer.remainingUpdatedAt);
    if (updatedAt !== null && updatedAt > 0) {
      const elapsedMinutes = Math.max(0, (now - updatedAt) / 60000);
      liveMinutes = Math.max(0, baseMinutes - elapsedMinutes);
    }
  }

  return formatMinutes(liveMinutes);
}

export function refreshPrinterRemainingTime(printer, now = Date.now()) {
  if (!printer || !Number.isFinite(printer.remainingMinutesRaw)) return printer;
  const timeLeft = formatPrinterRemainingTime(printer, now);
  if (timeLeft === printer.timeLeft) return printer;
  return { ...printer, timeLeft };
}

function applyRemainingTime(printer, data, status, now) {
  const next = printer;
  const remainingMinutes = getRemainingMinutes(data);
  if (remainingMinutes !== null) {
    next.remainingMinutesRaw = remainingMinutes;
    next.remainingUpdatedAt = now;
    next.remainingStatus = status;
  }

  if (TERMINAL_STATUSES.has(status)) {
    next.timeLeft = '--';
    delete next.remainingMinutesRaw;
    delete next.remainingUpdatedAt;
    delete next.remainingStatus;
  } else {
    next.timeLeft = formatPrinterRemainingTime(next, now);
  }
}

function applyTemperature(printer, previous, data) {
  const updates = {};
  const fields = [
    ['nozzle_temper', 'nozzle'],
    ['bed_temper', 'bed'],
    ['chamber_temper', 'chamber'],
  ];

  for (const [source, target] of fields) {
    if (data[source] === undefined) continue;
    const value = toFiniteNumber(data[source]);
    if (value !== null) updates[target] = Math.round(value);
  }

  if (Object.keys(updates).length > 0) {
    printer.temperature = { ...(previous.temperature || {}), ...updates };
  }
}

function decodeActiveTray(data) {
  let activeAmsIndex = null;
  let activeTrayIndex = null;
  const extruderInfo = data.device?.extruder?.info;

  if (Array.isArray(extruderInfo)) {
    const nozzle0 = extruderInfo.find((entry) => (
      toFiniteNumber(entry?.id) === 0 && entry?.snow !== undefined
    ));
    const snow = toFiniteNumber(nozzle0?.snow);
    if (nozzle0 && snow !== null) {
      activeAmsIndex = snow >> 8;
      activeTrayIndex = snow & 0x3;
    }
  }

  if (activeAmsIndex === null && data.ams.tray_now !== undefined) {
    const trayNow = toFiniteNumber(data.ams.tray_now);
    if (trayNow === 255) {
      activeAmsIndex = null;
      activeTrayIndex = null;
    } else if (trayNow === 254) {
      activeAmsIndex = 255;
      activeTrayIndex = 0;
    } else if (trayNow !== null && trayNow >= 80) {
      activeAmsIndex = trayNow;
      activeTrayIndex = 0;
    } else if (trayNow !== null) {
      activeAmsIndex = trayNow >> 2;
      activeTrayIndex = trayNow & 0x3;
    }
  }

  return { activeAmsIndex, activeTrayIndex };
}

function parseTray(tray) {
  return {
    id: toFiniteNumber(tray?.id),
    remain: toFiniteNumber(tray?.remain),
    trayWeight: toFiniteNumber(tray?.tray_weight),
    type: tray?.tray_type || '',
    color: tray?.tray_color || '',
    idx: tray?.tray_info_idx || '',
    subBrand: tray?.tray_sub_brands || '',
    name: tray?.tray_type || '',
    trayUuid: tray?.tray_uuid || '',
  };
}

function parseAms(data) {
  const { activeAmsIndex, activeTrayIndex } = decodeActiveTray(data);
  const units = data.ams.ams.map((unit) => {
    const trays = Array.isArray(unit?.tray) ? unit.tray.map(parseTray) : [];
    const activeTray = activeTrayIndex === null
      ? null
      : trays.find((tray) => tray.id === activeTrayIndex) || null;

    return {
      index: toFiniteNumber(unit?.id),
      humidityIndex: toFiniteNumber(unit?.humidity),
      humidityRaw: toFiniteNumber(unit?.humidity_raw),
      temperature: toFiniteNumber(unit?.temp),
      trays,
      activeTray,
    };
  });

  return { activeAmsIndex, activeTrayIndex, units };
}

export function applyPrinterTelemetry(previous, payload, { now = Date.now() } = {}) {
  const data = payload?.print || payload;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return previous;

  const next = {
    ...previous,
    connectionState: 'online',
    lastTelemetryAt: now,
  };
  let nextStatus = previous.status;

  if (data.mc_percent !== undefined) {
    const progress = toFiniteNumber(data.mc_percent);
    if (progress !== null) next.progress = Math.min(100, Math.max(0, progress));
  }

  if (data.gcode_state) {
    nextStatus = mapTelemetryStatus(data, previous);
    next.status = nextStatus;
    next.jobStatus = nextStatus;
  }

  applyRemainingTime(next, data, nextStatus, now);

  if (data.layer_num !== undefined) {
    const currentLayer = toFiniteNumber(data.layer_num);
    const totalLayer = toFiniteNumber(data.total_layer_num);
    next.layer = `${currentLayer === null ? '?' : currentLayer}`
      + `/${totalLayer !== null && totalLayer >= 0 ? totalLayer : '?'}`;
  }

  applyTemperature(next, previous, data);

  if (data.cooling_fan_speed !== undefined) {
    const fan = toFiniteNumber(data.cooling_fan_speed);
    if (fan !== null) next.fan = Math.round((fan / 255) * 100);
  }
  if (data.spd_lvl !== undefined) {
    next.speed = SPEED_PERCENTAGES[data.spd_lvl] || 100;
  }
  if (data.gcode_file || data.subtask_name) {
    next.filename = getPrintTaskName(data, previous);
  }

  if (data.ams && Array.isArray(data.ams.ams)) {
    next.ams = parseAms(data);
  } else if (data.ams === null) {
    next.ams = null;
  }

  return next;
}
