const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMqttConnectionOptions,
  extractBambuUsername,
  getCloudMqttHost,
} = require('./mqtt-options.cjs');

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

test('builds unchanged local MQTT connection options', () => {
  const config = buildMqttConnectionOptions({
    ip: '192.168.199.92',
    accessCode: '12345678',
    serialNumber: 'H2D_SERIAL',
  });

  assert.equal(config.mode, 'local');
  assert.equal(config.serialNumber, 'H2D_SERIAL');
  assert.equal(config.url, 'mqtts://192.168.199.92:8883');
  assert.deepEqual(config.options, {
    username: 'bblp',
    password: '12345678',
    rejectUnauthorized: false,
  });
});

test('builds China cloud MQTT connection options from auth token username', () => {
  const authToken = makeJwt({ username: 'u_123456789' });
  const config = buildMqttConnectionOptions({
    mode: 'cloud',
    region: 'China',
    authToken,
    serialNumber: 'A1_SERIAL',
  });

  assert.equal(config.mode, 'cloud');
  assert.equal(config.url, 'mqtts://cn.mqtt.bambulab.com:8883');
  assert.deepEqual(config.options, {
    username: 'u_123456789',
    password: authToken,
    rejectUnauthorized: true,
  });
});

test('uses explicit username when token cannot be decoded', () => {
  const config = buildMqttConnectionOptions({
    mode: 'cloud',
    region: 'Global',
    authToken: 'opaque-token',
    username: 'u_987654321',
    serialNumber: 'P1S_SERIAL',
  });

  assert.equal(config.url, 'mqtts://us.mqtt.bambulab.com:8883');
  assert.equal(config.options.username, 'u_987654321');
  assert.equal(config.options.password, 'opaque-token');
});

test('rejects cloud MQTT config without a username source', () => {
  assert.throws(
    () => buildMqttConnectionOptions({
      mode: 'cloud',
      authToken: 'opaque-token',
      serialNumber: 'P1S_SERIAL',
    }),
    /账号用户名/,
  );
});

test('extracts Bambu username from JWT payload', () => {
  assert.equal(extractBambuUsername(makeJwt({ username: 'u_2468' })), 'u_2468');
  assert.equal(extractBambuUsername('not-a-jwt'), '');
});

test('maps cloud MQTT host by region', () => {
  assert.equal(getCloudMqttHost('China'), 'cn.mqtt.bambulab.com');
  assert.equal(getCloudMqttHost('Global'), 'us.mqtt.bambulab.com');
});
