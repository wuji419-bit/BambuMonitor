export const normalizeSerial = (value) => String(value || '')
  .trim()
  .replace(/^uuid:/i, '')
  .replace(/::.*$/, '')
  .replace(/[^A-Za-z0-9_-]/g, '')
  .toUpperCase();

export const normalizeName = (value) => String(value || '')
  .trim()
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s_-]+/g, '');

export const mapCloudPrintStatus = (printStatus, hasIp, online) => {
  const statusText = String(printStatus || '').toUpperCase();

  if (!hasIp && online === false) return 'cloud_offline';
  if (!statusText) return hasIp ? 'connecting' : 'cloud_overview';
  if (statusText.includes('RUN') || statusText.includes('PRINT')) return 'printing';
  if (statusText.includes('PAUSE')) return 'paused';
  if (statusText.includes('PREPARE')) return 'preparing';
  if (statusText.includes('FINISH')) return 'finished';
  if (statusText.includes('IDLE')) return 'idle';

  return hasIp ? 'connecting' : 'cloud_overview';
};

const mergeTelemetryNumber = (nextValue, previousValue, fallback = 0) => {
  if (nextValue !== undefined && nextValue !== null && Number.isFinite(Number(nextValue))) {
    return Number(nextValue);
  }
  if (previousValue !== undefined && previousValue !== null && Number.isFinite(Number(previousValue))) {
    return Number(previousValue);
  }
  return fallback;
};

const mergeTemperature = (previous = {}, next = {}) => ({
  nozzle: mergeTelemetryNumber(next.nozzle, previous.nozzle),
  bed: mergeTelemetryNumber(next.bed, previous.bed),
  chamber: mergeTelemetryNumber(next.chamber, previous.chamber),
});

export const mergePrinterState = (previous = {}, next = {}) => ({
  ...previous,
  ...next,
  temperature: mergeTemperature(previous.temperature, next.temperature),
  model: next.model && next.model !== 'Unknown' ? next.model : previous.model,
  modelCode: next.modelCode || previous.modelCode,
  accessCode: next.accessCode || previous.accessCode,
});

export function buildDeviceSyncSnapshot({ cloudDevices = [], scannedPrinters = [], cachedIps = {} } = {}) {
  const nextCachedIps = { ...cachedIps };
  const scannedBySerial = new Map();
  const scannedByName = new Map();

  scannedPrinters.forEach((printer) => {
    const serialKey = normalizeSerial(printer.serial);
    const nameKey = normalizeName(printer.name);
    if (serialKey) scannedBySerial.set(serialKey, printer);
    if (nameKey && !scannedByName.has(nameKey)) scannedByName.set(nameKey, printer);
  });

  const devicesWithIp = cloudDevices.map((device) => {
    const cloudId = String(device.id || '');
    const serialKey = normalizeSerial(device.id);
    const nameKey = normalizeName(device.name);
    const scanned = scannedBySerial.get(serialKey) || scannedByName.get(nameKey);
    const scannedSerial = normalizeSerial(scanned?.serial);
    const mqttSerial = scannedSerial || serialKey || cloudId;
    const cachedIp = nextCachedIps[cloudId] || nextCachedIps[mqttSerial] || nextCachedIps[serialKey] || nextCachedIps[nameKey];
    const ip = scanned?.ip || cachedIp || null;

    if (ip) {
      if (cloudId) nextCachedIps[cloudId] = ip;
      if (mqttSerial) nextCachedIps[mqttSerial] = ip;
      if (serialKey) nextCachedIps[serialKey] = ip;
      if (nameKey) nextCachedIps[nameKey] = ip;
    }

    return {
      ...device,
      mqttSerial,
      ip,
      localMatchSource: scanned?.ip ? 'scan' : (ip ? 'cache' : ''),
    };
  });

  return {
    cachedIps: nextCachedIps,
    devicesWithIp,
    initialPrinters: devicesWithIp.map((device) => ({
      dev_id: device.mqttSerial,
      cloudId: device.id,
      name: device.name,
      model: device.model,
      modelCode: device.modelCode,
      ip: device.ip,
      accessCode: device.accessCode,
      status: mapCloudPrintStatus(device.printStatus, Boolean(device.ip), device.online),
      statusSource: 'cloud',
      connectionMode: 'cloud',
      cloudOnline: device.online,
      progress: 0,
      timeLeft: '--',
      temperature: { nozzle: 0, bed: 0, chamber: 0 },
      fan: 0,
      speed: 100,
      layer: '',
      filename: '',
      errorMsg: '',
    })),
  };
}
