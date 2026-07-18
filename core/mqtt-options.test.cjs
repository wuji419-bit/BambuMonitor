const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMqttConnectionOptions,
  extractBambuUsername,
  getBambuCloudMqttHost,
  getCloudMqttHost,
} = require('./mqtt-options.cjs');

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

test('builds local MQTT connection options in shared core', () => {
  const config = buildMqttConnectionOptions({
    ip: '192.168.1.25',
    accessCode: '12345678',
    serialNumber: 'LOCAL_SERIAL',
  });

  assert.deepEqual(config, {
    mode: 'local',
    serialNumber: 'LOCAL_SERIAL',
    url: 'mqtts://192.168.1.25:8883',
    options: {
      username: 'bblp',
      password: '12345678',
      rejectUnauthorized: false,
    },
  });
});

test('builds cloud MQTT connection options from the shared token username', () => {
  const authToken = makeJwt({ username: 'u_shared' });

  assert.deepEqual(buildMqttConnectionOptions({
    mode: 'cloud',
    region: 'China',
    authToken,
    serialNumber: 'CLOUD_SERIAL',
  }), {
    mode: 'cloud',
    serialNumber: 'CLOUD_SERIAL',
    url: 'mqtts://cn.mqtt.bambulab.com:8883',
    options: {
      username: 'u_shared',
      password: authToken,
      rejectUnauthorized: true,
    },
  });
});

test('uses the explicit cloud username for opaque tokens', () => {
  const config = buildMqttConnectionOptions({
    mode: 'cloud',
    region: 'Global',
    authToken: 'opaque-token',
    username: 'u_explicit',
    serialNumber: 'CLOUD_SERIAL',
  });

  assert.equal(config.options.username, 'u_explicit');
  assert.equal(config.options.password, 'opaque-token');
});

test('exports token extraction and both cloud host helper names', () => {
  const token = makeJwt({ username: 'u_2468' });

  assert.equal(extractBambuUsername(token), 'u_2468');
  assert.equal(getBambuCloudMqttHost('China'), 'cn.mqtt.bambulab.com');
  assert.equal(getBambuCloudMqttHost('Global'), 'us.mqtt.bambulab.com');
  assert.equal(getCloudMqttHost, getBambuCloudMqttHost);
});

test('rejects incomplete shared MQTT configurations', () => {
  assert.throws(
    () => buildMqttConnectionOptions({ serialNumber: 'LOCAL_SERIAL' }),
    /IP/,
  );
  assert.throws(
    () => buildMqttConnectionOptions({
      mode: 'cloud',
      authToken: 'opaque-token',
      serialNumber: 'CLOUD_SERIAL',
    }),
    /用户名/,
  );
});
