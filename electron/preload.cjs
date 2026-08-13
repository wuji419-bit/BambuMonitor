const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload cannot require local modules, so this mirrors
// createWindowBoundsSaveRequestHandler in window-bounds.cjs.
function createWindowBoundsSaveRequestHandler(callback, acknowledge) {
  return async (payload) => {
    try {
      await callback(payload);
    } catch {
      // Closing must continue even if renderer-side persistence fails.
    } finally {
      try {
        acknowledge(payload?.requestId);
      } catch {
        // Main also has a bounded fallback if the renderer is already closing.
      }
    }
  };
}

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

function subscribeWindowBoundsSaveRequest(callback) {
  if (typeof callback !== 'function') {
    return () => {};
  }

  const handleRequest = createWindowBoundsSaveRequestHandler(
    callback,
    (requestId) => ipcRenderer.send('window-bounds-save-ack', { requestId }),
  );
  const listener = (_event, payload) => {
    void handleRequest(payload);
  };
  let subscribed = true;

  ipcRenderer.on('window-bounds-save-request', listener);
  return () => {
    if (!subscribed) return;
    subscribed = false;
    ipcRenderer.removeListener('window-bounds-save-request', listener);
  };
}

contextBridge.exposeInMainWorld('bambuApi', {
  isElectron: true,
  accounts: {
    list: () => ipcRenderer.invoke('accounts-list'),
    loginPassword: (payload) => ipcRenderer.invoke('accounts-login-password', payload),
    requestVerifyCode: (payload) => ipcRenderer.invoke('accounts-code-request', payload),
    loginCode: (payload) => ipcRenderer.invoke('accounts-login-code', payload),
    updateRemark: (payload) => ipcRenderer.invoke('accounts-update-remark', payload),
    reauthenticate: (payload) => ipcRenderer.invoke('accounts-reauthenticate', payload),
    remove: (payload) => ipcRenderer.invoke('accounts-remove', payload),
    refresh: (payload) => ipcRenderer.invoke('accounts-refresh', payload),
  },
  devices: {
    scanPrinters: () => ipcRenderer.invoke('scan-printers'),
  },
  mqtt: {
    connect: (payload) => ipcRenderer.invoke('mqtt-connect', payload),
    disconnect: (payload) => ipcRenderer.invoke('mqtt-disconnect', payload),
    disconnectAll: () => ipcRenderer.invoke('mqtt-disconnect-all'),
  },
  notifications: {
    send: (payload) => ipcRenderer.invoke('notification-send', payload),
  },
  app: {
    getStartupEnabled: () => ipcRenderer.invoke('startup-get'),
    setStartupEnabled: (payload) => ipcRenderer.invoke('startup-set', payload),
  },
  camera: {
    start: (payload) => ipcRenderer.invoke('camera-start', payload),
    stop: (payload) => ipcRenderer.invoke('camera-stop', payload),
    stopAll: () => ipcRenderer.invoke('camera-stop-all'),
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    close: () => ipcRenderer.send('window-close'),
    quit: () => ipcRenderer.send('app-quit'),
    resize: (bounds) => ipcRenderer.send('resize-me', bounds),
    setModeSize: (bounds) => ipcRenderer.send('resize-me', bounds),
    setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),
    setAlwaysOnTop: (flag) => ipcRenderer.send('toggle-always-on-top', flag),
    setOpacity: (opacity) => ipcRenderer.send('set-window-opacity', opacity),
  },
  events: {
    onLockStatusChanged: subscribe('lock-status-changed'),
    onToggleLayout: subscribe('toggle-layout'),
    onAlwaysOnTopChanged: subscribe('always-on-top-changed'),
    onWindowOpacityChanged: subscribe('window-opacity-changed'),
    onWindowBoundsChanged: subscribe('window-bounds-changed'),
    onWindowBoundsSaveRequest: subscribeWindowBoundsSaveRequest,
    onMqttData: subscribe('mqtt-data'),
    onMqttConnected: subscribe('mqtt-connected'),
    onMqttReconnecting: subscribe('mqtt-reconnecting'),
    onMqttDisconnected: subscribe('mqtt-disconnected'),
    onAccountsChanged: subscribe('accounts-changed'),
  },
});
