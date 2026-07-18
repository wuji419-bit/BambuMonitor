import { isValidPrinterAddress, normalizePrinterAddress } from '../src/utils/printerAddress.js';

const CONFIG_NAME = 'config.json';
const DEVICE_CACHE_NAME = 'device-cache.json';
const CURRENT_VERSION = 1;
const MAX_KEY_LENGTH = 128;
const MAX_TEXT_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 4096;
const MAX_CUSTOM_URLS = 100;
const MAX_TARGETS = 100;
const MAX_HEADERS = 50;
const MAX_HEADER_NAME_LENGTH = 128;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_DEVICES = 1000;
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MISSING_FILE = Object.freeze({ missingConfigStoreFile: 1n });

const DEFAULT_CONFIG = {
  version: CURRENT_VERSION,
  camera: { autoOpen: false, customUrls: {} },
  notifications: { enabled: false, targets: [] },
  debug: false,
};
const DEFAULT_DEVICE_CACHE = { version: CURRENT_VERSION, devices: {} };

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidConfig(field) {
  return new Error(`Invalid configuration field: ${field}`);
}

function invalidDevice(field) {
  return new Error(`Invalid device field: ${field}`);
}

function assertPlain(value, errorFactory, field) {
  if (!isPlainObject(value)) throw errorFactory(field);
}

function normalizeBoolean(value, errorFactory, field) {
  if (typeof value !== 'boolean') throw errorFactory(field);
  return value;
}

function normalizeString(value, maxLength, errorFactory, field, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') throw errorFactory(field);
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) {
    throw errorFactory(field);
  }
  return normalized;
}

function normalizeOpaqueString(value, maxLength, errorFactory, field) {
  if (typeof value !== 'string' || value.length > maxLength) throw errorFactory(field);
  return value;
}

function normalizeSafeKey(value, errorFactory, field) {
  const normalized = normalizeString(value, MAX_KEY_LENGTH, errorFactory, field, { allowEmpty: false });
  if (DANGEROUS_KEYS.has(normalized) || !SAFE_KEY.test(normalized)) throw errorFactory(field);
  return normalized;
}

function normalizeHttpUrl(value, errorFactory, field) {
  const normalized = normalizeString(value, MAX_URL_LENGTH, errorFactory, field, { allowEmpty: false });
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw errorFactory(field);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw errorFactory(field);
  }
  const result = parsed.toString();
  if (result.length > MAX_URL_LENGTH) throw errorFactory(field);
  return result;
}

function normalizeCustomUrls(value) {
  assertPlain(value, invalidConfig, 'camera.customUrls');
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_URLS) throw invalidConfig('camera.customUrls');
  const result = {};
  for (const [key, url] of entries) {
    const safeKey = normalizeSafeKey(key, invalidConfig, 'camera.customUrls key');
    result[safeKey] = normalizeHttpUrl(url, invalidConfig, 'camera.customUrls URL');
  }
  return result;
}

function normalizeHeaders(value) {
  assertPlain(value, invalidConfig, 'notifications.targets.headers');
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) throw invalidConfig('notifications.targets.headers');
  const result = {};
  for (const [name, rawValue] of entries) {
    if (
      DANGEROUS_KEYS.has(name)
      || name.length === 0
      || name.length > MAX_HEADER_NAME_LENGTH
      || !HEADER_NAME.test(name)
    ) {
      throw invalidConfig('notifications.targets.headers name');
    }
    if (typeof rawValue !== 'string' || rawValue.length > MAX_HEADER_VALUE_LENGTH || /[\r\n]/.test(rawValue)) {
      throw invalidConfig('notifications.targets.headers value');
    }
    result[name] = rawValue;
  }
  return result;
}

function normalizeTarget(value) {
  assertPlain(value, invalidConfig, 'notifications.targets');
  const result = {};
  if (Object.hasOwn(value, 'id')) result.id = normalizeSafeKey(value.id, invalidConfig, 'notifications.targets.id');
  if (Object.hasOwn(value, 'name')) {
    result.name = normalizeString(value.name, MAX_TEXT_LENGTH, invalidConfig, 'notifications.targets.name');
  }
  if (Object.hasOwn(value, 'type')) {
    result.type = normalizeString(value.type, MAX_TEXT_LENGTH, invalidConfig, 'notifications.targets.type');
  }
  if (Object.hasOwn(value, 'enabled')) {
    result.enabled = normalizeBoolean(value.enabled, invalidConfig, 'notifications.targets.enabled');
  }
  if (Object.hasOwn(value, 'url')) result.url = normalizeHttpUrl(value.url, invalidConfig, 'notifications.targets.url');
  for (const field of ['secret', 'token']) {
    if (Object.hasOwn(value, field)) {
      result[field] = normalizeOpaqueString(
        value[field],
        MAX_SECRET_LENGTH,
        invalidConfig,
        `notifications.targets.${field}`,
      );
    }
  }
  if (Object.hasOwn(value, 'headers')) result.headers = normalizeHeaders(value.headers);
  return result;
}

function normalizeTargets(value) {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) throw invalidConfig('notifications.targets');
  return value.map(normalizeTarget);
}

function normalizeConfig(value, { partial = false } = {}) {
  assertPlain(value, invalidConfig, 'root');
  const result = partial ? {} : clone(DEFAULT_CONFIG);
  if (Object.hasOwn(value, 'camera')) {
    assertPlain(value.camera, invalidConfig, 'camera');
    const camera = partial ? {} : clone(DEFAULT_CONFIG.camera);
    if (Object.hasOwn(value.camera, 'autoOpen')) {
      camera.autoOpen = normalizeBoolean(value.camera.autoOpen, invalidConfig, 'camera.autoOpen');
    }
    if (Object.hasOwn(value.camera, 'customUrls')) camera.customUrls = normalizeCustomUrls(value.camera.customUrls);
    result.camera = camera;
  }
  if (Object.hasOwn(value, 'notifications')) {
    assertPlain(value.notifications, invalidConfig, 'notifications');
    const notifications = partial ? {} : clone(DEFAULT_CONFIG.notifications);
    if (Object.hasOwn(value.notifications, 'enabled')) {
      notifications.enabled = normalizeBoolean(value.notifications.enabled, invalidConfig, 'notifications.enabled');
    }
    if (Object.hasOwn(value.notifications, 'targets')) notifications.targets = normalizeTargets(value.notifications.targets);
    result.notifications = notifications;
  }
  if (Object.hasOwn(value, 'debug')) result.debug = normalizeBoolean(value.debug, invalidConfig, 'debug');
  if (!partial) result.version = CURRENT_VERSION;
  return result;
}

function normalizeSerial(value) {
  return normalizeSafeKey(value, invalidDevice, 'serial');
}

function normalizeDevicePatch(value) {
  assertPlain(value, invalidDevice, 'patch');
  const result = {};
  if (Object.hasOwn(value, 'ip')) {
    if (typeof value.ip !== 'string') throw invalidDevice('ip');
    const ip = normalizePrinterAddress(value.ip);
    if (!isValidPrinterAddress(ip)) throw invalidDevice('ip');
    result.ip = ip;
  }
  for (const field of ['name', 'model']) {
    if (Object.hasOwn(value, field)) {
      result[field] = normalizeString(value[field], MAX_TEXT_LENGTH, invalidDevice, field);
    }
  }
  return result;
}

function normalizeUpdatedAt(value) {
  if (!Number.isFinite(value) || value < 0) throw invalidDevice('updatedAt');
  return value;
}

function normalizeDevice(value) {
  assertPlain(value, invalidDevice, 'record');
  const result = normalizeDevicePatch(value);
  if (Object.hasOwn(value, 'updatedAt')) result.updatedAt = normalizeUpdatedAt(value.updatedAt);
  return result;
}

function normalizeDeviceCache(value) {
  assertPlain(value, invalidDevice, 'cache');
  if (Object.hasOwn(value, 'devices')) assertPlain(value.devices, invalidDevice, 'devices');
  const entries = Object.entries(value.devices ?? {});
  if (entries.length > MAX_DEVICES) throw invalidDevice('devices');
  const devices = {};
  for (const [serial, device] of entries) {
    devices[normalizeSerial(serial)] = normalizeDevice(device);
  }
  return { version: CURRENT_VERSION, devices };
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeConfig(current, patch) {
  const next = clone(current);
  if (patch.camera) {
    if (Object.hasOwn(patch.camera, 'autoOpen')) next.camera.autoOpen = patch.camera.autoOpen;
    if (Object.hasOwn(patch.camera, 'customUrls')) next.camera.customUrls = patch.camera.customUrls;
  }
  if (patch.notifications) {
    if (Object.hasOwn(patch.notifications, 'enabled')) next.notifications.enabled = patch.notifications.enabled;
    if (Object.hasOwn(patch.notifications, 'targets')) next.notifications.targets = patch.notifications.targets;
  }
  if (Object.hasOwn(patch, 'debug')) next.debug = patch.debug;
  return normalizeConfig(next);
}

function assertVersion(value, name) {
  if (!isPlainObject(value) || !Number.isInteger(value.version) || value.version < 0 || value.version > CURRENT_VERSION) {
    throw new Error(`Unsupported ${name} version`);
  }
}

function planVersioned({ loaded, name, defaults, normalize }) {
  if (loaded?.missingConfigStoreFile === 1n) {
    return { name, value: clone(defaults), write: true };
  }
  assertVersion(loaded, name);
  if (loaded.version === 0) {
    return { name, loaded, migrate: true, normalize };
  }
  const normalized = normalize(loaded);
  return { name, value: normalized, write: !equal(loaded, normalized) };
}

async function executeVersionPlans(storage, plans) {
  for (const plan of plans) {
    if (plan.migrate) await storage.backup(plan.name, `${plan.name}.bak-v0`);
  }

  const resolved = plans.map((plan) => plan.migrate
    ? { ...plan, value: plan.normalize(plan.loaded), write: true }
    : plan);
  for (const plan of resolved) {
    if (plan.write) await storage.writeJson(plan.name, plan.value);
  }
  return resolved.map((plan) => plan.value);
}

export async function createConfigStore({ storage, now = () => Date.now() }) {
  if (!storage || typeof storage.readJson !== 'function' || typeof storage.writeJson !== 'function'
    || typeof storage.backup !== 'function' || typeof now !== 'function') {
    throw new Error('Invalid config store dependencies');
  }

  const [loadedConfig, loadedDeviceCache] = await Promise.all([
    storage.readJson(CONFIG_NAME, MISSING_FILE),
    storage.readJson(DEVICE_CACHE_NAME, MISSING_FILE),
  ]);
  const plans = [planVersioned({
    loaded: loadedConfig,
    name: CONFIG_NAME,
    defaults: DEFAULT_CONFIG,
    normalize: normalizeConfig,
  }), planVersioned({
    loaded: loadedDeviceCache,
    name: DEVICE_CACHE_NAME,
    defaults: DEFAULT_DEVICE_CACHE,
    normalize: normalizeDeviceCache,
  })];
  let [config, deviceCache] = await executeVersionPlans(storage, plans);
  let queue = Promise.resolve();

  function serialize(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  return {
    get() {
      return clone(config);
    },

    update(patch) {
      return serialize(async () => {
        const normalizedPatch = normalizeConfig(patch, { partial: true });
        const candidate = mergeConfig(config, normalizedPatch);
        await storage.writeJson(CONFIG_NAME, candidate);
        config = candidate;
        return clone(config);
      });
    },

    getDeviceCache() {
      return clone(deviceCache);
    },

    updateDevice(serial, patch) {
      return serialize(async () => {
        const normalizedSerial = normalizeSerial(serial);
        const normalizedPatch = normalizeDevicePatch(patch);
        const timestamp = now();
        if (!Number.isFinite(timestamp) || timestamp < 0) throw invalidDevice('updatedAt');
        const device = normalizeDevice({
          ...(deviceCache.devices[normalizedSerial] ?? {}),
          ...normalizedPatch,
          updatedAt: timestamp,
        });
        const candidate = clone(deviceCache);
        candidate.devices[normalizedSerial] = device;
        const validated = normalizeDeviceCache(candidate);
        await storage.writeJson(DEVICE_CACHE_NAME, validated);
        deviceCache = validated;
        return clone(device);
      });
    },

    removeDevice(serial) {
      return serialize(async () => {
        const normalizedSerial = normalizeSerial(serial);
        if (!Object.hasOwn(deviceCache.devices, normalizedSerial)) return false;
        const candidate = clone(deviceCache);
        delete candidate.devices[normalizedSerial];
        const validated = normalizeDeviceCache(candidate);
        await storage.writeJson(DEVICE_CACHE_NAME, validated);
        deviceCache = validated;
        return true;
      });
    },
  };
}
