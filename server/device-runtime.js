import { createRequire } from 'node:module';

import { isValidPrinterAddress } from '../src/utils/printerAddress.js';
import { normalizeSerial } from '../src/utils/printerSync.js';
import { applyPrinterTelemetry } from '../src/utils/printerTelemetry.js';
import { projectPublicDevice } from './public-device.js';
import {
  applyMqttConnectedState,
  applyMqttDisconnectedState,
  applyMqttReconnectingState,
} from '../src/utils/mqttConnectionState.js';

const require = createRequire(import.meta.url);
const { accountLabel } = require('../core/account-records.cjs');

const EMPTY_TEMPERATURE = Object.freeze({ nozzle: 0, bed: 0, chamber: 0 });
const CACHE_FIELDS = Object.freeze(['ip', 'name', 'model']);
const MAX_CLOUD_CONCURRENCY = 3;

function clone(value) { return structuredClone(value); }
function text(value) { return String(value || '').trim(); }
function isInvalidSessionError(error) { return error?.tokenInvalid === true || error?.status === 401 || error?.status === 403; }

function readCloudDevice(cloudDevice) {
  return {
    serialNumber: normalizeSerial(cloudDevice?.id ?? cloudDevice?.dev_id),
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
    status: 'idle', jobStatus: 'idle', progress: 0, timeLeft: '--',
    temperature: { ...EMPTY_TEMPERATURE }, fan: 0, speed: 100, layer: '', filename: '', errorMsg: '',
  };
  if (isValidPrinterAddress(cached.ip)) device.ip = text(cached.ip);
  return device;
}

function mergeCloudDevice(existing, cloudDevice, cached) {
  if (!existing) return createInitialDevice(cloudDevice, cached);
  const next = {
    ...existing,
    dev_id: cloudDevice.serialNumber,
    name: text(cached.name) || cloudDevice.name || existing.name,
    model: text(cached.model) || cloudDevice.model || existing.model,
    dev_model_name: text(cached.model) || cloudDevice.model || existing.dev_model_name,
    cloudOnline: cloudDevice.online,
  };
  if (isValidPrinterAddress(cached.ip)) next.ip = text(cached.ip);
  return next;
}

function getDiscoveryFunction(discovery) {
  if (typeof discovery === 'function') return discovery;
  if (typeof discovery?.scan === 'function') return discovery.scan.bind(discovery);
  if (typeof discovery?.scanBambuPrinters === 'function') return discovery.scanBambuPrinters.bind(discovery);
  throw new TypeError('Device runtime requires LAN discovery');
}

function normalizeAccount(input, fallbackId) {
  const accountId = text(input?.accountId) || fallbackId;
  const account = text(input?.account);
  const accountMasked = text(input?.accountMasked) || '***';
  return {
    accountId,
    account,
    accountMasked,
    remark: text(input?.remark),
    accessToken: text(input?.accessToken),
    username: text(input?.username),
    savedAt: input?.savedAt,
    updatedAt: input?.updatedAt,
  };
}

function safeAccountState(entry) {
  return {
    accountId: entry.account.accountId,
    connectionState: entry.connectionState,
    errorCode: entry.errorCode || null,
    syncedAt: entry.syncedAt ?? null,
    deviceCount: entry.inventory.length,
  };
}

export function createDeviceRuntime({ cloud, mqtt, mqttEvents = mqtt, discovery, configStore, now = () => Date.now(), logger, timers }) {
  if (typeof cloud?.listDevices !== 'function') throw new TypeError('Device runtime requires cloud inventory');
  if (typeof mqtt?.connect !== 'function' || typeof mqtt?.disconnect !== 'function' || typeof mqtt?.shutdown !== 'function') throw new TypeError('Device runtime requires MQTT lifecycle methods');
  if (typeof configStore?.getDeviceCache !== 'function' || typeof configStore?.updateDevice !== 'function') throw new TypeError('Device runtime requires a config store');
  if (typeof now !== 'function') throw new TypeError('Device runtime requires a clock');
  void timers;

  const scan = getDiscoveryFunction(discovery);
  const accounts = new Map();
  const records = new Map();
  const cache = new Map();
  const fingerprints = new Map();
  const disconnectTasks = new Map();
  const deferredConnects = new Set();
  const subscribers = new Set();
  let order = [];
  let generation = 0;
  let activeScan = null;
  let stopped = false;
  let stopSessionPromise = null;
  let shutdownPromise = null;
  let removeMqttListener = null;

  function log(level, operation, details = {}) {
    try { logger?.[level]?.({ operation, ...details }); } catch { /* diagnostics are isolated */ }
  }

  function aggregateCloudState() {
    const states = [...accounts.values()].map((entry) => entry.connectionState);
    if (states.length === 0) return 'idle';
    if (states.includes('syncing')) return 'syncing';
    if (states.includes('connected')) return 'connected';
    if (states.every((state) => state === 'invalid')) return 'invalid';
    if (states.includes('error')) return 'reconnecting';
    return 'idle';
  }

  function publicDevice(record) {
    const labels = record.sources.map((source) => accountLabel(source.entry.account)).filter((label, index, values) => label && values.indexOf(label) === index);
    const accountIds = record.sources.map((source) => source.entry.account.accountId).filter((id, index, values) => id && values.indexOf(id) === index);
    const rawName = text(record.device.name) || record.serialNumber;
    return projectPublicDevice({
      ...record.device,
      dev_id: record.serialNumber,
      name: rawName,
      displayName: labels.length ? `${rawName}（${labels.join(' / ')}）` : rawName,
      accountIds,
      accountLabels: labels,
    });
  }

  function snapshot() {
    return clone({ type: 'devices.snapshot', devices: order.map((serial) => records.get(serial)).filter(Boolean).map(publicDevice), syncedAt: latestSyncedAt(), cloudState: aggregateCloudState() });
  }

  function latestSyncedAt() {
    const values = [...accounts.values()].map((entry) => entry.syncedAt).filter((value) => value !== null && value !== undefined);
    return values.length ? Math.max(...values) : null;
  }

  function deliver(listener, event) {
    let result;
    try { result = listener(clone(event)); } catch { log('warn', 'device-runtime.subscriber-failed'); return; }
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => log('warn', 'device-runtime.subscriber-failed'));
  }
  function emit(event) { if (!stopped) for (const listener of subscribers) deliver(listener, event); }
  function emitSnapshot() { emit(snapshot()); }
  function emitDevice(record) { emit({ type: 'device.updated', device: publicDevice(record) }); }
  function emitAccount(type, entry) { emit({ type, accountId: entry.account.accountId, state: safeAccountState(entry) }); }

  function getRecord(serialNumber) { return records.get(normalizeSerial(serialNumber)); }
  function getDevice(serialNumber) { const record = getRecord(serialNumber); return record ? publicDevice(record) : null; }
  function getAccountStates() { return clone([...accounts.values()].map(safeAccountState)); }

  function ownsSource(source) {
    return accounts.get(source.entry.account.accountId) === source.entry;
  }

  function selectSource(record) {
    const ip = text(record.device.ip);
    const localSource = record.sources.find((source) => ownsSource(source) && text(source.cloudDevice.accessCode));
    if (isValidPrinterAddress(ip) && localSource) {
      return { mode: 'local', ip, accessCode: text(localSource.cloudDevice.accessCode), source: localSource };
    }
    const cloudSource = record.sources.find((source) => (
      ownsSource(source)
      && source.entry.connectionState !== 'invalid'
      && text(source.entry.account.accessToken)
    ));
    return cloudSource ? { mode: 'cloud', source: cloudSource } : null;
  }

  function getCameraConfig(serialNumber) {
    const record = getRecord(serialNumber);
    const source = record && selectSource(record);
    if (!record || !source) return null;
    const config = { serialNumber: record.serialNumber, dev_id: record.serialNumber };
    for (const field of ['ip', 'name', 'model', 'cameraMode']) {
      const value = text(record.device[field]); if (value) config[field] = value;
    }
    const accessCode = text(source.accessCode ?? source.source.cloudDevice.accessCode);
    if (accessCode) config.accessCode = accessCode;
    return clone(config);
  }

  function buildConnection(record) {
    const selected = selectSource(record);
    if (!selected) return null;
    if (selected.mode === 'local') {
      return {
        mode: 'local',
        fingerprint: JSON.stringify(['local', selected.ip, selected.accessCode]),
        payload: { serialNumber: record.serialNumber, mode: 'local', ip: selected.ip, accessCode: selected.accessCode },
      };
    }
    const { account } = selected.source.entry;
    const username = text(account.username);
    return {
      mode: 'cloud',
      fingerprint: JSON.stringify(['cloud', account.accountId, account.accessToken, username]),
      payload: { serialNumber: record.serialNumber, mode: 'cloud', region: 'China', authToken: account.accessToken, username },
    };
  }

  function ensureConnection(record) {
    const connection = buildConnection(record);
    if (!connection) {
      if (fingerprints.has(record.serialNumber)) void disconnect(record.serialNumber);
      record.device.connectionMode = 'cloud';
      record.device.statusSource = 'cloud';
      record.device.connectionState = 'error';
      record.device.errorMsg = 'Printer connection needs attention';
      return false;
    }
    record.device.connectionMode = connection.mode;
    record.device.statusSource = connection.mode;
    if (disconnectTasks.has(record.serialNumber)) {
      deferConnection(record.serialNumber);
      return false;
    }
    if (fingerprints.get(record.serialNumber) === connection.fingerprint) return false;
    fingerprints.set(record.serialNumber, connection.fingerprint);
    record.device.connectionState = 'connecting'; record.device.errorMsg = '';
    let pending;
    try { pending = mqtt.connect(connection.payload); } catch { pending = Promise.reject(new Error('MQTT connect failed')); }
    Promise.resolve(pending).catch(() => {
      if (stopped || fingerprints.get(record.serialNumber) !== connection.fingerprint) return;
      const current = records.get(record.serialNumber); if (!current) return;
      fingerprints.delete(record.serialNumber);
      current.device = { ...current.device, connectionState: 'error', errorMsg: 'MQTT connection failed' };
      log('warn', 'device-runtime.mqtt-connect-failed', { serialNumber: record.serialNumber }); emitDevice(current);
    });
    return true;
  }

  function disconnect(serialNumber) {
    const existing = disconnectTasks.get(serialNumber);
    if (existing) return existing;
    fingerprints.delete(serialNumber);
    let pending;
    try { pending = mqtt.disconnect(serialNumber); }
    catch { pending = Promise.reject(new Error('MQTT disconnect failed')); }
    const task = Promise.resolve(pending)
      .catch(() => log('warn', 'device-runtime.mqtt-disconnect-failed', { serialNumber }))
      .finally(() => { if (disconnectTasks.get(serialNumber) === task) disconnectTasks.delete(serialNumber); });
    disconnectTasks.set(serialNumber, task);
    return task;
  }

  function deferConnection(serialNumber) {
    if (deferredConnects.has(serialNumber)) return;
    const task = disconnectTasks.get(serialNumber);
    if (!task) return;
    deferredConnects.add(serialNumber);
    void task.finally(() => {
      deferredConnects.delete(serialNumber);
      const current = records.get(serialNumber);
      if (!stopped && current) ensureConnection(current);
    });
  }

  function rebuildRecords() {
    const nextRecords = new Map();
    const nextOrder = [];
    for (const entry of accounts.values()) {
      for (const rawDevice of entry.inventory) {
        const cloudDevice = readCloudDevice(rawDevice);
        if (!cloudDevice.serialNumber) continue;
        let record = nextRecords.get(cloudDevice.serialNumber);
        if (!record) {
          const previous = records.get(cloudDevice.serialNumber);
          record = { serialNumber: cloudDevice.serialNumber, device: mergeCloudDevice(previous?.device, cloudDevice, cache.get(cloudDevice.serialNumber) || {}), sources: [] };
          nextRecords.set(cloudDevice.serialNumber, record); nextOrder.push(cloudDevice.serialNumber);
        }
        if (!record.sources.some((source) => source.entry === entry)) record.sources.push({ entry, cloudDevice });
      }
    }
    const removed = order.filter((serial) => !nextRecords.has(serial));
    records.clear(); for (const [serial, record] of nextRecords) records.set(serial, record); order = nextOrder;
    for (const serial of removed) void disconnect(serial);
    for (const record of records.values()) ensureConnection(record);
  }

  function normalizeMqttEvent(eventOrType, payload) {
    if (typeof eventOrType === 'string') return { type: eventOrType, ...(payload || {}) };
    return eventOrType && typeof eventOrType === 'object' ? { ...eventOrType, type: eventOrType.type || eventOrType.event } : null;
  }
  function handleMqttEvent(eventOrType, payload) {
    if (stopped) return;
    const event = normalizeMqttEvent(eventOrType, payload); const record = getRecord(event?.serialNumber); if (!record) return;
    if (event.type === 'message') record.device = applyPrinterTelemetry(record.device, event.payload, { now: now() });
    else if (event.type === 'connected') record.device = applyMqttConnectedState(record.device);
    else if (event.type === 'reconnecting') record.device = applyMqttReconnectingState(record.device);
    else if (event.type === 'disconnected') record.device = applyMqttDisconnectedState(record.device);
    else return;
    emitDevice(record);
  }

  if (typeof mqttEvents?.subscribe === 'function') {
    const unsubscribe = mqttEvents.subscribe(handleMqttEvent); removeMqttListener = typeof unsubscribe === 'function' ? unsubscribe : null;
  } else if (typeof mqttEvents?.on === 'function') {
    const eventNames = ['message', 'connected', 'reconnecting', 'disconnected'];
    const listeners = eventNames.map((eventName) => [eventName, (payload) => handleMqttEvent(eventName, payload)]);
    for (const [eventName, listener] of listeners) mqttEvents.on(eventName, listener);
    removeMqttListener = () => { const remove = mqttEvents.off?.bind(mqttEvents) || mqttEvents.removeListener?.bind(mqttEvents); if (remove) for (const [name, listener] of listeners) remove(name, listener); };
  } else throw new TypeError('Device runtime requires MQTT event subscription');

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Device listener must be a function');
    if (stopped) return () => {};
    subscribers.add(listener); deliver(listener, snapshot()); let subscribed = true;
    return () => { if (!subscribed) return; subscribed = false; subscribers.delete(listener); };
  }

  function loadCache() {
    const loaded = configStore.getDeviceCache(); cache.clear();
    for (const [serialNumber, cached] of Object.entries(loaded?.devices || {})) {
      const serial = normalizeSerial(serialNumber); if (serial && cached && typeof cached === 'object') cache.set(serial, clone(cached));
    }
  }

  async function waitForCloud(work, signal) {
    if (!signal?.addEventListener) return work;
    if (signal.aborted) return { aborted: true };
    let onAbort; const aborted = new Promise((resolve) => { onAbort = () => resolve({ aborted: true }); signal.addEventListener('abort', onAbort, { once: true }); });
    try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener('abort', onAbort); }
  }

  function beginAccountOperation(entry, externalSignal) {
    entry.operationVersion += 1;
    entry.activeController?.abort();
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener?.('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    entry.activeController = controller;
    entry.connectionState = 'syncing'; entry.errorCode = null; emitAccount('account.updated', entry);
    return {
      entry,
      version: entry.operationVersion,
      generation,
      signal: controller.signal,
      requestSignal: controller.signal,
      externalSignal,
      cleanup() {
        externalSignal?.removeEventListener?.('abort', abort);
        if (entry.activeController === controller) entry.activeController = null;
      },
    };
  }

  function operationIsCurrent(operation) {
    return !stopped
      && generation === operation.generation
      && accounts.get(operation.entry.account.accountId) === operation.entry
      && operation.entry.operationVersion === operation.version;
  }

  async function refreshAccount(operation) {
    const { entry, signal } = operation;
    const account = clone(entry.account);
    let request;
    try { request = cloud.listDevices(account.accessToken, { signal: operation.requestSignal }); }
    catch (error) { request = Promise.reject(error); }
    let outcome;
    if (operation.externalSignal) {
      outcome = await waitForCloud(Promise.resolve(request).then((result) => ({ result }), (error) => ({ error })), signal);
    } else {
      try { outcome = { result: await request }; } catch (error) { outcome = { error }; }
    }
    try {
      if (!operationIsCurrent(operation)) return { current: false };
      if (outcome.error || outcome.aborted || !outcome.result?.success || !Array.isArray(outcome.result?.devices)) {
        const error = outcome.error;
        if (isInvalidSessionError(error)) {
          entry.connectionState = 'invalid'; entry.errorCode = String(error.status || 'INVALID_CREDENTIALS'); emitAccount('account.invalid', entry);
        } else {
          entry.connectionState = 'error'; entry.errorCode = String(error?.status || 'CLOUD_UNAVAILABLE'); emitAccount('account.updated', entry);
          log('warn', 'device-runtime.cloud-refresh-failed', { accountId: entry.account.accountId, status: error?.status });
        }
        return { current: true, state: entry.connectionState };
      }
      entry.inventory = clone(outcome.result.devices);
      entry.account.username = text(outcome.result.username) || account.username;
      entry.connectionState = 'connected'; entry.errorCode = null; entry.syncedAt = now(); emitAccount('account.updated', entry);
      return { current: true, state: 'connected' };
    } finally {
      operation.cleanup();
    }
  }

  async function runPool(entries, task) {
    let cursor = 0;
    const outcomes = [];
    async function worker() {
      while (cursor < entries.length) { const index = cursor; cursor += 1; outcomes.push(await task(entries[index])); }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_CLOUD_CONCURRENCY, entries.length) }, worker));
    return outcomes;
  }

  async function refresh({ accountId, signal, skipLan = false } = {}) {
    if (stopped || signal?.aborted) return snapshot();
    const entries = accountId ? [accounts.get(text(accountId))].filter(Boolean) : [...accounts.values()];
    if (entries.length === 0) return snapshot();
    const operations = entries.map((entry) => beginAccountOperation(entry, signal));
    emitSnapshot();
    const outcomes = operations.length === 1
      ? [await refreshAccount(operations[0])]
      : operations.length <= MAX_CLOUD_CONCURRENCY
        ? await Promise.all(operations.map(refreshAccount))
      : await runPool(operations, refreshAccount);
    if (stopped || generation !== operations[0].generation || !outcomes.some((outcome) => outcome.current)) return snapshot();
    rebuildRecords(); emitSnapshot();
    if (!skipLan) void scanLan({ signal });
    return snapshot();
  }

  function buildLanPatch(printer) {
    const ip = text(printer?.ip); if (!isValidPrinterAddress(ip)) return null;
    const patch = { ip }; const name = text(printer?.name); const model = text(printer?.model); if (name) patch.name = name; if (model) patch.model = model; return patch;
  }
  async function applyLanResults(results, expectedGeneration, signal) {
    if (!Array.isArray(results)) return;
    for (const printer of results) {
      if (stopped || signal.aborted || generation !== expectedGeneration) return;
      const serial = normalizeSerial(printer?.serial ?? printer?.serialNumber); const record = records.get(serial); const patch = record && buildLanPatch(printer); if (!patch) continue;
      let persisted; try { persisted = await configStore.updateDevice(serial, patch); } catch { log('warn', 'device-runtime.cache-update-failed', { serialNumber: serial }); persisted = patch; }
      if (stopped || signal.aborted || generation !== expectedGeneration) return;
      const current = records.get(serial); const nextCached = { ...(cache.get(serial) || {}), ...persisted, ...patch }; cache.set(serial, nextCached); if (!current) continue;
      for (const field of CACHE_FIELDS) if (text(nextCached[field])) current.device[field] = text(nextCached[field]);
      if (text(nextCached.model)) current.device.dev_model_name = text(nextCached.model); ensureConnection(current); emitDevice(current);
    }
  }
  function scanLan({ signal } = {}) {
    if (stopped || signal?.aborted) return Promise.resolve(snapshot());
    const expectedGeneration = generation; if (activeScan?.generation === expectedGeneration) return activeScan.promise;
    const controller = new AbortController(); const abortScan = () => controller.abort(); signal?.addEventListener?.('abort', abortScan, { once: true }); if (signal?.aborted) abortScan();
    let result; try { result = scan({ signal: controller.signal }); } catch (error) { result = Promise.reject(error); }
    const entry = { controller, generation: expectedGeneration, promise: null };
    entry.promise = Promise.resolve(result).then((results) => applyLanResults(results, expectedGeneration, controller.signal)).catch((error) => { if (!controller.signal.aborted && !stopped && generation === expectedGeneration) log('warn', 'device-runtime.lan-scan-failed', { name: error?.name }); }).then(snapshot).finally(() => { signal?.removeEventListener?.('abort', abortScan); if (activeScan === entry) activeScan = null; });
    activeScan = entry; return entry.promise;
  }

  async function updateDevice(serialNumber, patch = {}) {
    if (stopped) return null;
    const serial = normalizeSerial(serialNumber); const record = records.get(serial); if (!record) return null;
    const allowed = {}; for (const field of CACHE_FIELDS) if (Object.hasOwn(patch, field)) allowed[field] = patch[field];
    const expectedGeneration = generation; const persisted = await configStore.updateDevice(serial, allowed);
    if (stopped || generation !== expectedGeneration || records.get(serial) !== record) return null;
    const nextCached = { ...(cache.get(serial) || {}), ...persisted, ...allowed }; cache.set(serial, nextCached);
    for (const field of CACHE_FIELDS) if (Object.hasOwn(nextCached, field)) record.device[field] = nextCached[field];
    if (Object.hasOwn(nextCached, 'model')) record.device.dev_model_name = nextCached.model; ensureConnection(record); emitDevice(record); return publicDevice(record);
  }

  async function start({ accounts: inputAccounts, accessToken, username, signal } = {}) {
    if (stopSessionPromise) await stopSessionPromise;
    if (stopped || signal?.aborted) return snapshot();
    const expectedGeneration = ++generation; activeScan?.controller.abort();
    for (const entry of accounts.values()) entry.activeController?.abort();
    accounts.clear();
    const supplied = Array.isArray(inputAccounts) ? inputAccounts : [{ accountId: 'legacy', accountMasked: '', remark: '', accessToken, username }];
    for (let index = 0; index < supplied.length; index += 1) {
      const account = normalizeAccount(supplied[index], `account-${index + 1}`); if (!account.accessToken || accounts.has(account.accountId)) continue;
      accounts.set(account.accountId, { account, inventory: [], connectionState: 'idle', errorCode: null, syncedAt: null, operationVersion: 0, activeController: null });
    }
    try { loadCache(); } catch { log('warn', 'device-runtime.cache-load-failed'); }
    if (stopped || signal?.aborted || generation !== expectedGeneration) return snapshot();
    await refresh({ signal, skipLan: true });
    if (stopped || signal?.aborted || generation !== expectedGeneration) return snapshot();
    await scanLan({ signal });
    return snapshot();
  }

  async function addAccount(account, { signal } = {}) {
    if (stopped || signal?.aborted) return snapshot();
    const normalized = normalizeAccount(account, `account-${accounts.size + 1}`); if (!normalized.accessToken) throw new TypeError('Account requires accessToken');
    if (accounts.has(normalized.accountId)) return updateAccount(normalized);
    accounts.set(normalized.accountId, { account: normalized, inventory: [], connectionState: 'idle', errorCode: null, syncedAt: null, operationVersion: 0, activeController: null });
    await refresh({ accountId: normalized.accountId, signal, skipLan: true });
    if (stopped || signal?.aborted || !accounts.has(normalized.accountId)) return snapshot();
    await scanLan({ signal });
    return snapshot();
  }

  function updateAccount(account) {
    const accountId = text(account?.accountId); const entry = accounts.get(accountId); if (!entry) return null;
    const next = { ...entry.account };
    for (const field of ['account', 'accountMasked', 'remark', 'accessToken', 'username', 'savedAt', 'updatedAt']) {
      if (!Object.hasOwn(account || {}, field)) continue;
      next[field] = field === 'savedAt' || field === 'updatedAt' ? account[field] : text(account[field]);
    }
    if (!next.accountMasked) next.accountMasked = entry.account.accountMasked || '***';
    const identityChanged = ['account', 'accessToken', 'username'].some((field) => next[field] !== entry.account[field]);
    if (identityChanged) {
      entry.operationVersion += 1;
      entry.activeController?.abort();
    }
    entry.account = next;
    rebuildRecords(); emitAccount('account.updated', entry); emitSnapshot(); return safeAccountState(entry);
  }
  function updateAccountRemark(accountId, publicAccountOrRemark) {
    const entry = accounts.get(text(accountId)); if (!entry) return null;
    entry.account.remark = text(typeof publicAccountOrRemark === 'string' ? publicAccountOrRemark : publicAccountOrRemark?.remark);
    if (publicAccountOrRemark && typeof publicAccountOrRemark === 'object' && text(publicAccountOrRemark.accountMasked)) entry.account.accountMasked = text(publicAccountOrRemark.accountMasked);
    rebuildRecords(); emitAccount('account.updated', entry); emitSnapshot(); return safeAccountState(entry);
  }
  function removeAccount(accountId) {
    const entry = accounts.get(text(accountId)); if (!entry) return false;
    entry.operationVersion += 1; entry.activeController?.abort();
    accounts.delete(entry.account.accountId); rebuildRecords(); emit({ type: 'account.removed', accountId: entry.account.accountId }); emitSnapshot(); return true;
  }

  function stopSession() {
    if (stopSessionPromise) return stopSessionPromise; if (stopped) return Promise.resolve(snapshot());
    const hadSession = records.size || accounts.size || activeScan; if (!hadSession) return Promise.resolve(snapshot());
    generation += 1; activeScan?.controller.abort(); for (const entry of accounts.values()) entry.activeController?.abort(); const serials = [...records.keys()]; records.clear(); cache.clear(); order = []; accounts.clear(); emitSnapshot();
    const pending = [...new Set([...serials.map(disconnect), ...disconnectTasks.values()])];
    const reset = Promise.allSettled(pending).then(snapshot); const wrapped = reset.finally(() => { if (stopSessionPromise === wrapped) stopSessionPromise = null; }); stopSessionPromise = wrapped; return wrapped;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise; stopped = true; generation += 1; activeScan?.controller.abort(); for (const entry of accounts.values()) entry.activeController?.abort(); subscribers.clear();
    try { removeMqttListener?.(); } catch { log('warn', 'device-runtime.mqtt-listener-remove-failed'); } removeMqttListener = null;
    const serials = [...records.keys()]; const pending = [...new Set([...serials.map(disconnect), ...disconnectTasks.values()])]; if (stopSessionPromise) pending.push(stopSessionPromise);
    shutdownPromise = Promise.allSettled(pending).then(async () => { try { await mqtt.shutdown(); } catch { log('warn', 'device-runtime.mqtt-shutdown-failed'); } fingerprints.clear(); return snapshot(); }); return shutdownPromise;
  }

  return { start, refresh, addAccount, updateAccount, updateAccountRemark, removeAccount, getAccountStates, scanLan, updateDevice, snapshot, getDevice, getCameraConfig, subscribe, stopSession, shutdown };
}
