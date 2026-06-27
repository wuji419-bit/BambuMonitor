export const MQTT_RECONNECT_PERIOD_MS = 5000;
export const MQTT_RECONNECT_GRACE_MS = 45000;

export function applyMqttReconnectingState(printer = {}) {
  return {
    ...printer,
    status: 'connecting',
    statusSource: 'local',
    errorMsg: '本地连接中断，正在自动重连...',
  };
}

export function applyMqttConnectedState(printer = {}) {
  return {
    ...printer,
    status: ['connecting', 'disconnected', 'error'].includes(printer.status) ? 'connected' : printer.status,
    statusSource: 'local',
    errorMsg: '',
  };
}

export function applyMqttDisconnectedState(printer = {}) {
  return {
    ...printer,
    status: 'disconnected',
    statusSource: 'local',
    errorMsg: '本地连接中断，自动重连失败，请检查打印机网络或点击重连',
  };
}

export function isReusableMqttConnectionStatus(status) {
  return !['error', 'disconnected'].includes(status);
}
