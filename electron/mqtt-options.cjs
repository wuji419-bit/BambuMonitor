function decodeBase64UrlJson(value) {
  const segment = String(value || '');
  if (!segment) return null;

  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function extractBambuUsername(authToken, fallbackUsername = '') {
  const fallback = String(fallbackUsername || '').trim();
  if (fallback) return fallback;

  const parts = String(authToken || '').split('.');
  if (parts.length !== 3) return '';

  const payload = decodeBase64UrlJson(parts[1]);
  return String(payload?.username || '').trim();
}

function getCloudMqttHost(region = '') {
  return String(region || '').toLowerCase() === 'china'
    ? 'cn.mqtt.bambulab.com'
    : 'us.mqtt.bambulab.com';
}

function buildMqttConnectionOptions(payload = {}) {
  const serialNumber = String(payload.serialNumber || '').trim();
  const mode = String(payload.mode || payload.connectionMode || '').toLowerCase();
  const cloudMode = mode === 'cloud' || payload.cloudMqtt === true;

  if (!serialNumber) {
    throw new Error('缺少打印机序列号');
  }

  if (cloudMode) {
    const authToken = String(payload.authToken || '').trim();
    const username = extractBambuUsername(authToken, payload.username);
    if (!authToken) {
      throw new Error('云端 MQTT 缺少登录令牌');
    }
    if (!username) {
      throw new Error('云端 MQTT 无法识别账号用户名');
    }

    return {
      mode: 'cloud',
      serialNumber,
      url: `mqtts://${getCloudMqttHost(payload.region)}:8883`,
      options: {
        username,
        password: authToken,
        rejectUnauthorized: true,
      },
    };
  }

  const ip = String(payload.ip || '').trim();
  const accessCode = String(payload.accessCode || '').trim();
  if (!ip || !accessCode) {
    throw new Error('本地 MQTT 缺少 IP 或访问码');
  }

  return {
    mode: 'local',
    serialNumber,
    url: `mqtts://${ip}:8883`,
    options: {
      username: 'bblp',
      password: accessCode,
      rejectUnauthorized: false,
    },
  };
}

module.exports = {
  buildMqttConnectionOptions,
  extractBambuUsername,
  getCloudMqttHost,
};
