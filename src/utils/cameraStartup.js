export const DEFAULT_CAMERA_START_TIMEOUT_MS = 6000;
const CAMERA_RETRY_DELAYS_MS = [1500, 4000];

export function getCameraRetryDelay(attempt) {
  return CAMERA_RETRY_DELAYS_MS[Number(attempt)] ?? null;
}

export function isCameraSourceRetryable(source = {}) {
  return Boolean(source.serverManaged || (
    !source.customUrl
    && source.ip
    && source.accessCode
    && source.autoCameraSupported
  ));
}

export function createCameraWorkspaceLifecycle() {
  let active = false;
  let generation = 0;

  return {
    activate() {
      active = true;
      generation += 1;
      return generation;
    },
    invalidate() {
      active = false;
      generation += 1;
    },
    capture() {
      return active ? generation : null;
    },
    isCurrent(token) {
      return active && token !== null && token === generation;
    },
    runIfCurrent(token, callback) {
      if (!active || token === null || token !== generation) return undefined;
      return callback?.();
    },
  };
}

export function activateCameraWorkspace({ lifecycle, cameraWallOpenRef } = {}) {
  if (cameraWallOpenRef) cameraWallOpenRef.current = true;
  return lifecycle?.activate() ?? null;
}

export async function cleanupCameraWorkspace({
  lifecycle,
  cameraWallOpenRef,
  cameraRetryTimersRef,
  cameraRetryAttemptsRef,
  restartCameraRef,
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  stopAll,
} = {}) {
  lifecycle?.invalidate();
  if (cameraWallOpenRef) cameraWallOpenRef.current = false;
  for (const timer of Object.values(cameraRetryTimersRef?.current || {})) {
    clearTimeoutImpl?.(timer);
  }
  if (cameraRetryTimersRef) cameraRetryTimersRef.current = {};
  if (cameraRetryAttemptsRef) cameraRetryAttemptsRef.current = {};
  if (restartCameraRef) restartCameraRef.current = null;
  try {
    await stopAll?.();
  } catch {
    // Cleanup must remain safe when a runtime is already shutting down.
  }
}

export function buildInitialCameraState(source = {}) {
  const key = source.key;
  if (!key) return null;

  if (source.serverManaged) {
    return {
      key,
      shouldStart: true,
      stream: { success: false, pending: true },
      imageState: { status: 'loading' },
    };
  }

  if (source.customUrl) {
    return {
      key,
      shouldStart: false,
      stream: { success: true, url: source.customUrl, mode: 'custom' },
      imageState: { status: 'loading' },
    };
  }

  if (!source.ip || !source.accessCode) {
    return {
      key,
      shouldStart: false,
      stream: { success: false, error: '需要本地 IP 和访问码' },
      imageState: { status: 'error', message: '需要本地 IP 和访问码' },
    };
  }

  if (!source.autoCameraSupported) {
    return {
      key,
      shouldStart: false,
      stream: { success: false, error: '该机型摄像头需要手动配置' },
      imageState: {
        status: 'manual',
        message: '该机型不是自动摄像头流，请在设置里填写 MJPEG 或快照 URL',
      },
    };
  }

  return {
    key,
    shouldStart: true,
    stream: { success: false, pending: true },
    imageState: { status: 'loading' },
  };
}

export function cameraStartWithTimeout(promise, timeoutMs = DEFAULT_CAMERA_START_TIMEOUT_MS, label = '摄像头') {
  let timeout = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} 打开超时`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeout);
  });
}

export function cameraStartResultState(result) {
  if (result?.success) {
    return {
      stream: result,
      imageState: { status: 'loading' },
    };
  }

  const message = result?.error || '打开失败';
  return {
    stream: { success: false, error: message },
    imageState: { status: 'error', message },
  };
}

export function cameraStartErrorState(error) {
  const message = error?.message || '打开失败';
  return {
    stream: { success: false, error: message },
    imageState: { status: 'error', message },
  };
}
