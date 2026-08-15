const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'bambu-device-credentials.json';
const VERSION = 1;

function text(value) {
  return String(value ?? '').trim();
}

function serial(value) {
  return text(value).toUpperCase();
}

function clone(value) {
  return structuredClone(value);
}

function normalizeRecord(value = {}) {
  const record = {};
  const ip = text(value.ip);
  const accessCode = text(value.accessCode);
  if (ip) record.ip = ip;
  if (accessCode) record.accessCode = accessCode;
  return record;
}

function createDeviceCredentialStore({ userDataPath, protection } = {}) {
  if (!text(userDataPath)) throw new TypeError('Device credential store requires a user data path');
  const canProtect = typeof protection?.protect === 'function' && typeof protection?.unprotect === 'function';
  const filePath = path.join(userDataPath, FILE_NAME);
  let records = {};

  if (canProtect && fs.existsSync(filePath)) {
    try {
      const wrapper = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (wrapper?.version !== VERSION || wrapper.protected !== true || typeof wrapper.payload !== 'string') throw new Error('Invalid device credential store');
      const decoded = JSON.parse(protection.unprotect(Buffer.from(wrapper.payload, 'base64')));
      if (decoded?.version !== VERSION || !decoded.devices || typeof decoded.devices !== 'object' || Array.isArray(decoded.devices)) throw new Error('Invalid device credential store');
      records = Object.fromEntries(Object.entries(decoded.devices).map(([key, value]) => [serial(key), normalizeRecord(value)]).filter(([key]) => key));
    } catch {
      records = {};
    }
  }

  function persist(next) {
    if (!canProtect) return;
    const protectedValue = protection.protect(JSON.stringify({ version: VERSION, devices: next }));
    const raw = JSON.stringify({ version: VERSION, protected: true, payload: Buffer.from(protectedValue).toString('base64') });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, raw, { mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  return {
    entries() {
      return Object.entries(records).map(([key, value]) => [key, clone(value)]);
    },
    get(serialNumber) {
      const value = records[serial(serialNumber)];
      return value ? clone(value) : null;
    },
    update(serialNumber, patch = {}) {
      const key = serial(serialNumber);
      if (!key) throw new Error('Invalid device serial');
      const nextRecord = normalizeRecord({ ...(records[key] || {}), ...patch });
      const next = { ...records, [key]: nextRecord };
      persist(next);
      records = next;
      return clone(nextRecord);
    },
  };
}

module.exports = { createDeviceCredentialStore };
