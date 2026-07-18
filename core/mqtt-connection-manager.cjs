const crypto = require('node:crypto');

const MQTT_CONNECT_TIMEOUT_MS = 15000;
const MQTT_RECONNECT_PERIOD_MS = 5000;
const MQTT_RECONNECT_GRACE_MS = 45000;
const PUSH_ALL_PAYLOAD = JSON.stringify({
  pushing: {
    sequence_id: '0',
    command: 'pushall',
  },
});

function createFingerprint({ mode, url, options = {} }) {
  const effectiveConfig = [
    String(mode || ''),
    String(url || ''),
    options.username ?? null,
    options.password ?? null,
    Boolean(options.rejectUnauthorized),
  ];

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(effectiveConfig))
    .digest('hex');
}

function redactCredentialUrls(message) {
  return message.replace(/mqtts?:\/\/[^\s/@]+(?::[^\s/@]*)?@[^\s]+/gi, '[redacted MQTT URL]');
}

function getSensitiveValues(payload, config) {
  const values = [
    payload?.authToken,
    payload?.cloudToken,
    payload?.accessCode,
    payload?.password,
    payload?.token,
    config?.options?.password,
  ];

  return [...new Set(values
    .map((value) => String(value || ''))
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function sanitizeMessage(error, payload, config) {
  let message = String(error?.message || error || '').trim();
  for (const secret of getSensitiveValues(payload, config)) {
    message = message.split(secret).join('[redacted]');
  }
  return redactCredentialUrls(message);
}

function createPublicError(prefix) {
  return new Error(prefix);
}

function createMqttConnectionManager({
  connectImpl,
  buildConnectionOptions,
  emit = () => {},
  logger,
  connectTimeoutMs = MQTT_CONNECT_TIMEOUT_MS,
  reconnectGraceMs = MQTT_RECONNECT_GRACE_MS,
  timers = { setTimeout, clearTimeout },
}) {
  if (typeof connectImpl !== 'function') {
    throw new TypeError('MQTT connection manager requires connectImpl');
  }
  if (typeof buildConnectionOptions !== 'function') {
    throw new TypeError('MQTT connection manager requires buildConnectionOptions');
  }

  const entries = new Map();

  const log = (level, operation, entry) => {
    if (!logger || typeof logger[level] !== 'function') return;
    try {
      logger[level]({
        operation,
        serialNumber: entry?.serialNumber,
      });
    } catch {
      // Diagnostics must not affect connection lifecycle behavior.
    }
  };

  const emitEvent = (event, payload, entry) => {
    try {
      emit(event, payload);
    } catch {
      log('warn', 'mqtt-renderer-event-failed', entry);
    }
  };

  const isCurrent = (entry) => (
    entries.get(entry.serialNumber) === entry && !entry.intentional
  );

  const clearEntryTimer = (entry, property) => {
    const timer = entry[property];
    if (!timer) return;
    timers.clearTimeout(timer);
    entry[property] = null;
  };

  const clearEntryTimers = (entry) => {
    clearEntryTimer(entry, 'connectTimer');
    clearEntryTimer(entry, 'disconnectTimer');
  };

  const closeClient = (entry) => {
    try {
      entry.client.end(true);
    } catch {
      log('warn', 'mqtt-client-close-failed', entry);
    }
  };

  const rejectPending = (entry, error) => {
    if (entry.readySettled) return;
    entry.readySettled = true;
    entry.rejectReady(error);
  };

  const closeEntry = (entry, reason = 'MQTT connection cancelled') => {
    if (!entry) return;
    entry.intentional = true;
    entry.connected = false;
    clearEntryTimers(entry);
    if (entries.get(entry.serialNumber) === entry) {
      entries.delete(entry.serialNumber);
    }
    rejectPending(entry, new Error(reason));
    closeClient(entry);
  };

  const failInitialConnection = (entry, error) => {
    if (entry.readySettled || !isCurrent(entry)) return;
    entry.intentional = true;
    entry.connected = false;
    clearEntryTimers(entry);
    entries.delete(entry.serialNumber);
    entry.readySettled = true;
    closeClient(entry);
    entry.rejectReady(error);
  };

  const resolveInitialConnection = (entry) => {
    if (entry.readySettled || !isCurrent(entry)) return;
    clearEntryTimer(entry, 'connectTimer');
    entry.readySettled = true;
    entry.resolveReady();
  };

  const scheduleDisconnectGrace = (entry) => {
    if (entry.disconnectTimer || !isCurrent(entry)) return;
    entry.disconnectTimer = timers.setTimeout(() => {
      entry.disconnectTimer = null;
      if (!isCurrent(entry) || entry.connected) return;
      emitEvent('disconnected', { serialNumber: entry.serialNumber }, entry);
    }, reconnectGraceMs);
    if (typeof entry.disconnectTimer?.unref === 'function') {
      entry.disconnectTimer.unref();
    }
  };

  const markReconnecting = (entry) => {
    if (!isCurrent(entry)) return;
    entry.connected = false;
    emitEvent('reconnecting', { serialNumber: entry.serialNumber }, entry);
    scheduleDisconnectGrace(entry);
  };

  const subscribeAndRequestTelemetry = (entry) => {
    const reportTopic = `device/${entry.serialNumber}/report`;
    try {
      entry.client.subscribe(reportTopic, (error) => {
        if (!isCurrent(entry)) return;
        if (error) {
          if (!entry.readySettled) {
            failInitialConnection(entry, createPublicError('MQTT subscription failed'));
          } else {
            log('warn', 'mqtt-subscribe-failed', entry);
          }
          return;
        }

        try {
          entry.client.publish(`device/${entry.serialNumber}/request`, PUSH_ALL_PAYLOAD);
        } catch {
          log('warn', 'mqtt-pushall-failed', entry);
        }
        resolveInitialConnection(entry);
      });
    } catch {
      if (!entry.readySettled) {
        failInitialConnection(entry, createPublicError('MQTT subscription failed'));
      } else {
        log('warn', 'mqtt-subscribe-failed', entry);
      }
    }
  };

  const attachClientListeners = (entry) => {
    entry.client.on('connect', () => {
      if (!isCurrent(entry)) return;
      entry.connected = true;
      clearEntryTimer(entry, 'disconnectTimer');
      emitEvent('connected', { serialNumber: entry.serialNumber }, entry);
      subscribeAndRequestTelemetry(entry);
    });

    entry.client.on('message', (_topic, message) => {
      if (!isCurrent(entry)) return;
      try {
        const payload = JSON.parse(message.toString());
        emitEvent('message', { serialNumber: entry.serialNumber, payload }, entry);
      } catch {
        // Ignore malformed telemetry packets.
      }
    });

    entry.client.on('reconnect', () => markReconnecting(entry));
    entry.client.on('offline', () => markReconnecting(entry));
    entry.client.on('close', () => markReconnecting(entry));

    entry.client.on('error', () => {
      if (!isCurrent(entry)) return;
      if (!entry.readySettled) {
        failInitialConnection(entry, createPublicError('MQTT connection failed'));
      } else {
        log('warn', 'mqtt-client-error', entry);
      }
    });
  };

  const connect = async (payload = {}) => {
    let config;
    try {
      config = buildConnectionOptions(payload);
    } catch (error) {
      throw new Error(sanitizeMessage(error, payload));
    }

    const serialNumber = String(config?.serialNumber || '').trim();
    if (!serialNumber) {
      throw new Error('MQTT connection requires a serial number');
    }

    const fingerprint = createFingerprint(config);
    const existing = entries.get(serialNumber);
    if (existing && !existing.intentional && existing.fingerprint === fingerprint) {
      await existing.readyPromise;
      return { success: true, serialNumber, reused: true };
    }
    if (existing) closeEntry(existing);

    const mqttOptions = {
      username: config.options?.username,
      password: config.options?.password,
      rejectUnauthorized: config.options?.rejectUnauthorized,
      connectTimeout: connectTimeoutMs,
      reconnectPeriod: MQTT_RECONNECT_PERIOD_MS,
      resubscribe: true,
    };

    let client;
    try {
      client = connectImpl(config.url, mqttOptions);
    } catch {
      throw createPublicError('MQTT connection failed');
    }

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const entry = {
      client,
      connected: false,
      connectTimer: null,
      disconnectTimer: null,
      fingerprint,
      intentional: false,
      readyPromise,
      readySettled: false,
      rejectReady,
      resolveReady,
      serialNumber,
    };

    entries.set(serialNumber, entry);
    attachClientListeners(entry);
    entry.connectTimer = timers.setTimeout(() => {
      failInitialConnection(entry, new Error('MQTT connection timeout'));
    }, connectTimeoutMs);
    if (typeof entry.connectTimer?.unref === 'function') {
      entry.connectTimer.unref();
    }
    log('info', 'mqtt-connecting', entry);

    await readyPromise;
    log('info', 'mqtt-connected', entry);
    return { success: true, serialNumber, reused: false };
  };

  const disconnect = async (serialNumber) => {
    closeEntry(entries.get(String(serialNumber || '')));
    return { success: true };
  };

  const shutdown = async () => {
    for (const entry of Array.from(entries.values())) {
      closeEntry(entry);
    }
    return { success: true };
  };

  return {
    connect,
    disconnect,
    shutdown,
    has(serialNumber) {
      return entries.has(String(serialNumber || ''));
    },
    get size() {
      return entries.size;
    },
  };
}

module.exports = {
  createMqttConnectionManager,
};
