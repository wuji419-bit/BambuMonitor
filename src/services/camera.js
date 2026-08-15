const CAMERA_CONFIG_KEY = 'bambu_camera_settings';

export function createDefaultCameraConfig() {
  return {
    autoOpen: false,
    customUrls: {},
  };
}

export function mergeCameraConfig(current = createDefaultCameraConfig(), incoming = {}) {
  return {
    autoOpen: Boolean(incoming?.autoOpen ?? current?.autoOpen),
    customUrls: incoming?.customUrls && typeof incoming.customUrls === 'object'
      ? { ...incoming.customUrls }
      : { ...(current?.customUrls || {}) },
  };
}

export function buildServerCameraConfig(config = {}) {
  return mergeCameraConfig(createDefaultCameraConfig(), config);
}

export function buildCameraStartPayload(runtime, source = {}) {
  const serialNumber = source.key || source.serialNumber || '';
  if (runtime?.kind !== 'electron') return { serialNumber };
  if (runtime?.accounts) return {
    serialNumber,
    ...(source.ip ? { ip: source.ip } : {}),
  };
  return {
    serialNumber,
    cloudId: source.cloudId,
    name: source.name,
    model: source.model,
    modelCode: source.modelCode,
    cameraMode: source.cameraMode,
    ip: source.ip,
    accessCode: source.accessCode,
  };
}

export function isServerManagedCameraSource(runtime, capabilities = {}) {
  return Boolean(capabilities.serverSettings || runtime?.accounts);
}

export function getCameraConfig() {
  if (typeof localStorage === 'undefined') return createDefaultCameraConfig();

  try {
    const stored = JSON.parse(localStorage.getItem(CAMERA_CONFIG_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return createDefaultCameraConfig();

    return {
      ...createDefaultCameraConfig(),
      ...stored,
      customUrls: stored.customUrls && typeof stored.customUrls === 'object' ? stored.customUrls : {},
    };
  } catch {
    return createDefaultCameraConfig();
  }
}

export function saveCameraConfig(config) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CAMERA_CONFIG_KEY, JSON.stringify({
    ...createDefaultCameraConfig(),
    ...config,
    customUrls: config?.customUrls || {},
  }));
}

export function getPrinterCameraKey(printer = {}) {
  return String(printer.dev_id || printer.cloudId || printer.id || '').trim();
}

export function getCustomCameraUrl(config, printer = {}) {
  const urls = config?.customUrls || {};
  return String(urls[getPrinterCameraKey(printer)] || urls[printer.cloudId] || '').trim();
}

export function usesPrivateCameraProtocol(printer = {}) {
  // Mirrors isChamberImageCamera in electron/camera-stream.cjs; camera.test.js
  // cross-checks the two so the renderer cannot silently diverge from the backend.
  if (printer.cameraMode === 'chamber-image') return true;
  if (printer.cameraMode === 'rtsps') return false;

  const model = `${printer.name || ''} ${printer.model || ''} ${printer.modelCode || ''}`.toUpperCase();
  if (!model) return false;
  return /A1|P1P|P1S|P1SC|A2L|A2/.test(model);
}

export function getCameraTransport(printer = {}) {
  return usesPrivateCameraProtocol(printer) ? 'chamber-image' : 'rtsps';
}

export function isAutoCameraSupported(printer = {}) {
  return ['rtsps', 'chamber-image'].includes(getCameraTransport(printer));
}

export function cameraCompatibilityNote(printer = {}) {
  if (usesPrivateCameraProtocol(printer)) {
    return '该机型会尝试 6000 端口 JPEG 流；如果被 Bambu Studio/Handy 占用，可稍后重试或关闭其它实时预览。';
  }
  return '';
}
