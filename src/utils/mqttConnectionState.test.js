import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMqttConnectedState,
  applyMqttDisconnectedState,
  applyMqttReconnectingState,
  isReusableMqttConnectionStatus,
  MQTT_RECONNECT_GRACE_MS,
  MQTT_RECONNECT_PERIOD_MS,
} from './mqttConnectionState.js';

test('keeps live telemetry while marking a printer as reconnecting', () => {
  const printer = {
    dev_id: 'P1SC_SERIAL',
    status: 'printing',
    progress: 42,
    timeLeft: '1h 20m',
    temperature: { nozzle: 240, bed: 70 },
    errorMsg: '',
  };

  const next = applyMqttReconnectingState(printer);

  assert.equal(next.status, 'connecting');
  assert.equal(next.progress, 42);
  assert.equal(next.timeLeft, '1h 20m');
  assert.deepEqual(next.temperature, { nozzle: 240, bed: 70 });
  assert.match(next.errorMsg, /自动重连/);
});

test('clears reconnect copy when MQTT is connected again', () => {
  const next = applyMqttConnectedState({
    status: 'connecting',
    errorMsg: '本地连接中断，正在自动重连...',
  });

  assert.equal(next.status, 'connected');
  assert.equal(next.errorMsg, '');
});

test('marks a printer disconnected only after reconnect grace expires', () => {
  const next = applyMqttDisconnectedState({
    status: 'connecting',
    progress: 19,
    errorMsg: '本地连接中断，正在自动重连...',
  });

  assert.equal(next.status, 'disconnected');
  assert.equal(next.progress, 19);
  assert.match(next.errorMsg, /自动重连失败/);
});

test('uses a nonzero reconnect period and a longer disconnect grace window', () => {
  assert.ok(MQTT_RECONNECT_PERIOD_MS > 0);
  assert.ok(MQTT_RECONNECT_GRACE_MS > MQTT_RECONNECT_PERIOD_MS);
});

test('treats connecting and live statuses as reusable connection attempts', () => {
  assert.equal(isReusableMqttConnectionStatus('connecting'), true);
  assert.equal(isReusableMqttConnectionStatus('connected'), true);
  assert.equal(isReusableMqttConnectionStatus('printing'), true);
  assert.equal(isReusableMqttConnectionStatus('disconnected'), false);
  assert.equal(isReusableMqttConnectionStatus('error'), false);
});
