export const WINDOW_SIZE_STORAGE_KEY = 'bambu_window_sizes_v1';

function freezeModeConfig(defaultSize, minSize) {
  return Object.freeze({
    defaultSize: Object.freeze(defaultSize),
    minSize: Object.freeze(minSize),
  });
}

const MODE_CONFIG = Object.freeze({
  full: freezeModeConfig({ width: 720, height: 620 }, { width: 320, height: 300 }),
  compact: freezeModeConfig({ width: 380, height: 500 }, { width: 340, height: 260 }),
  mini: freezeModeConfig({ width: 300, height: 92 }, { width: 240, height: 78 }),
  zoom: freezeModeConfig({ width: 960, height: 680 }, { width: 480, height: 320 }),
  login: freezeModeConfig({ width: 860, height: 620 }, { width: 420, height: 460 }),
});

export function getWindowModeConfig(mode) {
  return Object.hasOwn(MODE_CONFIG, mode) ? MODE_CONFIG[mode] : MODE_CONFIG.full;
}

export function normalizeSavedWindowSize(mode, value) {
  const width = value?.width;
  const height = value?.height;
  if (
    typeof width !== 'number'
    || typeof height !== 'number'
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) return null;

  const { minSize } = getWindowModeConfig(mode);
  return {
    width: Math.max(minSize.width, Math.round(width)),
    height: Math.max(minSize.height, Math.round(height)),
  };
}

export function readWindowSizeMap(rawValue) {
  try {
    const value = JSON.parse(rawValue || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function updateWindowSizeMap(current, mode, size) {
  const normalized = normalizeSavedWindowSize(mode, size);
  return normalized ? { ...current, [mode]: normalized } : { ...current };
}
