const test = require('node:test');
const assert = require('node:assert/strict');

const { connectMqttForRenderer } = require('./mqtt-ipc-result.cjs');

test('projects manager success to the exact legacy renderer result shape', async () => {
  const manager = {
    async connect(payload) {
      assert.deepEqual(payload, { serialNumber: 'SERIAL_A' });
      return {
        success: true,
        serialNumber: 'SERIAL_A',
        reused: true,
      };
    },
  };

  const result = await connectMqttForRenderer(manager, { serialNumber: 'SERIAL_A' });

  assert.deepEqual(result, { success: true, serialNumber: 'SERIAL_A' });
  assert.equal('reused' in result, false);
});

test('preserves the existing renderer failure shape when the manager rejects', async () => {
  const logs = [];
  const manager = {
    async connect() {
      throw new Error('MQTT connection failed');
    },
  };

  const result = await connectMqttForRenderer(manager, {}, {
    error: (...args) => logs.push(args),
  });

  assert.deepEqual(result, { success: false, error: 'MQTT connection failed' });
  assert.equal(logs.length, 1);
});
