const MAX_EVENT_BYTES = 256 * 1024;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeApiError(body, status) {
  const source = body?.error;
  const error = typeof source === 'string'
    ? source
    : (typeof source?.message === 'string' ? source.message : '请求失败');
  const code = typeof source?.code === 'string'
    ? source.code
    : (typeof body?.code === 'string' ? body.code : undefined);
  return { success: false, error, code, status };
}

function safeHttpError(status) {
  if (status === 401) {
    return { success: false, error: '登录状态已失效', code: 'UNAUTHORIZED', status };
  }
  return { success: false, error: '请求失败', code: 'HTTP_ERROR', status };
}

function protocolError(status) {
  return { success: false, error: '服务器响应格式无效', code: 'INVALID_RESPONSE', status };
}

function staleAuthAttempt() {
  return { success: false, stale: true, code: 'STALE_AUTH_ATTEMPT', status: 0 };
}

function adaptSnapshot(data) {
  return {
    success: true,
    devices: Array.isArray(data?.devices) ? clone(data.devices) : [],
    syncedAt: data?.syncedAt,
    cloudState: data?.cloudState,
  };
}

function knownEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'devices.snapshot' && Array.isArray(value.devices)) {
    return {
      type: value.type,
      devices: clone(value.devices),
      syncedAt: value.syncedAt,
      cloudState: value.cloudState,
    };
  }
  if (value.type === 'device.updated' && value.device && typeof value.device === 'object') {
    return { type: value.type, device: clone(value.device) };
  }
  if (value.type === 'session.invalid') return { type: value.type };
  return null;
}

function exceedsEventLimit(value) {
  if (value.length > MAX_EVENT_BYTES) return true;
  if (typeof TextEncoder !== 'function') return false;
  return new TextEncoder().encode(value).byteLength > MAX_EVENT_BYTES;
}

export function createWebRuntime({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
  location = globalThis.location,
} = {}) {
  const listeners = {
    'devices.snapshot': new Set(),
    'device.updated': new Set(),
    'session.invalid': new Set(),
  };
  let csrfToken = '';
  let authenticated = false;
  let invalidEmitted = false;
  let sessionGeneration = 0;
  let authAttemptGeneration = 0;
  let eventGeneration = 0;
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;

  const hasListeners = () => Object.values(listeners).some((set) => set.size > 0);

  function emit(type, event) {
    for (const listener of [...listeners[type]]) {
      try {
        Promise.resolve(listener(clone(event))).catch(() => {});
      } catch {
        // A consumer cannot interrupt delivery to the remaining listeners.
      }
    }
  }

  function clearReconnect() {
    if (reconnectTimer === null) return;
    clearTimeoutImpl?.(reconnectTimer);
    reconnectTimer = null;
  }

  function stopEventGeneration({ clearListeners = false } = {}) {
    eventGeneration += 1;
    clearReconnect();
    const activeSocket = socket;
    socket = null;
    if (activeSocket) {
      activeSocket.onopen = null;
      activeSocket.onmessage = null;
      activeSocket.onerror = null;
      activeSocket.onclose = null;
      try { activeSocket.close(1000, 'Renderer closed'); } catch { /* already closed */ }
    }
    if (clearListeners) {
      for (const set of Object.values(listeners)) set.clear();
    }
  }

  function invalidateSession(expectedGeneration = sessionGeneration) {
    if (expectedGeneration !== sessionGeneration) return false;
    sessionGeneration += 1;
    csrfToken = '';
    authenticated = false;
    stopEventGeneration();
    if (invalidEmitted) return true;
    invalidEmitted = true;
    emit('session.invalid', { type: 'session.invalid' });
    return true;
  }

  async function request(path, { method = 'GET', body } = {}) {
    if (typeof fetchImpl !== 'function') {
      return { success: false, error: '网络请求不可用', code: 'NETWORK_UNAVAILABLE', status: 0 };
    }
    const requestSessionGeneration = sessionGeneration;
    const requestCsrfToken = csrfToken;
    const headers = { Accept: 'application/json' };
    const mutation = ['POST', 'PATCH', 'PUT'].includes(method);
    if (mutation) {
      headers['Content-Type'] = 'application/json';
      if (requestCsrfToken) headers['X-CSRF-Token'] = requestCsrfToken;
    }

    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers,
        ...(mutation ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      return { success: false, error: '网络请求失败', code: 'NETWORK_ERROR', status: 0 };
    }

    if (response.status === 401) invalidateSession(requestSessionGeneration);

    let payload;
    try {
      payload = await response.json();
    } catch {
      return response.ok ? protocolError(response.status) : safeHttpError(response.status);
    }

    if (!response.ok || payload?.ok !== true) return safeApiError(payload, response.status);
    return { success: true, data: payload.data, status: response.status };
  }

  function scheduleReconnect(generation) {
    if (!authenticated || generation !== eventGeneration || reconnectTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl?.(() => {
      reconnectTimer = null;
      connectSocket(generation);
    }, delay) ?? null;
  }

  function connectSocket(generation) {
    if (!authenticated || generation !== eventGeneration || typeof WebSocketImpl !== 'function') return;
    const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location?.host || 'localhost';
    const candidate = new WebSocketImpl(`${protocol}//${host}/api/ws`);
    socket = candidate;

    candidate.onopen = () => {
      if (generation !== eventGeneration || socket !== candidate) return;
      reconnectAttempt = 0;
    };
    candidate.onmessage = ({ data }) => {
      if (generation !== eventGeneration || socket !== candidate || typeof data !== 'string') return;
      if (exceedsEventLimit(data)) return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }
      const event = knownEvent(parsed);
      if (!event) return;
      if (event.type === 'session.invalid') {
        invalidateSession(sessionGeneration);
        return;
      }
      emit(event.type, event);
    };
    candidate.onerror = () => {
      if (generation !== eventGeneration || socket !== candidate) return;
      try { candidate.close(); } catch { /* close handler schedules retry */ }
      scheduleReconnect(generation);
    };
    candidate.onclose = () => {
      if (generation !== eventGeneration || socket !== candidate) return;
      socket = null;
      scheduleReconnect(generation);
    };
  }

  async function fetchFallback(generation) {
    const result = await request('/api/devices');
    if (generation !== eventGeneration || !authenticated || !result.success) return;
    const event = knownEvent(result.data);
    if (event?.type === 'devices.snapshot') emit(event.type, event);
  }

  function startEventGeneration() {
    stopEventGeneration();
    const generation = eventGeneration;
    reconnectAttempt = 0;
    connectSocket(generation);
    void fetchFallback(generation);
  }

  function ensureEvents() {
    if (authenticated && hasListeners() && !socket && reconnectTimer === null) {
      startEventGeneration();
    }
  }

  function beginAuthenticatedSession(data) {
    sessionGeneration += 1;
    csrfToken = typeof data?.csrfToken === 'string' ? data.csrfToken : '';
    authenticated = true;
    invalidEmitted = false;
    if (hasListeners()) startEventGeneration();
    else stopEventGeneration();
  }

  function subscribe(type, listener) {
    if (typeof listener !== 'function') return () => {};
    const set = listeners[type];
    set.add(listener);
    ensureEvents();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(listener);
    };
  }

  function closeEvents() {
    authAttemptGeneration += 1;
    sessionGeneration += 1;
    csrfToken = '';
    authenticated = false;
    invalidEmitted = false;
    stopEventGeneration({ clearListeners: true });
  }

  async function completeLogin(path, payload) {
    const attempt = ++authAttemptGeneration;
    const result = await request(path, { method: 'POST', body: payload });
    if (attempt !== authAttemptGeneration) return staleAuthAttempt();
    if (!result.success) return result;
    beginAuthenticatedSession(result.data);
    return {
      success: true,
      serverSession: true,
      accountMasked: result.data?.accountMasked,
      expiresAt: result.data?.expiresAt,
    };
  }

  const runtime = {
    kind: 'web',
    capabilities: {
      nativeWindow: false,
      startup: false,
      mousePassthrough: false,
      localScan: false,
      serverSettings: true,
    },
    auth: {
      cloudLogin(payload) {
        return completeLogin('/api/auth/login', payload);
      },
      requestVerifyCode: async (payload) => {
        const result = await request('/api/auth/code/request', { method: 'POST', body: payload });
        if (!result.success) return result;
        return {
          success: true,
          sent: result.data?.sent === true,
          message: '验证码已发送，请查看短信或邮箱',
        };
      },
      cloudLoginCode(payload) {
        return completeLogin('/api/auth/code/verify', payload);
      },
      async getDeviceList() {
        const result = await request('/api/devices');
        return result.success ? adaptSnapshot(result.data) : result;
      },
      async getSavedSession() {
        const attempt = ++authAttemptGeneration;
        const result = await request('/api/session');
        if (attempt !== authAttemptGeneration) return staleAuthAttempt();
        if (!result.success) return result;
        if (!result.data?.authenticated) {
          sessionGeneration += 1;
          csrfToken = '';
          authenticated = false;
          stopEventGeneration();
          return { success: true, session: null };
        }
        beginAuthenticatedSession(result.data);
        const account = result.data.accountMasked || '';
        return {
          success: true,
          session: { serverSession: true, account, accountMasked: account },
        };
      },
      async saveSession() {
        return { success: true };
      },
      async clearSavedSession() {
        const attempt = ++authAttemptGeneration;
        const pending = request('/api/auth/logout', { method: 'POST', body: {} });
        sessionGeneration += 1;
        csrfToken = '';
        authenticated = false;
        invalidEmitted = false;
        stopEventGeneration();
        const result = await pending;
        if (attempt !== authAttemptGeneration) return staleAuthAttempt();
        if (!result.success) return result;
        return { success: true, authenticated: result.data?.authenticated === true };
      },
    },
    devices: {
      async refresh() {
        const result = await request('/api/devices/refresh', { method: 'POST', body: {} });
        return result.success ? adaptSnapshot(result.data) : result;
      },
      async update(serialNumber, patch) {
        const result = await request(`/api/devices/${encodeURIComponent(serialNumber)}`, {
          method: 'PATCH', body: patch,
        });
        return result.success ? { success: true, device: clone(result.data) } : result;
      },
      async scanPrinters() {
        return { success: false, error: '局域网扫描仅在桌面版可用', code: 'UNSUPPORTED' };
      },
    },
    camera: {
      async start({ serialNumber } = {}) {
        const serial = encodeURIComponent(String(serialNumber || ''));
        if (!serial) return { success: false, error: '缺少打印机序列号', code: 'BAD_REQUEST' };
        return {
          success: true,
          mode: 'nas-gateway',
          snapshotUrl: `/api/cameras/${serial}/frame`,
          url: `/api/cameras/${serial}/stream`,
        };
      },
      async stop() { return { success: true }; },
      async stopAll() { return { success: true }; },
    },
    settings: {
      async get() {
        const result = await request('/api/settings');
        return result.success ? { success: true, settings: clone(result.data) } : result;
      },
      async save(settings) {
        const result = await request('/api/settings', { method: 'PUT', body: settings });
        return result.success ? { success: true, settings: clone(result.data) } : result;
      },
    },
    notifications: {
      async send() {
        const result = await request('/api/notifications/test', { method: 'POST', body: {} });
        return result.success ? { success: true, sent: result.data?.sent === true } : result;
      },
    },
    events: {
      onDeviceSnapshot(listener) { return subscribe('devices.snapshot', listener); },
      onDeviceUpdate(listener) { return subscribe('device.updated', listener); },
      onSessionInvalid(listener) { return subscribe('session.invalid', listener); },
      close: closeEvents,
    },
    close() {
      return runtime.events.close();
    },
  };

  return runtime;
}
