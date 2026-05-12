function getElectronApi() {
    if (typeof window === 'undefined') return null;
    return window.bambuApi || null;
}

function noOp() { }

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

export const electronAuth = {
    cloudLogin(payload) {
        return requireElectronApi().auth.cloudLogin(payload);
    },
    requestVerifyCode(payload) {
        return requireElectronApi().auth.requestVerifyCode(payload);
    },
    cloudLoginCode(payload) {
        return requireElectronApi().auth.cloudLoginCode(payload);
    },
    getDeviceList(payload) {
        return requireElectronApi().auth.getDeviceList(payload);
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
    onMqttData(callback) {
        return getElectronApi()?.events.onMqttData(callback) || noOp;
    },
    onMqttDisconnected(callback) {
        return getElectronApi()?.events.onMqttDisconnected(callback) || noOp;
    },
};
