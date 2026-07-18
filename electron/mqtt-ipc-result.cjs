async function connectMqttForRenderer(manager, payload = {}, logger) {
  try {
    const result = await manager.connect(payload);
    return { success: true, serialNumber: result.serialNumber };
  } catch (error) {
    const message = error?.message || 'MQTT connection failed';
    if (logger && typeof logger.error === 'function') {
      logger.error({ operation: 'mqtt-connect-failed', message });
    }
    return { success: false, error: message };
  }
}

module.exports = {
  connectMqttForRenderer,
};
