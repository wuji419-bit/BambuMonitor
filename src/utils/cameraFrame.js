export function isChamberSnapshotStream(stream) {
  return stream?.mode === 'chamber-image-mjpeg' && Boolean(stream?.snapshotUrl);
}

export function usesCameraStartupTimeout(stream) {
  return Boolean(
    stream?.success
    && stream?.url
    && !['chamber-image-mjpeg', 'nas-gateway'].includes(stream.mode),
  );
}

export function createVisibilityAwareCameraPoller({
  poll,
  onError,
  intervalMs = 700,
  documentVisible = true,
  cardVisible = false,
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  createAbortController = () => new AbortController(),
} = {}) {
  let started = false;
  let stopped = false;
  let timer = null;
  let activeController = null;

  const canPoll = () => started && !stopped && documentVisible && cardVisible;
  const suspend = () => {
    if (timer !== null) clearTimeoutImpl?.(timer);
    timer = null;
    activeController?.abort();
  };
  const schedule = (delay = 0) => {
    if (!canPoll() || timer !== null || activeController || typeof setTimeoutImpl !== 'function') return;
    timer = setTimeoutImpl(run, delay);
  };
  const run = async () => {
    timer = null;
    if (!canPoll()) return;
    const controller = createAbortController();
    activeController = controller;
    try {
      await poll(controller.signal);
    } catch (error) {
      onError?.(error);
    } finally {
      if (activeController === controller) activeController = null;
      schedule(intervalMs);
    }
  };

  return {
    start() {
      if (stopped) return;
      started = true;
      schedule();
    },
    setVisibility(next = {}) {
      if (typeof next.documentVisible === 'boolean') documentVisible = next.documentVisible;
      if (typeof next.cardVisible === 'boolean') cardVisible = next.cardVisible;
      if (canPoll()) schedule();
      else suspend();
    },
    stop() {
      stopped = true;
      started = false;
      suspend();
    },
  };
}

export function buildCameraFrameUrl(snapshotUrl, frame) {
  const rawUrl = String(snapshotUrl || '').trim();
  if (!rawUrl) return '';

  try {
    const url = new URL(rawUrl);
    url.searchParams.set('frame', String(frame));
    return url.toString();
  } catch {
    const [base, hash = ''] = rawUrl.split('#');
    const [path, search = ''] = base.split('?');
    const params = new URLSearchParams(search);
    params.set('frame', String(frame));
    const query = params.toString();
    return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
  }
}
