function finitePositiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
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
  const minWidth = Math.max(96, finitePositiveOr(bounds?.minWidth, 320));
  const minHeight = Math.max(56, finitePositiveOr(bounds?.minHeight, 300));
  const workAreaWidth = finitePositiveOr(workArea?.width, minWidth + 24);
  const workAreaHeight = finitePositiveOr(workArea?.height, minHeight + 24);
  const maxWidth = Math.max(minWidth, workAreaWidth - 24);
  const maxHeight = Math.max(minHeight, workAreaHeight - 24);
  const requestedWidth = finitePositiveOr(bounds?.width, minWidth);
  const requestedHeight = finitePositiveOr(bounds?.height, minHeight);

  return {
    width: Math.round(Math.min(maxWidth, Math.max(minWidth, requestedWidth))),
    height: Math.round(Math.min(maxHeight, Math.max(minHeight, requestedHeight))),
    minWidth,
    minHeight,
  };
}

module.exports = {
  clampWindowSize,
  getMainWindowOptions,
};
