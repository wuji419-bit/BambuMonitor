import { createRequire } from 'node:module';

import { isValidPrinterAddress } from '../src/utils/printerAddress.js';

const require = createRequire(import.meta.url);
const { projectPublicDeviceValue } = require('../core/device-aggregation.cjs');

const CLOUD_STATES = new Set(['idle', 'syncing', 'connected', 'reconnecting', 'error', 'invalid']);
const ACCOUNT_STATES = new Set(['idle', 'syncing', 'connected', 'error', 'invalid']);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CREDENTIAL_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#]*@|rtsps?:\/\//i;

function safeText(value) {
  return typeof value === 'string' && !CREDENTIAL_URL_PATTERN.test(value.trim()) ? value : null;
}

function safeTimestamp(value) {
  return Number.isFinite(value) ? value : null;
}

function safeAccountId(value) {
  const accountId = safeText(value);
  return accountId && ACCOUNT_ID_PATTERN.test(accountId) ? accountId : null;
}

function safeAccountState(state = {}) {
  const connectionState = ACCOUNT_STATES.has(state.connectionState) ? state.connectionState : 'idle';
  const errorCode = safeText(state.errorCode) || null;
  return {
    connectionState,
    errorCode,
    syncedAt: safeTimestamp(state.syncedAt),
    deviceCount: Number.isSafeInteger(state.deviceCount) && state.deviceCount >= 0 ? state.deviceCount : 0,
  };
}

export function projectPublicDevice(device = {}) {
  return {
    ...projectPublicDeviceValue(device),
    hasLocalAddress: Boolean(device?.hasLocalAddress || isValidPrinterAddress(device?.ip)),
  };
}

export function projectPublicDeviceEvent(event = {}) {
  if (event?.type === 'devices.snapshot') {
    return {
      type: 'devices.snapshot',
      devices: Array.isArray(event.devices) ? event.devices.map(projectPublicDevice) : [],
      syncedAt: safeTimestamp(event.syncedAt),
      cloudState: CLOUD_STATES.has(event.cloudState) ? event.cloudState : 'idle',
    };
  }
  if (event?.type === 'device.updated') return { type: 'device.updated', device: projectPublicDevice(event.device) };
  if (event?.type === 'account.updated' || event?.type === 'account.invalid') {
    const accountId = safeAccountId(event.accountId);
    if (!accountId) return null;
    return { type: event.type, accountId, state: safeAccountState(event.state) };
  }
  if (event?.type === 'account.removed') {
    const accountId = safeAccountId(event.accountId);
    return accountId ? { type: 'account.removed', accountId } : null;
  }
  return null;
}
