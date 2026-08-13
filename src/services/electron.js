function getElectronApi() {
  if (typeof window === 'undefined') return null;
  return window.bambuApi || null;
}

function noOp() {}

function requireElectronApi(errorMessage = '此功能仅在桌面版可用') {
  const api = getElectronApi();
  if (!api) {
    throw new Error(errorMessage);
  }
  return api;
}

export function isElectronEnvironment() {
  return Boolean(getElectronApi()?.isElectron);
}

const DESKTOP_ACCOUNT_API_UNAVAILABLE = '当前桌面版缺少安全账户接口，请更新或重新安装 BambuMonitor';

export const electronAuth = {
  cloudLogin() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  requestVerifyCode() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  cloudLoginCode() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  getDeviceList() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  getSavedSession() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  saveSession() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
  clearSavedSession() { return unsupported(DESKTOP_ACCOUNT_API_UNAVAILABLE); },
};

function normalizeAccountState(state = {}) {
  const connectionState = state.connectionState || state.status || 'idle';
  return {
    accountId: state.accountId,
    connectionState,
    ...(typeof state.errorCode === 'string' ? { errorCode: state.errorCode } : {}),
    ...(Number.isFinite(state.syncedAt) ? { syncedAt: state.syncedAt } : {}),
    ...(Number.isSafeInteger(state.deviceCount) ? { deviceCount: state.deviceCount } : {}),
  };
}

function adaptAccountResult(result = {}) {
  if (!result?.success) return result;
  const adapted = { success: true };
  if (result.snapshot && typeof result.snapshot === 'object') {
    const snapshot = result.snapshot;
    adapted.accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts.map((account) => ({ ...account })) : [];
    adapted.states = Array.isArray(snapshot.accountStates)
      ? snapshot.accountStates.map(normalizeAccountState)
      : (Array.isArray(snapshot.states) ? snapshot.states.map(normalizeAccountState) : []);
    adapted.devices = Array.isArray(snapshot.devices) ? snapshot.devices.map((device) => ({ ...device })) : [];
  }
  for (const field of ['account', 'removed']) {
    if (result[field] && typeof result[field] === 'object') adapted[field] = { ...result[field] };
  }
  for (const field of ['message', 'error']) {
    if (typeof result[field] === 'string') adapted[field] = result[field];
  }
  for (const field of ['needVerifyCode', 'needTfa', 'codeExpired']) {
    if (result[field] === true) adapted[field] = true;
  }
  return adapted;
}

export const electronAccounts = {
  async list() {
    return adaptAccountResult(await requireElectronApi().accounts.list());
  },
  async add(payload) {
    return adaptAccountResult(await requireElectronApi().accounts.loginPassword(payload));
  },
  async requestVerifyCode(payload) {
    return adaptAccountResult(await requireElectronApi().accounts.requestVerifyCode(payload));
  },
  async addWithCode(payload) {
    return adaptAccountResult(await requireElectronApi().accounts.loginCode(payload));
  },
  async updateRemark(accountId, remark) {
    return adaptAccountResult(await requireElectronApi().accounts.updateRemark({ accountId, remark }));
  },
  async reauthenticate(accountId, payload) {
    return adaptAccountResult(await requireElectronApi().accounts.reauthenticate({
      ...payload,
      accountId,
      method: Object.hasOwn(payload || {}, 'code') ? 'code' : 'password',
    }));
  },
  async remove(accountId) {
    return adaptAccountResult(await requireElectronApi().accounts.remove({ accountId }));
  },
  async refresh(accountId) {
    const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
    return adaptAccountResult(await requireElectronApi().accounts.refresh(
      normalizedAccountId ? { accountId: normalizedAccountId } : {},
    ));
  },
};

export const electronDevices = {
  scanPrinters() {
    return requireElectronApi().devices.scanPrinters();
  },
};

export const electronMqtt = {
  connect(payload) {
    return requireElectronApi('仅支持桌面版').mqtt.connect(payload);
  },
  disconnect(payload) {
    return requireElectronApi('仅支持桌面版').mqtt.disconnect(payload);
  },
  disconnectAll() {
    return requireElectronApi('仅支持桌面版').mqtt.disconnectAll();
  },
};

export const electronNotifications = {
  send(payload) {
    return requireElectronApi('仅支持桌面版').notifications.send(payload);
  },
};

export const electronApp = {
  getStartupEnabled() {
    return requireElectronApi('仅支持桌面版').app.getStartupEnabled();
  },
  setStartupEnabled(payload) {
    return requireElectronApi('仅支持桌面版').app.setStartupEnabled(payload);
  },
};

export const electronCamera = {
  start(payload) {
    return requireElectronApi('仅支持桌面版').camera.start(payload);
  },
  stop(payload) {
    return requireElectronApi('仅支持桌面版').camera.stop(payload);
  },
  stopAll() {
    return requireElectronApi('仅支持桌面版').camera.stopAll();
  },
};

export const electronWindow = {
  minimize() {
    getElectronApi()?.window.minimize();
  },
  close() {
    getElectronApi()?.window.close();
  },
  quit() {
    getElectronApi()?.window.quit();
  },
  resize(bounds) {
    getElectronApi()?.window.resize(bounds);
  },
  setModeSize(bounds) {
    getElectronApi()?.window.setModeSize(bounds);
  },
  setIgnoreMouseEvents(ignore) {
    getElectronApi()?.window.setIgnoreMouseEvents(ignore);
  },
  setAlwaysOnTop(flag) {
    getElectronApi()?.window.setAlwaysOnTop(flag);
  },
  setOpacity(opacity) {
    getElectronApi()?.window.setOpacity(opacity);
  },
};

export const electronEvents = {
  onLockStatusChanged(callback) {
    return getElectronApi()?.events.onLockStatusChanged(callback) || noOp;
  },
  onToggleLayout(callback) {
    return getElectronApi()?.events.onToggleLayout(callback) || noOp;
  },
  onAlwaysOnTopChanged(callback) {
    return getElectronApi()?.events.onAlwaysOnTopChanged(callback) || noOp;
  },
  onWindowOpacityChanged(callback) {
    return getElectronApi()?.events.onWindowOpacityChanged(callback) || noOp;
  },
  onWindowBoundsChanged(callback) {
    return getElectronApi()?.events.onWindowBoundsChanged(callback) || noOp;
  },
  onWindowBoundsSaveRequest(callback) {
    return getElectronApi()?.events.onWindowBoundsSaveRequest(callback) || noOp;
  },
  onMqttData(callback) {
    return getElectronApi()?.events.onMqttData(callback) || noOp;
  },
  onMqttConnected(callback) {
    return getElectronApi()?.events.onMqttConnected(callback) || noOp;
  },
  onMqttReconnecting(callback) {
    return getElectronApi()?.events.onMqttReconnecting(callback) || noOp;
  },
  onMqttDisconnected(callback) {
    return getElectronApi()?.events.onMqttDisconnected(callback) || noOp;
  },
};

function unsupported(error = '此功能仅在 NAS 网页版可用') {
  return Promise.resolve({ success: false, error, code: 'UNSUPPORTED' });
}

export function createElectronRuntime() {
  const managedAccounts = Boolean(getElectronApi()?.accounts);
  const managedEventReleases = new Set();
  const subscribeToAccountSnapshots = (listener) => {
    const release = getElectronApi()?.events?.onAccountsChanged?.(listener) || noOp;
    managedEventReleases.add(release);
    return () => {
      managedEventReleases.delete(release);
      release();
    };
  };
  const managedAuth = {
    async cloudLogin(payload) {
      const result = await electronAccounts.add(payload);
      return result.success ? { ...result, managedSession: true } : result;
    },
    requestVerifyCode(payload) {
      return electronAccounts.requestVerifyCode(payload);
    },
    async cloudLoginCode(payload) {
      const result = await electronAccounts.addWithCode(payload);
      return result.success ? { ...result, managedSession: true } : result;
    },
    async getDeviceList() {
      const result = await electronAccounts.refresh();
      return result.success ? { ...result, syncedAt: Date.now() } : result;
    },
    async getSavedSession() {
      const result = await electronAccounts.list();
      if (!result.success) return result;
      const first = result.accounts[0];
      return {
        success: true,
        session: first ? {
          managedSession: true,
          account: first.label || first.accountMasked,
          accountMasked: first.accountMasked,
        } : null,
      };
    },
    async saveSession() {
      return { success: true };
    },
    async clearSavedSession() {
      const listed = await electronAccounts.list();
      if (!listed.success) return listed;
      for (const account of listed.accounts) {
        const removed = await electronAccounts.remove(account.accountId);
        if (!removed.success) return removed;
      }
      return { success: true, authenticated: false };
    },
  };
  const auth = managedAccounts ? managedAuth : electronAuth;
  const accounts = managedAccounts ? electronAccounts : null;

  return {
    kind: 'electron',
    capabilities: {
      nativeWindow: true,
      startup: true,
      mousePassthrough: true,
      localScan: true,
      serverSettings: false,
    },
    auth,
    accounts,
    devices: {
      refresh(payload) {
        return auth.getDeviceList(payload);
      },
      update() {
        return unsupported();
      },
      scanPrinters() {
        return electronDevices.scanPrinters();
      },
    },
    camera: electronCamera,
    mqtt: electronMqtt,
    settings: {
      get() { return unsupported(); },
      update() { return unsupported(); },
    },
    notifications: electronNotifications,
    events: {
      onDeviceSnapshot(listener) {
        if (!managedAccounts) return noOp;
        return subscribeToAccountSnapshots((snapshot) => listener?.({
          type: 'devices.snapshot',
          devices: Array.isArray(snapshot?.devices) ? snapshot.devices.map((device) => ({ ...device })) : [],
          syncedAt: Date.now(),
        }));
      },
      onDeviceUpdate() { return noOp; },
      onAccountUpdated(listener) {
        if (!managedAccounts) return noOp;
        return subscribeToAccountSnapshots((snapshot) => {
          for (const state of snapshot?.accountStates || []) {
            if (state?.status !== 'invalid') listener?.({
              type: 'account.updated', accountId: state.accountId, state: normalizeAccountState(state),
            });
          }
        });
      },
      onAccountInvalid(listener) {
        if (!managedAccounts) return noOp;
        return subscribeToAccountSnapshots((snapshot) => {
          for (const state of snapshot?.accountStates || []) {
            if (state?.status === 'invalid') listener?.({
              type: 'account.invalid', accountId: state.accountId, state: normalizeAccountState(state),
            });
          }
        });
      },
      onAccountRemoved(listener) {
        if (!managedAccounts) return noOp;
        let previous = null;
        return subscribeToAccountSnapshots((snapshot) => {
          const current = new Set((snapshot?.accounts || []).map(({ accountId }) => accountId));
          if (previous) {
            for (const accountId of previous) {
              if (!current.has(accountId)) listener?.({ type: 'account.removed', accountId });
            }
          }
          previous = current;
        });
      },
      onSessionInvalid() { return noOp; },
      close() {
        for (const release of [...managedEventReleases]) release();
        managedEventReleases.clear();
      },
    },
    close: noOp,
    window: electronWindow,
    startup: electronApp,
  };
}
