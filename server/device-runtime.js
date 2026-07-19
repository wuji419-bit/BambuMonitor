import { isValidPrinterAddress } from '../src/utils/printerAddress.js';
import { normalizeSerial } from '../src/utils/printerSync.js';
import { applyPrinterTelemetry } from '../src/utils/printerTelemetry.js';
import {
  applyMqttConnectedState,
  applyMqttDisconnectedState,
  applyMqttReconnectingState,
} from '../src/utils/mqttConnectionState.js';

const EMPTY_TEMPERATURE = Object.freeze({ nozzle: 0, bed: 0, chamber: 0 });
const CACHE_FIELDS = Object.freeze(['ip', 'name', 'model']);

function clone(value) {
  return structuredClone(value);
}

function text(value) {
  return String(value || '').trim();
}

function publicDevice(record) {
  return clone(record.device);
}

function isInvalidSessionError(error) {
  return error?.tokenInvalid === true || error?.status === 401 || error?.status === 403;
}

function readCloudDevice(cloudDevice) {
  const serialNumber = normalizeSerial(cloudDevice?.id ?? cloudDevice?.dev_id);
  return {
    serialNumber,
    name: text(cloudDevice?.name),
    model: text(cloudDevice?.model ?? cloudDevice?.dev_model_name),
    accessCode: text(cloudDevice?.accessCode ?? cloudDevice?.dev_access_code),
    online: cloudDevice?.online,
  };
}

function createInitialDevice(cloudDevice, cached = {}) {
  const name = text(cached.name) || cloudDevice.name;
  const model = text(cached.model) || cloudDevice.model;
  const device = {
    dev_id: cloudDevice.serialNumber,
    name,
    model,
    dev_model_name: model,
    cloudOnline: cloudDevice.online,
    connectionMode: 'cloud',
    connectionState: cloudDevice.online === false ? 'offline' : 'connecting',
    statusSource: 'cloud',
    status: 'idle',
    jobStatus: 'idle',
    progress: 0,
    timeLeft: '--',
    temperature: { ...EMPTY_TEMPERATURE },
    fan: 0,
    speed: 100,
    layer: '',
    filename: '',
    errorMsg: '',
  };
  if (isValidPrinterAddress(cached.ip)) device.ip = text(cached.ip);
  return device;
}

function mergeCloudDevice(existing, cloudDevice, cached) {
  if (!existing) return createInitialDevice(cloudDevice, cached);
  const name = text(cached.name) || cloudDevice.name || existing.name;
  const model = text(cached.model) || cloudDevice.model || existing.model;
  const next = {
    ...existing,
    dev_id: cloudDevice.serialNumber,
    name,
    model,
    dev_model_name: model,
    cloudOnline: cloudDevice.online,
  };
  if (isValidPrinterAddress(cached.ip)) next.ip = text(cached.ip);
  return next;
}

function getDiscoveryFunction(discovery) {
  if (typeof discovery === 'function') return discovery;
  if (typeof discovery?.scan === 'function') return discovery.scan.bind(discovery);
  if (typeof discovery?.scanBambuPrinters === 'function') {
    return discovery.scanBambuPrinters.bind(discovery);
  }
  throw new TypeError('Device runtime requires LAN discovery');
}

export function createDeviceRuntime({
  cloud,
  mqtt,
  discovery,
  configStore,
  now = () => Date.now(),
  logger,
  timers,
}) {
  if (typeof cloud?.listDevices !== 'function') {
    throw new TypeError('Device runtime requires cloud inventory');
  }
  if (
    typeof mqtt?.connect !== 'function'
    || typeof mqtt?.disconnect !== 'function'
    || typeof mqtt?.shutdown !== 'function'
  ) {
    throw new TypeError('Device runtime requires MQTT lifecycle methods');
  }
  if (
    typeof configStore?.getDeviceCache !== 'function'
    || typeof configStore?.updateDevice !== 'function'
  ) {
    throw new TypeError('Device runtime requires a config store');
  }
  if (typeof now !== 'function') throw new TypeError('Device runtime requires a clock');
  void timers;

  const scan = getDiscoveryFunction(discovery);
  const records = new Map();
  const cache = new Map();
  const fingerprints = new Map();
  const subscribers = new Set();
  let order = [];
  let credentials = { accessToken: '', username: '' };
  let generation = 0;
  let refreshSequence = 0;
  let activeScan = null;
  let syncedAt = null;
  let cloudState = 'idle';
  let stopped = false;
  let shutdownPromise = null;
  let removeMqttListener = null;

  function log(level, operation, details = {}) {
    if (typeof logger?.[level] !== 'function') return;
    try {
      logger[level]({ operation, ...details });
    } catch {
      // Diagnostics cannot affect runtime ownership.
    }
  }

  function snapshot() {
    return clone({
      type: 'devices.snapshot',
      devices: order.map((serialNumber) => records.get(serialNumber))
        .filter(Boolean)
        .map((record) => record.device),
      syncedAt,
      cloudState,
    });
  }

  function emit(event) {
    if (stopped) return;
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch {
        log('warn', 'device-runtime.subscriber-failed');
      }
    }
  }

  function emitSnapshot() {
    emit(snapshot());
  }

  function emitDevice(record) {
    emit({ type: 'device.updated', device: publicDevice(record) });
  }

  function getRecord(serialNumber) {
    return records.get(normalizeSerial(serialNumber));
  }

  function getDevice(serialNumber) {
    const record = getRecord(serialNumber);
    return record ? publicDevice(record) : null;
  }

  function buildConnection(record) {
    const ip = text(record.device.ip);
    const accessCode = text(record.accessCode);
    const accessToken = text(credentials.accessToken);
    const username = text(credentials.username);
    const mode = isValidPrinterAddress(ip) && accessCode ? 'local' : 'cloud';
    const fingerprint = JSON.stringify([mode, accessToken, username, ip, accessCode]);
    const payload = mode === 'local'
      ? {
        serialNumber: record.serialNumber,
        mode,
        ip,
        accessCode,
      }
      : {
        serialNumber: record.serialNumber,
        mode,
        authToken: accessToken,
        username,
      };
    return { fingerprint, mode, payload };
  }

  function ensureConnection(record) {
    const connection = buildConnection(record);
    record.device.connectionMode = connection.mode;
    record.device.statusSource = connection.mode;
    if (fingerprints.get(record.serialNumber) === connection.fingerprint) return false;

    fingerprints.set(record.serialNumber, connection.fingerprint);
    record.device.connectionState = 'connecting';
    record.device.errorMsg = '';
    let pending;
    try {
      pending = mqtt.connect(connection.payload);
    } catch {
      pending = Promise.reject(new Error('MQTT connect failed'));
    }
    Promise.resolve(pending).catch(() => {
      if (
        stopped
        || records.get(record.serialNumber) !== record
        || fingerprints.get(record.serialNumber) !== connection.fingerprint
      ) return;
      record.device = {
        ...record.device,
        connectionState: 'error',
        errorMsg: 'MQTT connection failed',
      };
      log('warn', 'device-runtime.mqtt-connect-failed', {
        serialNumber: record.serialNumber,
      });
      emitDevice(record);
    });
    return true;
  }

  function disconnect(serialNumber) {
    fingerprints.delete(serialNumber);
    try {
      return Promise.resolve(mqtt.disconnect(serialNumber)).catch(() => {
        log('warn', 'device-runtime.mqtt-disconnect-failed', { serialNumber });
      });
    } catch {
      log('warn', 'device-runtime.mqtt-disconnect-failed', { serialNumber });
      return Promise.resolve();
    }
  }

  function normalizeMqttEvent(eventOrType, payload) {
    if (typeof eventOrType === 'string') return { type: eventOrType, ...(payload || {}) };
    if (!eventOrType || typeof eventOrType !== 'object') return null;
    return {
      ...eventOrType,
      type: eventOrType.type || eventOrType.event,
    };
  }

  function handleMqttEvent(eventOrType, payload) {
    if (stopped) return;
    const event = normalizeMqttEvent(eventOrType, payload);
    const record = getRecord(event?.serialNumber);
    if (!record) return;

    if (event.type === 'message') {
      record.device = applyPrinterTelemetry(record.device, event.payload, { now: now() });
    } else if (event.type === 'connected') {
      record.device = applyMqttConnectedState(record.device);
    } else if (event.type === 'reconnecting') {
      record.device = applyMqttReconnectingState(record.device);
    } else if (event.type === 'disconnected') {
      record.device = applyMqttDisconnectedState(record.device);
    } else {
      return;
    }
    emitDevice(record);
  }

  // Server composition injects one event bus subscription for the shared MQTT manager.
  if (typeof mqtt.subscribe === 'function') {
    const unsubscribe = mqtt.subscribe(handleMqttEvent);
    removeMqttListener = typeof unsubscribe === 'function' ? unsubscribe : null;
  } else if (typeof mqtt.on === 'function') {
    const eventNames = ['message', 'connected', 'reconnecting', 'disconnected'];
    const listeners = eventNames.map((eventName) => {
      const listener = (payload) => handleMqttEvent(eventName, payload);
      mqtt.on(eventName, listener);
      return [eventName, listener];
    });
    removeMqttListener = () => {
      const remove = typeof mqtt.off === 'function'
        ? mqtt.off.bind(mqtt)
        : mqtt.removeListener?.bind(mqtt);
      if (!remove) return;
      for (const [eventName, listener] of listeners) remove(eventName, listener);
    };
  } else {
    throw new TypeError('Device runtime requires MQTT event subscription');
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Device listener must be a function');
    if (stopped) return () => {};
    subscribers.add(listener);
    try {
      listener(snapshot());
    } catch {
      log('warn', 'device-runtime.subscriber-failed');
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(listener);
    };
  }

  function loadCache() {
    const loaded = configStore.getDeviceCache();
    const devices = loaded?.devices || {};
    cache.clear();
    for (const [serialNumber, cached] of Object.entries(devices)) {
      const serial = normalizeSerial(serialNumber);
      if (serial && cached && typeof cached === 'object') cache.set(serial, clone(cached));
    }
  }

  function handleCloudFailure(error, expectedGeneration, expectedRefresh) {
    if (
      stopped
      || generation !== expectedGeneration
      || refreshSequence !== expectedRefresh
    ) return snapshot();
    if (isInvalidSessionError(error)) {
      cloudState = 'invalid';
      emitSnapshot();
      emit({ type: 'session.invalid' });
      log('warn', 'device-runtime.session-invalid', { status: error?.status });
    } else {
      cloudState = 'reconnecting';
      emitSnapshot();
      log('warn', 'device-runtime.cloud-refresh-failed', { status: error?.status });
    }
    return snapshot();
  }

  async function refresh() {
    if (stopped) return snapshot();
    const expectedGeneration = generation;
    const expectedRefresh = ++refreshSequence;
    const session = { ...credentials };
    cloudState = 'syncing';
    emitSnapshot();

    let result;
    try {
      result = await cloud.listDevices(session.accessToken);
    } catch (error) {
      return handleCloudFailure(error, expectedGeneration, expectedRefresh);
    }
    if (
      stopped
      || generation !== expectedGeneration
      || refreshSequence !== expectedRefresh
    ) return snapshot();
    if (!result?.success || !Array.isArray(result.devices)) {
      return handleCloudFailure(null, expectedGeneration, expectedRefresh);
    }

    credentials.username = text(result.username) || session.username;
    const nextRecords = new Map();
    const nextOrder = [];
    for (const rawDevice of result.devices) {
      const cloudDevice = readCloudDevice(rawDevice);
      if (!cloudDevice.serialNumber) continue;
      const existing = records.get(cloudDevice.serialNumber);
      const cached = cache.get(cloudDevice.serialNumber) || {};
      const record = {
        serialNumber: cloudDevice.serialNumber,
        accessCode: cloudDevice.accessCode || existing?.accessCode || '',
        device: mergeCloudDevice(existing?.device, cloudDevice, cached),
      };
      nextRecords.set(cloudDevice.serialNumber, record);
      nextOrder.push(cloudDevice.serialNumber);
    }

    const removed = order.filter((serialNumber) => !nextRecords.has(serialNumber));
    records.clear();
    for (const [serialNumber, record] of nextRecords) records.set(serialNumber, record);
    order = nextOrder;
    for (const serialNumber of removed) void disconnect(serialNumber);
    for (const serialNumber of order) ensureConnection(records.get(serialNumber));
    syncedAt = now();
    cloudState = 'connected';
    emitSnapshot();
    return snapshot();
  }

  function buildLanPatch(printer) {
    const ip = text(printer?.ip);
    if (!isValidPrinterAddress(ip)) return null;
    const patch = { ip };
    const name = text(printer?.name);
    const model = text(printer?.model);
    if (name) patch.name = name;
    if (model) patch.model = model;
    return patch;
  }

  async function applyLanResults(results, expectedGeneration, signal) {
    if (!Array.isArray(results)) return;
    for (const printer of results) {
      if (stopped || signal.aborted || generation !== expectedGeneration) return;
      const serialNumber = normalizeSerial(printer?.serial ?? printer?.serialNumber);
      const record = records.get(serialNumber);
      const patch = record ? buildLanPatch(printer) : null;
      if (!record || !patch) continue;

      let persisted;
      try {
        persisted = await configStore.updateDevice(serialNumber, patch);
      } catch {
        log('warn', 'device-runtime.cache-update-failed', { serialNumber });
        persisted = patch;
      }
      if (stopped || signal.aborted || generation !== expectedGeneration) return;
      const nextCached = { ...(cache.get(serialNumber) || {}), ...persisted, ...patch };
      cache.set(serialNumber, nextCached);
      for (const field of CACHE_FIELDS) {
        if (text(nextCached[field])) record.device[field] = text(nextCached[field]);
      }
      if (text(nextCached.model)) record.device.dev_model_name = text(nextCached.model);
      ensureConnection(record);
      emitDevice(record);
    }
  }

  function scanLan() {
    if (stopped) return Promise.resolve(snapshot());
    const expectedGeneration = generation;
    if (activeScan?.generation === expectedGeneration) return activeScan.promise;

    const controller = new AbortController();
    let scanResult;
    try {
      scanResult = scan({ signal: controller.signal });
    } catch (error) {
      scanResult = Promise.reject(error);
    }
    const entry = { controller, generation: expectedGeneration, promise: null };
    entry.promise = Promise.resolve(scanResult)
      .then((results) => applyLanResults(results, expectedGeneration, controller.signal))
      .catch((error) => {
        if (!controller.signal.aborted && !stopped && generation === expectedGeneration) {
          log('warn', 'device-runtime.lan-scan-failed', { name: error?.name });
        }
      })
      .then(() => snapshot())
      .finally(() => {
        if (activeScan === entry) activeScan = null;
      });
    activeScan = entry;
    return entry.promise;
  }

  async function updateDevice(serialNumber, patch = {}) {
    if (stopped) return null;
    const serial = normalizeSerial(serialNumber);
    const record = records.get(serial);
    if (!record) return null;
    const allowedPatch = {};
    for (const field of CACHE_FIELDS) {
      if (Object.hasOwn(patch, field)) allowedPatch[field] = patch[field];
    }
    const expectedGeneration = generation;
    const persisted = await configStore.updateDevice(serial, allowedPatch);
    if (stopped || generation !== expectedGeneration || records.get(serial) !== record) return null;
    const nextCached = { ...(cache.get(serial) || {}), ...persisted, ...allowedPatch };
    cache.set(serial, nextCached);
    for (const field of CACHE_FIELDS) {
      if (Object.hasOwn(nextCached, field)) record.device[field] = nextCached[field];
    }
    if (Object.hasOwn(nextCached, 'model')) record.device.dev_model_name = nextCached.model;
    ensureConnection(record);
    emitDevice(record);
    return publicDevice(record);
  }

  async function start({ accessToken, username }) {
    if (stopped) return snapshot();
    const expectedGeneration = ++generation;
    refreshSequence += 1;
    activeScan?.controller.abort();
    credentials = { accessToken: text(accessToken), username: text(username) };
    try {
      loadCache();
    } catch {
      log('warn', 'device-runtime.cache-load-failed');
    }
    if (stopped || generation !== expectedGeneration) return snapshot();
    await refresh();
    if (stopped || generation !== expectedGeneration) return snapshot();
    await scanLan();
    return snapshot();
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    generation += 1;
    refreshSequence += 1;
    activeScan?.controller.abort();
    subscribers.clear();
    try {
      removeMqttListener?.();
    } catch {
      log('warn', 'device-runtime.mqtt-listener-remove-failed');
    }
    removeMqttListener = null;

    const serialNumbers = [...records.keys()];
    shutdownPromise = Promise.allSettled(serialNumbers.map(disconnect))
      .then(async () => {
        try {
          await mqtt.shutdown();
        } catch {
          log('warn', 'device-runtime.mqtt-shutdown-failed');
        }
        fingerprints.clear();
        return snapshot();
      });
    return shutdownPromise;
  }

  return {
    start,
    refresh,
    scanLan,
    updateDevice,
    snapshot,
    getDevice,
    subscribe,
    shutdown,
  };
}
