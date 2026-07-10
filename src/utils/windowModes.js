export const WINDOW_SIZE_STORAGE_KEY = 'bambu_window_sizes_v1';

const MODE_CONFIG = Object.freeze({
  full: { defaultSize: { width: 720, height: 620 }, minSize: { width: 320, height: 300 } },
  compact: { defaultSize: { width: 380, height: 500 }, minSize: { width: 340, height: 260 } },
  mini: { defaultSize: { width: 300, height: 92 }, minSize: { width: 240, height: 78 } },
  zoom: { defaultSize: { width: 960, height: 680 }, minSize: { width: 480, height: 320 } },
  login: { defaultSize: { width: 860, height: 620 }, minSize: { width: 420, height: 460 } },
});

export function getWindowModeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.full;
}

export function normalizeSavedWindowSize(mode, value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

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
