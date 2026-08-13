const { accountLabel } = require('./account-records.cjs');

const PRIVATE_DEVICE_KEYS = new Set([
  'account',
  'rawaccount',
  'username',
  'password',
  'secret',
  'token',
  'accesstoken',
  'authtoken',
  'credential',
  'accesscode',
  'devaccesscode',
  'ip',
  'address',
  'localaddress',
  'rtsps',
  'rtspsurl',
  'cameraurl',
  'snapshoturl',
  'streamurl',
  'sources',
]);
const PRIVATE_KEY_FRAGMENTS = Object.freeze([
  'accesscode',
  'authorization',
  'credential',
  'password',
  'secret',
  'token',
  'username',
]);
const PRIVATE_ACCOUNT_FRAGMENTS = Object.freeze([
  'loginaccount',
  'privateaccount',
  'rawaccount',
  'sourceaccount',
]);
const PRIVATE_ADDRESS_FRAGMENTS = Object.freeze([
  'deviceaddress',
  'deviceip',
  'hostaddress',
  'hostip',
  'ipaddress',
  'lanaddress',
  'lanip',
  'localaddress',
  'localip',
  'networkaddress',
  'networkip',
  'printeraddress',
  'printerip',
  'privateaddress',
  'privateip',
  'remoteaddress',
  'remoteip',
]);

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

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function keyTerms(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isPrivateDeviceKey(key) {
  const compact = normalizedKey(key);
  if (!compact) return false;
  if (PRIVATE_DEVICE_KEYS.has(compact)) return true;
  if (PRIVATE_KEY_FRAGMENTS.some((fragment) => compact.includes(fragment))) return true;
  if (PRIVATE_ACCOUNT_FRAGMENTS.some((fragment) => compact.includes(fragment))) return true;
  if (PRIVATE_ADDRESS_FRAGMENTS.some((fragment) => compact.includes(fragment))) return true;

  const terms = keyTerms(key);
  return terms.includes('address') || terms.includes('ip');
}

function projectPublicValue(value) {
  if (Array.isArray(value)) return value.map(projectPublicValue);
  if (!isObject(value)) return value;
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (isPrivateDeviceKey(key)) continue;
    if (typeof child === 'string' && /^rtsps?:\/\//i.test(child.trim())) continue;
    projected[key] = projectPublicValue(child);
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
  const rawName = readRawName(record.device);
  const displayBase = rawName.trim() || serialNumber;
  const accountIds = [...new Set(
    (Array.isArray(record.accountIds) ? record.accountIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
  const accountLabels = [...new Set(
    (Array.isArray(record.accountLabels) ? record.accountLabels : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];

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
