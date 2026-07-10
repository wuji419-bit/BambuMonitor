export function buildCameraCardPresentation({ imageState, stream, customUrl, hasIp = false } = {}) {
  const status = imageState?.status;
  const ready = status === 'ready';
  const label = ready ? (customUrl ? '自定义' : '有画面') : status === 'manual' ? '需配置' : status === 'error' ? '无画面' : (stream?.pending || status === 'loading' || stream?.success) ? '连接中' : '待连接';
  return { label, message: ready ? '' : (imageState?.message || stream?.error || (hasIp ? '正在打开摄像头...' : '需要本地 IP 才能自动打开')), showRetry: status === 'error' };
}

export function cameraRetryLabel(printer = {}) {
  return `重试 ${printer.name || '未命名打印机'} 摄像头`;
}

export function nextCameraFit(current) {
  return current === 'contain' ? 'cover' : 'contain';
}

export function cameraFitReducer(state, action) {
  if (action?.type === 'sync') {
    return action.imageKey === state.imageKey
      ? state
      : { imageKey: action.imageKey, fit: 'contain' };
  }
  if (action?.type === 'toggle') {
    return { ...state, fit: nextCameraFit(state.fit) };
  }
  return state;
}

export function shouldClearCameraZoom({ selectedKey, printer, zoomState } = {}) {
  return Boolean(selectedKey) && (!printer || !zoomState?.canZoom);
}
