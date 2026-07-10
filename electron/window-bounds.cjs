const WORK_AREA_PADDING = 24;
const WIDTH_FLOOR = 96;
const HEIGHT_FLOOR = 56;
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 300;
const NATIVE_DIMENSION_MAX = 0x7fffffff;

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getWorkAreaMaximum(value, fallback, floor) {
  if (!isFinitePositive(value)) return fallback;

  const integer = Math.floor(value);
  if (!Number.isSafeInteger(integer)) return fallback;

  const nativeWorkArea = Math.min(integer, NATIVE_DIMENSION_MAX + WORK_AREA_PADDING);
  return Math.max(floor, nativeWorkArea - WORK_AREA_PADDING);
}

function clampMinimum(value, fallback, floor, maximum) {
  const candidate = isFinitePositive(value) ? value : fallback;
  return Math.ceil(Math.min(maximum, Math.max(floor, candidate)));
}

function clampRequested(value, minimum, maximum) {
  const candidate = isFinitePositive(value) ? value : minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, candidate)));
}

function getMainWindowOptions(bounds = {}) {
  return {
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#0b1017',
    hasShadow: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    useContentSize: true,
  };
}

function clampWindowSize(bounds = {}, workArea = {}) {
  const maxWidth = getWorkAreaMaximum(workArea?.width, DEFAULT_MIN_WIDTH, WIDTH_FLOOR);
  const maxHeight = getWorkAreaMaximum(workArea?.height, DEFAULT_MIN_HEIGHT, HEIGHT_FLOOR);
  const minWidth = clampMinimum(
    bounds?.minWidth,
    DEFAULT_MIN_WIDTH,
    WIDTH_FLOOR,
    maxWidth,
  );
  const minHeight = clampMinimum(
    bounds?.minHeight,
    DEFAULT_MIN_HEIGHT,
    HEIGHT_FLOOR,
    maxHeight,
  );

  return {
    width: clampRequested(bounds?.width, minWidth, maxWidth),
    height: clampRequested(bounds?.height, minHeight, maxHeight),
    minWidth,
    minHeight,
  };
}

function withCurrentWindowSize(bounds = {}, currentSize = []) {
  const requested = bounds && typeof bounds === 'object' && !Array.isArray(bounds)
    ? bounds
    : {};
  const [currentWidth, currentHeight] = Array.isArray(currentSize) ? currentSize : [];

  return {
    ...requested,
    width: requested.width === undefined ? currentWidth : requested.width,
    height: requested.height === undefined ? currentHeight : requested.height,
  };
}

module.exports = {
  clampWindowSize,
  getMainWindowOptions,
  withCurrentWindowSize,
};
