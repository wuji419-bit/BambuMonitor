import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { checkHealth } from './healthcheck.js';

function requestHarness({
  statusCode = 200,
  chunks = ['{"status":"ok"}'],
  timeout = false,
  autoEnd = true,
} = {}) {
  const state = { options: null, requestDestroyed: false, responseDestroyed: false };
  const requestImpl = (options, onResponse) => {
    state.options = options;
    const request = new EventEmitter();
    request.setTimeout = (_delay, callback) => { state.timeoutCallback = callback; };
    request.destroy = (error) => {
      state.requestDestroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => {
      if (timeout) {
        queueMicrotask(() => state.timeoutCallback());
        return;
      }
      const response = new EventEmitter();
      response.statusCode = statusCode;
      response.destroy = () => { state.responseDestroyed = true; };
      state.response = response;
      onResponse(response);
      queueMicrotask(() => {
        for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
        if (autoEnd) response.emit('end');
      });
    };
    return request;
  };
  return { requestImpl, state };
}

test('checkHealth accepts only the expected healthy response and closes the connection', async () => {
  const { requestImpl, state } = requestHarness();

  assert.equal(await checkHealth({ port: 3080, host: 'nas.local', timeoutMs: 75, requestImpl }), true);
  assert.deepEqual(state.options, {
    host: 'nas.local',
    port: 3080,
    path: '/healthz',
    method: 'GET',
    agent: false,
    headers: { Connection: 'close', Accept: 'application/json' },
  });
  assert.equal(state.responseDestroyed, true);
});

test('checkHealth rejects a non-200 response', async () => {
  const { requestImpl, state } = requestHarness({ statusCode: 503 });
  await assert.rejects(checkHealth({ port: 3080, requestImpl }), /status/i);
  assert.equal(state.responseDestroyed, true);
});

test('checkHealth rejects malformed JSON', async () => {
  const { requestImpl } = requestHarness({ chunks: ['not-json'] });
  await assert.rejects(checkHealth({ port: 3080, requestImpl }), /payload/i);
});

test('checkHealth bounds response bytes', async () => {
  const { requestImpl, state } = requestHarness({ chunks: [Buffer.alloc(4097, 97)] });
  await assert.rejects(checkHealth({ port: 3080, requestImpl }), /large/i);
  assert.equal(state.requestDestroyed, true);
  assert.equal(state.responseDestroyed, true);
});

test('checkHealth times out and destroys the request', async () => {
  const { requestImpl, state } = requestHarness({ timeout: true });
  await assert.rejects(checkHealth({ port: 3080, timeoutMs: 20, requestImpl }), /timed out/i);
  assert.equal(state.requestDestroyed, true);
});

test('checkHealth wall deadline expires despite slow response activity and remains referenced', async () => {
  let deadline;
  const cleared = [];
  const timers = {
    setTimeout(callback, delay) {
      deadline = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      return deadline;
    },
    clearTimeout(handle) { cleared.push(handle); },
  };
  const { requestImpl, state } = requestHarness({ chunks: ['{'], autoEnd: false });
  const checking = checkHealth({ port: 3080, timeoutMs: 25, requestImpl, timers });
  const observed = checking.then(
    () => ({ value: true }),
    (error) => ({ error }),
  );
  await Promise.resolve();
  state.response.emit('data', Buffer.from(' '));
  assert.equal(deadline.delay, 25);
  assert.equal(deadline.unrefCalled, false);
  deadline.callback();
  const outcome = await Promise.race([
    observed,
    new Promise((resolve) => setImmediate(() => resolve({ pending: true }))),
  ]);
  assert.match(outcome.error?.message ?? '', /timed out/i);
  assert.equal(state.requestDestroyed, true);
  assert.equal(state.responseDestroyed, true);
  assert.deepEqual(cleared, [deadline]);
});
