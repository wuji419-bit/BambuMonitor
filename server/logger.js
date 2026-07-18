import { createHmac } from 'node:crypto';

import { redactSecrets } from './http-security.js';

const MAX_CONTEXT_LENGTH = 128;
const MAX_DEVICE_VALUE_LENGTH = 256;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const BRACKETED_IPV6_PATTERN = /\[[0-9a-f:]+\]/gi;

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isDeviceKey(key) {
  const normalized = normalizedKey(key);
  return normalized === 'serial' || normalized.includes('serialnumber')
    || normalized === 'device' || normalized === 'deviceid' || normalized === 'deviceidentifier';
}

function isNetworkKey(key) {
  const normalized = normalizedKey(key);
  return normalized === 'ip' || normalized.endsWith('ip') || normalized.includes('address');
}

function findDevice(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (isDeviceKey(key) && typeof entry === 'string'
      && entry.length > 0 && entry.length <= MAX_DEVICE_VALUE_LENGTH) return entry;
  }
  for (const entry of Object.values(value)) {
    const found = findDevice(entry, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function filterDetails(value, debug, key = '') {
  if (isDeviceKey(key) || (!debug && isNetworkKey(key))) return undefined;
  if (typeof value === 'string') {
    if (debug) return value;
    return value.replace(IPV4_PATTERN, '[REDACTED]').replace(BRACKETED_IPV6_PATTERN, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map((entry) => filterDetails(entry, debug)).filter((entry) => entry !== undefined);
  }
  if (value && typeof value === 'object') {
    const output = Object.create(null);
    for (const [childKey, entry] of Object.entries(value)) {
      const filtered = filterDetails(entry, debug, childKey);
      if (filtered !== undefined) output[childKey] = filtered;
    }
    return output;
  }
  return value;
}

function cleanContext(value) {
  const text = typeof value === 'string' && value.length > 0 ? value : 'unknown';
  return text.replace(/[\r\n\u2028\u2029]/g, ' ').slice(0, MAX_CONTEXT_LENGTH);
}

function timestamp(now) {
  try {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return new Date(0).toISOString();
    return date.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function createLogger({ write, debug = false, deviceSalt = '', now = Date.now } = {}) {
  if (typeof write !== 'function' || typeof now !== 'function'
    || (typeof deviceSalt !== 'string' && !Buffer.isBuffer(deviceSalt))) {
    throw new Error('Invalid logger configuration');
  }

  function log(level, component, event, details) {
    if (level === 'debug' && debug !== true) return;
    try {
      const record = {
        time: timestamp(now),
        level,
        component: cleanContext(component),
        event: cleanContext(event),
      };
      const rawDevice = findDevice(details);
      if (rawDevice !== null && deviceSalt.length > 0) {
        record.device = createHmac('sha256', deviceSalt).update(rawDevice).digest('hex').slice(0, 12);
      }
      if (details !== undefined) {
        record.details = filterDetails(redactSecrets(details), debug === true);
      }
      write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging must not disrupt the server path it is observing.
    }
  }

  return {
    debug(component, event, details) {
      log('debug', component, event, details);
    },
    info(component, event, details) {
      log('info', component, event, details);
    },
    warn(component, event, details) {
      log('warn', component, event, details);
    },
    error(component, event, details) {
      log('error', component, event, details);
    },
  };
}
