const { extractBambuUsername } = require('../core/bambu-token.cjs');

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
