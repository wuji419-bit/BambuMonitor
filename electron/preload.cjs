const { contextBridge, ipcRenderer } = require('electron');

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

contextBridge.exposeInMainWorld('bambuApi', {
  isElectron: true,
  auth: {
    cloudLogin: (payload) => ipcRenderer.invoke('cloud-login', payload),
    requestVerifyCode: (payload) => ipcRenderer.invoke('request-verify-code', payload),
    cloudLoginCode: (payload) => ipcRenderer.invoke('cloud-login-code', payload),
    getDeviceList: (payload) => ipcRenderer.invoke('get-device-list', payload),
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
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    close: () => ipcRenderer.send('window-close'),
    quit: () => ipcRenderer.send('app-quit'),
    resize: (bounds) => ipcRenderer.send('resize-me', bounds),
    setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse-events', ignore),
    setAlwaysOnTop: (flag) => ipcRenderer.send('toggle-always-on-top', flag),
    setOpacity: (opacity) => ipcRenderer.send('set-window-opacity', opacity),
  },
  events: {
    onLockStatusChanged: subscribe('lock-status-changed'),
    onToggleLayout: subscribe('toggle-layout'),
    onAlwaysOnTopChanged: subscribe('always-on-top-changed'),
    onWindowOpacityChanged: subscribe('window-opacity-changed'),
    onMqttData: subscribe('mqtt-data'),
    onMqttDisconnected: subscribe('mqtt-disconnected'),
  },
});
