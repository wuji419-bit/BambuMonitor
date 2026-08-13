const { accountLabel } = require('./account-records.cjs');

const OMIT = Symbol('omit');
const SAFE_DEVICE_SCALAR_FIELDS = Object.freeze([
  'id',
  'dev_id',
  'cloudId',
  'mqttSerial',
  'serial',
  'serialNumber',
  'name',
  'displayName',
  'model',
  'modelCode',
  'dev_model_name',
  'dev_product_name',
  'productName',
  'printerType',
  'nozzle',
  'nozzleDiameter',
  'nozzle_diameter',
  'online',
  'cloudOnline',
  'cloudState',
  'printStatus',
  'print_status',
  'connectionMode',
  'connectionState',
  'statusSource',
  'localMatchSource',
  'status',
  'jobStatus',
  'lastJobStatus',
  'progress',
  'timeLeft',
  'fan',
  'speed',
  'layer',
  'filename',
  'error',
  'errorCode',
  'errorMsg',
  'errorMessage',
  'remainingMinutesRaw',
  'remainingUpdatedAt',
  'remainingStatus',
  'lastTelemetryAt',
  'lastUpdatedAt',
  'lastSeenAt',
  'lastMessageAt',
  'syncedAt',
  'updatedAt',
  'telemetrySequence',
  'telemetryVersion',
  'cameraMode',
  'hasLocalAddress',
]);
const SAFE_TELEMETRY_SCALAR_FIELDS = Object.freeze([
  'model',
  'modelCode',
  'online',
  'cloudOnline',
  'connectionMode',
  'connectionState',
  'statusSource',
  'status',
  'jobStatus',
  'lastJobStatus',
  'progress',
  'timeLeft',
  'fan',
  'speed',
  'layer',
  'filename',
  'error',
  'errorCode',
  'errorMsg',
  'errorMessage',
  'remainingMinutesRaw',
  'remainingUpdatedAt',
  'remainingStatus',
  'lastTelemetryAt',
  'lastUpdatedAt',
  'lastSeenAt',
  'lastMessageAt',
  'telemetrySequence',
  'telemetryVersion',
]);
const SAFE_TEMPERATURE_FIELDS = Object.freeze([
  'nozzle',
  'bed',
  'chamber',
  'nozzleTarget',
  'bedTarget',
  'chamberTarget',
]);
const SAFE_AMS_UNIT_FIELDS = Object.freeze([
  'index',
  'humidityIndex',
  'humidityRaw',
  'temperature',
]);
const SAFE_AMS_TRAY_FIELDS = Object.freeze([
  'id',
  'remain',
  'trayWeight',
  'type',
  'color',
  'idx',
  'subBrand',
  'name',
  'trayUuid',
]);
const RTSP_URL_PATTERN = /rtsps?:\/\//i;
const CREDENTIAL_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@/i;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isObject(value)) return value;
  const clone = {};
  for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
  return clone;
}

function isRecord(value) {
  return isObject(value) && !Array.isArray(value);
}

function isUnsafePublicString(value) {
  const text = String(value).trim();
  return RTSP_URL_PATTERN.test(text) || CREDENTIAL_URL_PATTERN.test(text);
}

function projectSafeScalar(value) {
  if (typeof value === 'string') return isUnsafePublicString(value) ? OMIT : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT;
  if (typeof value === 'boolean' || value === null) return value;
  return OMIT;
}

function projectScalarFields(value, fields) {
  if (!isRecord(value)) return OMIT;
  const projected = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const child = projectSafeScalar(value[field]);
    if (child !== OMIT) projected[field] = child;
  }
  return projected;
}

function projectTemperature(value) {
  if (value === null) return null;
  return projectScalarFields(value, SAFE_TEMPERATURE_FIELDS);
}

function projectAmsTray(value) {
  return projectScalarFields(value, SAFE_AMS_TRAY_FIELDS);
}

function projectAmsUnit(value) {
  const projected = projectScalarFields(value, SAFE_AMS_UNIT_FIELDS);
  if (projected === OMIT) return OMIT;
  if (Array.isArray(value.trays)) {
    projected.trays = value.trays
      .map(projectAmsTray)
      .filter((tray) => tray !== OMIT);
  }
  if (Object.hasOwn(value, 'activeTray')) {
    const activeTray = value.activeTray === null ? null : projectAmsTray(value.activeTray);
    if (activeTray !== OMIT) projected.activeTray = activeTray;
  }
  return projected;
}

function projectAms(value) {
  if (value === null) return null;
  if (!isRecord(value)) return OMIT;
  const projected = projectScalarFields(value, ['activeAmsIndex', 'activeTrayIndex']);
  if (Array.isArray(value.units)) {
    projected.units = value.units
      .map(projectAmsUnit)
      .filter((unit) => unit !== OMIT);
  }
  return projected;
}

function projectTelemetry(value) {
  const projected = projectScalarFields(value, SAFE_TELEMETRY_SCALAR_FIELDS);
  if (projected === OMIT) return OMIT;
  if (Object.hasOwn(value, 'temperature')) {
    const temperature = projectTemperature(value.temperature);
    if (temperature !== OMIT) projected.temperature = temperature;
  }
  if (Object.hasOwn(value, 'ams')) {
    const ams = projectAms(value.ams);
    if (ams !== OMIT) projected.ams = ams;
  }
  return projected;
}

function projectPublicValue(value) {
  const projected = projectScalarFields(value, SAFE_DEVICE_SCALAR_FIELDS);
  if (projected === OMIT) return {};
  if (Object.hasOwn(value, 'temperature')) {
    const temperature = projectTemperature(value.temperature);
    if (temperature !== OMIT) projected.temperature = temperature;
  }
  if (Object.hasOwn(value, 'ams')) {
    const ams = projectAms(value.ams);
    if (ams !== OMIT) projected.ams = ams;
  }
  if (Object.hasOwn(value, 'telemetry')) {
    const telemetry = projectTelemetry(value.telemetry);
    if (telemetry !== OMIT) projected.telemetry = telemetry;
  }
  return projected;
}

function projectUniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  const projected = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const safeValue = projectSafeScalar(value);
    if (safeValue === OMIT) continue;
    const normalized = safeValue.trim();
    if (normalized && !projected.includes(normalized)) projected.push(normalized);
  }
  return projected;
}

function normalizeSerial(value) {
  return String(value ?? '')
    .trim()
    .replace(/^uuid:/i, '')
    .replace(/::.*$/, '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .toUpperCase();
}

function readDeviceSerial(device) {
  return normalizeSerial(device?.id) || normalizeSerial(device?.dev_id);
}

function readSourceLabel(account) {
  const explicitLabel = String(account?.label ?? '').trim();
  return explicitLabel || accountLabel(account);
}

function readRawName(device) {
  return typeof device?.name === 'string'
    ? device.name
    : String(device?.name ?? '');
}

function createAggregate(serialNumber, rawDevice) {
  const device = cloneValue(rawDevice);
  device.dev_id = serialNumber;
  return {
    serialNumber,
    device,
    sources: [],
    accountIds: [],
    accountLabels: [],
  };
}

function mergeMissingDeviceFields(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined || target[key] === null || target[key] === '') {
      target[key] = cloneValue(value);
    }
  }
}

function addSource(record, account, rawDevice) {
  const accountId = String(account?.accountId ?? '').trim();
  if (accountId && record.accountIds.includes(accountId)) return;

  record.sources.push({
    account: cloneValue(account ?? {}),
    device: cloneValue(rawDevice),
  });

  if (accountId) record.accountIds.push(accountId);
  const label = readSourceLabel(account);
  if (label && !record.accountLabels.includes(label)) record.accountLabels.push(label);
}

function aggregateDeviceRecords(inventories = []) {
  const records = new Map();
  if (!Array.isArray(inventories)) return [];

  for (const inventory of inventories) {
    if (!inventory || typeof inventory !== 'object') continue;
    const devices = Array.isArray(inventory.devices) ? inventory.devices : [];
    for (const rawDevice of devices) {
      if (!rawDevice || typeof rawDevice !== 'object') continue;
      const serialNumber = readDeviceSerial(rawDevice);
      if (!serialNumber) continue;

      let record = records.get(serialNumber);
      if (!record) {
        record = createAggregate(serialNumber, rawDevice);
        records.set(serialNumber, record);
      } else {
        mergeMissingDeviceFields(record.device, rawDevice);
      }
      addSource(record, inventory.account, rawDevice);
    }
  }

  return [...records.values()];
}

function toPublicAggregatedDevice(record) {
  if (!record || typeof record !== 'object') {
    throw new TypeError('Invalid aggregated device record');
  }
  const serialNumber = normalizeSerial(record.serialNumber ?? record.device?.dev_id);
  if (!serialNumber) throw new TypeError('Invalid aggregated device record');

  const device = projectPublicValue(record.device ?? {});
  const projectedName = projectSafeScalar(readRawName(record.device));
  const rawName = projectedName === OMIT ? '' : projectedName;
  const displayBase = rawName.trim() || serialNumber;
  const accountIds = projectUniqueStrings(record.accountIds);
  const accountLabels = projectUniqueStrings(record.accountLabels);

  return {
    ...device,
    dev_id: serialNumber,
    name: rawName,
    displayName: accountLabels.length
      ? `${displayBase}（${accountLabels.join(' / ')}）`
      : displayBase,
    accountIds,
    accountLabels,
  };
}

function aggregateDeviceInventories(inventories = []) {
  return aggregateDeviceRecords(inventories).map(toPublicAggregatedDevice);
}

module.exports = {
  aggregateDeviceInventories,
  aggregateDeviceRecords,
  normalizeSerial,
  toPublicAggregatedDevice,
};
