import { createElectronRuntime, isElectronEnvironment } from './electron.js';
import { createWebRuntime } from './web.js';

export function createRuntime({
  isElectron = isElectronEnvironment,
  createElectron = createElectronRuntime,
  createWeb = createWebRuntime,
} = {}) {
  return isElectron() ? createElectron() : createWeb();
}

let selectedRuntime;

export function getRuntime() {
  if (!selectedRuntime) selectedRuntime = createRuntime();
  return selectedRuntime;
}

export function replaceRuntimeSnapshot(_current, devices) {
  return Array.isArray(devices) ? devices.map(normalizeRuntimeDevice) : [];
}

function normalizeRuntimeDevice(device = {}) {
  const next = { ...device };
  const rawName = typeof next.name === 'string' ? next.name.trim() : '';
  const displayName = typeof next.displayName === 'string' ? next.displayName.trim() : '';
  if (rawName && displayName && displayName !== rawName) next.baseName = rawName;
  if (displayName) next.name = displayName;
  return next;
}

export function mergeRuntimeDevice(current, device) {
  if (!device?.dev_id) return current;
  const index = current.findIndex((item) => item.dev_id === device.dev_id);
  if (index < 0) return [...current, normalizeRuntimeDevice(device)];
  const next = [...current];
  next[index] = normalizeRuntimeDevice({ ...next[index], ...device });
  return next;
}

export const runtime = getRuntime();
