export const DEFAULT_CAMERA_START_TIMEOUT_MS = 6000;

export function buildInitialCameraState(source = {}) {
  const key = source.key;
  if (!key) return null;

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
