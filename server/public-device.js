import { isValidPrinterAddress } from '../src/utils/printerAddress.js';

const PRIVATE_DEVICE_KEYS = new Set([
  'ip',
  'address',
  'localaddress',
  'accesscode',
  'devaccesscode',
  'rtsps',
  'rtspsurl',
  'cameraurl',
  'snapshoturl',
  'streamurl',
  'password',
  'secret',
  'token',
  'authtoken',
  'credential',
]);

function normalizedKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function projectValue(value) {
  if (Array.isArray(value)) return value.map(projectValue);
  if (!value || typeof value !== 'object') return value;
  const projected = {};
  for (const [key, child] of Object.entries(value)) {
    if (normalizedKey(key) === 'sources') continue;
    if (PRIVATE_DEVICE_KEYS.has(normalizedKey(key))) continue;
    if (typeof child === 'string' && /^rtsps?:\/\//i.test(child.trim())) continue;
    projected[key] = projectValue(child);
  }
  return projected;
}

export function projectPublicDevice(device = {}) {
  const projected = projectValue(device);
  projected.hasLocalAddress = Boolean(
    device?.hasLocalAddress || isValidPrinterAddress(device?.ip),
  );
  return projected;
}

export function projectPublicDeviceEvent(event = {}) {
  if (event?.type === 'devices.snapshot') {
    return {
      ...projectValue(event),
      devices: Array.isArray(event.devices) ? event.devices.map(projectPublicDevice) : [],
    };
  }
  if (event?.type === 'device.updated') {
    return {
      ...projectValue(event),
      device: projectPublicDevice(event.device),
    };
  }
  return projectValue(event);
}
