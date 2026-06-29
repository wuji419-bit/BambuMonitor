export const MQTT_RECONNECT_PERIOD_MS = 5000;
export const MQTT_RECONNECT_GRACE_MS = 45000;

function getConnectionSource(printer = {}) {
  return printer.connectionMode === 'cloud' || printer.statusSource === 'cloud'
    ? 'cloud'
    : 'local';
}

function getConnectionLabel(source) {
  return source === 'cloud' ? '云端状态连接' : '本地连接';
}

export function applyMqttReconnectingState(printer = {}) {
  const source = getConnectionSource(printer);
  return {
    ...printer,
    status: 'connecting',
    statusSource: source,
    connectionMode: printer.connectionMode || source,
    errorMsg: `${getConnectionLabel(source)}中断，正在自动重连...`,
  };
}

export function applyMqttConnectedState(printer = {}) {
  const source = getConnectionSource(printer);
  return {
    ...printer,
    status: ['connecting', 'disconnected', 'error'].includes(printer.status) ? 'connected' : printer.status,
    statusSource: source,
    connectionMode: printer.connectionMode || source,
    errorMsg: '',
  };
}

export function applyMqttDisconnectedState(printer = {}) {
  const source = getConnectionSource(printer);
  return {
    ...printer,
    status: 'disconnected',
    statusSource: source,
    connectionMode: printer.connectionMode || source,
    errorMsg: `${getConnectionLabel(source)}中断，自动重连失败，请检查网络或点击重连`,
  };
}

export function isReusableMqttConnectionStatus(status) {
  return !['error', 'disconnected'].includes(status);
}
