import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import cameraStream from '../electron/camera-stream.cjs';
import { createCameraSourceManager } from './camera-source-manager.js';

const { createChamberFrameParser, createJpegStreamParser } = cameraStream;

class FakeChamberStream extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.startCalls = 0;
    this.stopCalls = 0;
    FakeChamberStream.instances.push(this);
  }

  start() {
    this.startCalls += 1;
    return this;
  }

  stop() {
    this.stopCalls += 1;
  }
}

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(callback, delay) {
      const handle = { id: nextId++ };
      scheduled.set(handle.id, { callback, delay, handle });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) scheduled.delete(handle.id);
    },
    count(delay) {
      return [...scheduled.values()].filter((timer) => delay === undefined || timer.delay === delay).length;
    },
    runOne(delay) {
      const timer = [...scheduled.values()].find((candidate) => candidate.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      scheduled.delete(timer.handle.id);
      timer.callback();
    },
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal);
    return true;
  }
}

function createSpawnHarness() {
  const calls = [];
  return {
    calls,
    spawnImpl(command, args, options) {
      const child = new FakeChild();
      calls.push({ command, args, options, child });
      return child;
    },
  };
}

function byteStream(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function response(chunks, { contentType = 'image/jpeg', url = 'http://camera.local/live' } = {}) {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return contentType;
        return null;
      },
    },
    body: byteStream(chunks),
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('bounded JPEG stream parser handles split markers and recovers after oversized data', () => {
  const frames = [];
  const warnings = [];
  const parser = createJpegStreamParser({
    maxFrameBytes: 8,
    maxBufferBytes: 12,
    onFrame: (frame) => frames.push(frame),
    onWarn: (warning) => warnings.push(warning),
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

  parser(Buffer.from([0x00, 0x01, 0xff]));
  parser(Buffer.from([0xd8, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15]));
  parser(Buffer.from([0x16, 0x17, 0x18]));
  parser(jpeg.subarray(0, 1));
  parser(jpeg.subarray(1));

  assert.deepEqual(frames, [jpeg]);
  assert.equal(warnings.length > 0, true);
});

test('chamber parser skips oversized declared payload and parses the following frame', () => {
  const frames = [];
  const warnings = [];
  const parser = createChamberFrameParser({
    maxFrameBytes: 8,
    maxBufferBytes: 24,
    onFrame: (frame) => frames.push(frame),
    onWarn: (warning) => warnings.push(warning),
  });
  const oversizedHeader = Buffer.alloc(16);
  oversizedHeader.writeUIntLE(10, 0, 3);
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const validHeader = Buffer.alloc(16);
  validHeader.writeUIntLE(jpeg.length, 0, 3);

  parser(oversizedHeader);
  assert.equal(warnings.length, 1);
  parser(Buffer.concat([Buffer.alloc(10, 1), validHeader, jpeg]));

  assert.deepEqual(frames, [jpeg]);
  assert.equal(warnings.length, 1);
});

function createManager(overrides = {}) {
  FakeChamberStream.instances = [];
  return createCameraSourceManager({
    ChamberImageStreamImpl: FakeChamberStream,
    random: () => 0,
    ...overrides,
  });
}

test('twenty consumers share one chamber-image upstream per normalized serial', () => {
  const manager = createManager();
  manager.configure({
    serialNumber: ' serial_a ',
    model: 'P1S',
    ip: '192.168.1.20',
    accessCode: 'camera-secret',
  });

  const releases = Array.from({ length: 20 }, (_, index) => (
    manager.acquire(index % 2 === 0 ? 'SERIAL_A' : ' serial_a ')
  ));

  assert.equal(FakeChamberStream.instances.length, 1);
  assert.equal(FakeChamberStream.instances[0].startCalls, 1);
  assert.equal(manager.inspect()[0].refs, 20);
  releases.forEach((release) => release());
});

test('subscriptions hold references and the idle stop is canceled by reacquire', () => {
  const timers = createManualTimers();
  const manager = createManager({ timers });
  manager.configure({
    serialNumber: 'SERIAL_A',
    model: 'P1S',
    ip: '192.168.1.20',
    accessCode: 'camera-secret',
  });
  const firstFrames = [];
  const secondFrames = [];

  const unsubscribeFirst = manager.subscribe('SERIAL_A', (frame) => firstFrames.push(frame));
  const unsubscribeSecond = manager.subscribe('SERIAL_A', (frame) => secondFrames.push(frame));
  const stream = FakeChamberStream.instances[0];
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  stream.emit('frame', jpeg);

  assert.equal(stream.startCalls, 1);
  assert.deepEqual(firstFrames, [jpeg]);
  assert.deepEqual(secondFrames, [jpeg]);
  unsubscribeFirst();
  unsubscribeFirst();
  assert.equal(timers.count(30_000), 0);
  unsubscribeSecond();
  assert.equal(timers.count(30_000), 1);

  const release = manager.acquire('SERIAL_A');
  assert.equal(timers.count(30_000), 0);
  assert.equal(stream.startCalls, 1);
  release();
  timers.runOne(30_000);
  assert.equal(stream.stopCalls, 1);
});

test('selects sources, reports safe misconfiguration, and applies bounded backoff', () => {
  let fetchCalls = 0;
  const manager = createManager({ fetchImpl: () => { fetchCalls += 1; } });
  manager.configure({ serialNumber: 'A1', model: 'A1 mini', ip: '192.168.1.1', accessCode: 'a' });
  manager.configure({ serialNumber: 'A2', model: 'A2', ip: '192.168.1.2', accessCode: 'b' });
  manager.configure({ serialNumber: 'X1', model: 'X1 Carbon', ip: '192.168.1.3', accessCode: 'c' });
  manager.configure({ serialNumber: 'P2', cameraMode: 'rtsps', ip: '192.168.1.4' });
  manager.configure({
    serialNumber: 'EXT',
    model: 'P1S',
    ip: '192.168.1.5',
    accessCode: 'built-in-secret',
    customUrl: 'ftp://user:url-secret@example.test/live',
  });
  manager.configure({
    serialNumber: 'FALLBACK',
    model: 'P1S',
    ip: '192.168.1.6',
    accessCode: 'fallback-secret',
    customUrl: '   ',
    cameraUrl: 'https://camera.example.test/live',
  });

  const records = Object.fromEntries(manager.inspect().map((entry) => [entry.serialNumber, entry]));
  assert.equal(records.A1.mode, 'chamber-image');
  assert.equal(records.A2.mode, 'chamber-image');
  assert.equal(records.X1.mode, 'rtsps');
  assert.equal(records.P2.status, 'misconfigured');
  assert.equal(records.EXT.mode, 'external-http');
  assert.equal(records.EXT.status, 'misconfigured');
  assert.equal(records.FALLBACK.mode, 'external-http');
  const inspection = JSON.stringify(records);
  for (const secret of ['192.168.1.5', 'built-in-secret', 'url-secret', 'ftp://']) {
    assert.equal(inspection.includes(secret), false);
  }
  manager.acquire('EXT');
  assert.equal(fetchCalls, 0);
  assert.deepEqual([0, 1, 2, 3, 8].map(manager.retryDelay), [1000, 2000, 4000, 8000, 30_000]);
});

test('retry jitter never exceeds the hard thirty-second cap', () => {
  const manager = createManager({ random: () => 1 });

  assert.equal(manager.retryDelay(8), 30_000);
});

test('same configuration is a no-op and changed configuration replaces an active source', () => {
  const manager = createManager();
  const device = {
    serialNumber: 'SERIAL_A',
    model: 'P1S',
    ip: '192.168.1.20',
    accessCode: 'first-secret',
  };
  manager.configure(device);
  const release = manager.acquire('SERIAL_A');
  const first = FakeChamberStream.instances[0];

  assert.equal(manager.configure({ ...device }), false);
  assert.equal(FakeChamberStream.instances.length, 1);
  assert.equal(first.stopCalls, 0);

  assert.equal(manager.configure({ ...device, accessCode: 'second-secret' }), true);
  assert.equal(first.stopCalls, 1);
  assert.equal(FakeChamberStream.instances.length, 2);
  assert.equal(FakeChamberStream.instances[1].startCalls, 1);
  release();
});

test('external fingerprint normalizes URLs and privately includes credential-derived auth', async () => {
  const fetchCalls = [];
  const manager = createManager({
    fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return new Promise(() => {});
    },
  });
  manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'http://camera-user:secret-a@camera.local:80/live',
  });
  manager.acquire('HTTP_A');

  assert.equal(manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'http://camera-user:secret-a@camera.local/live',
  }), false);
  assert.equal(fetchCalls.length, 1);

  assert.equal(manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'http://camera-user:secret-b@camera.local/live',
  }), true);
  assert.equal(fetchCalls.length, 2);
  assert.equal(JSON.stringify(manager.inspect()).includes('secret-'), false);
  await manager.shutdown();
});

test('external fingerprint ignores header insertion order and field-name casing', async () => {
  const fetchCalls = [];
  const manager = createManager({
    fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return new Promise(() => {});
    },
  });
  manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'https://camera.local/live',
    headers: {
      'X-Camera-Token': 'camera-value',
      Authorization: 'Bearer private-token',
    },
  });
  manager.acquire('HTTP_A');

  assert.equal(manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'https://camera.local/live',
    headers: {
      authorization: 'Bearer private-token',
      'x-camera-token': 'camera-value',
    },
  }), false);
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.stringify(manager.inspect()).includes('private-token'), false);
  await manager.shutdown();
});

test('listener failures and mutations are isolated and latest frames are defensive copies', async () => {
  const logs = [];
  const manager = createManager({ logger: { warn: (...args) => logs.push(args) } });
  manager.configure({
    serialNumber: 'SERIAL_A', model: 'P1S', ip: '192.168.1.20', accessCode: 'secret',
  });
  const received = [];
  manager.subscribe('SERIAL_A', (frame) => {
    frame[2] = 0x99;
    throw new Error('listener leaked-secret');
  });
  manager.subscribe('SERIAL_A', () => Promise.reject(new Error('async leaked-secret')));
  manager.subscribe('SERIAL_A', (frame) => received.push(frame));
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);

  FakeChamberStream.instances[0].emit('frame', jpeg);
  await flushPromises();

  assert.deepEqual(received, [jpeg]);
  const firstCopy = manager.getLatestFrame('SERIAL_A');
  firstCopy[2] = 0x88;
  assert.deepEqual(manager.getLatestFrame('SERIAL_A'), jpeg);
  assert.equal(JSON.stringify(logs).includes('leaked-secret'), false);
});

test('RTSPS uses exact FFmpeg arguments, parses split JPEGs, and restarts with reset backoff', () => {
  const timers = createManualTimers();
  const spawn = createSpawnHarness();
  const manager = createManager({ spawnImpl: spawn.spawnImpl, timers });
  manager.configure({
    serialNumber: 'SERIAL_X', cameraMode: 'rtsps', ip: '192.168.1.40', accessCode: 'rtsp-secret',
  });
  const frames = [];
  manager.subscribe('SERIAL_X', (frame) => frames.push(frame));

  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, 'ffmpeg');
  assert.deepEqual(spawn.calls[0].args, [
    '-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp',
    '-i', 'rtsps://bblp:rtsp-secret@192.168.1.40:322/streaming/live/1',
    '-an', '-vf', 'fps=4,scale=960:-1', '-q:v', '6', '-f', 'image2pipe',
    '-vcodec', 'mjpeg', 'pipe:1',
  ]);
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  spawn.calls[0].child.stdout.emit('data', jpeg.subarray(0, 1));
  spawn.calls[0].child.stdout.emit('data', jpeg.subarray(1));
  assert.deepEqual(frames, [jpeg]);

  spawn.calls[0].child.emit('exit', 1);
  assert.equal(timers.count(1000), 1);
  timers.runOne(1000);
  assert.equal(spawn.calls.length, 2);
  spawn.calls[1].child.emit('error', new Error('private rtsp-secret'));
  assert.equal(timers.count(2000), 1);
  timers.runOne(2000);
  spawn.calls[2].child.stdout.emit('data', jpeg);
  spawn.calls[2].child.emit('exit', 1);
  assert.equal(timers.count(1000), 1);
});

test('external HTTP strips URL credentials, sends Basic auth, and caches a JPEG snapshot', async () => {
  const fetchCalls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0x20, 0xff, 0xd9]);
  const manager = createManager({
    fetchImpl(url, options) {
      fetchCalls.push({ url, options });
      return Promise.resolve(response([jpeg], { url: String(url) }));
    },
  });
  manager.configure({
    serialNumber: 'HTTP_A',
    customUrl: 'https://camera-user:camera-password@camera.local/snapshot?quality=1',
  });
  const frames = [];
  manager.subscribe('HTTP_A', (frame) => frames.push(frame));

  await flushPromises();

  assert.equal(fetchCalls.length, 1);
  assert.equal(String(fetchCalls[0].url), 'https://camera.local/snapshot?quality=1');
  assert.equal(
    fetchCalls[0].options.headers.Authorization,
    `Basic ${Buffer.from('camera-user:camera-password').toString('base64')}`,
  );
  assert.deepEqual(frames, [jpeg]);
  const publicState = JSON.stringify(manager.inspect());
  assert.equal(publicState.includes('camera-password'), false);
  assert.equal(publicState.includes('camera.local'), false);
});

test('external multipart MJPEG is parsed across chunks and a non-http redirect is rejected', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x30, 0x31, 0xff, 0xd9]);
  const fetchResults = [
    response([
      Buffer.concat([Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n'), jpeg.subarray(0, 3)]),
      Buffer.concat([jpeg.subarray(3), Buffer.from('\r\n--frame--\r\n')]),
    ], { contentType: 'multipart/x-mixed-replace; boundary=frame' }),
    response([jpeg], { url: 'file:///private/camera.jpg' }),
  ];
  const manager = createManager({ fetchImpl: () => Promise.resolve(fetchResults.shift()) });
  manager.configure({ serialNumber: 'HTTP_A', cameraUrl: 'http://camera.local/live' });
  const frames = [];
  const unsubscribe = manager.subscribe('HTTP_A', (frame) => frames.push(frame));
  await flushPromises();
  assert.deepEqual(frames, [jpeg]);

  unsubscribe();
  manager.configure({ serialNumber: 'HTTP_B', customUrl: 'http://camera.local/redirect' });
  manager.subscribe('HTTP_B', () => assert.fail('redirected frame must not be delivered'));
  await flushPromises();
  assert.equal(manager.getLatestFrame('HTTP_B'), null);
});

test('external HTTP aborts a stalled request after eight seconds', async () => {
  const timers = createManualTimers();
  const controllers = [];
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false };
      controllers.push(this);
    }

    abort() {
      this.signal.aborted = true;
    }
  }
  const manager = createManager({
    AbortControllerImpl: FakeAbortController,
    fetchImpl: () => new Promise(() => {}),
    timers,
  });
  manager.configure({ serialNumber: 'HTTP_A', customUrl: 'http://camera.local/stalled' });
  manager.acquire('HTTP_A');

  assert.equal(timers.count(8000), 1);
  timers.runOne(8000);
  assert.equal(controllers[0].signal.aborted, true);
  await manager.shutdown();
});

test('late completion from a replaced HTTP source cannot cancel the current timeout', async () => {
  const timers = createManualTimers();
  let resolveFirst;
  const firstFetch = new Promise((resolve) => { resolveFirst = resolve; });
  const fetchResults = [firstFetch, new Promise(() => {})];
  const manager = createManager({
    fetchImpl: () => fetchResults.shift(),
    timers,
  });
  manager.configure({ serialNumber: 'HTTP_A', customUrl: 'http://camera.local/first' });
  manager.acquire('HTTP_A');
  manager.configure({ serialNumber: 'HTTP_A', customUrl: 'http://camera.local/second' });
  assert.equal(timers.count(8000), 1);

  resolveFirst(response([], { url: 'http://camera.local/first' }));
  await flushPromises();

  assert.equal(timers.count(8000), 1);
  await manager.shutdown();
});

test('shutdown sends SIGTERM, forces SIGKILL after five seconds, and is idempotent', async () => {
  const timers = createManualTimers();
  const spawn = createSpawnHarness();
  const manager = createManager({ spawnImpl: spawn.spawnImpl, timers });
  manager.configure({
    serialNumber: 'SERIAL_X', cameraMode: 'rtsps', ip: '192.168.1.40', accessCode: 'secret',
  });
  manager.acquire('SERIAL_X');
  const child = spawn.calls[0].child;

  const firstShutdown = manager.shutdown();
  const secondShutdown = manager.shutdown();
  assert.equal(firstShutdown, secondShutdown);
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(timers.count(5000), 1);
  timers.runOne(5000);
  await firstShutdown;

  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  child.stdout.emit('data', Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]));
  child.emit('exit', 1);
  assert.equal(timers.count(), 0);
  assert.equal(manager.getLatestFrame('SERIAL_X'), null);
});

test('shutdown does not schedule a force kill after a synchronous graceful FFmpeg exit', async () => {
  const timers = createManualTimers();
  const spawn = createSpawnHarness();
  const manager = createManager({ spawnImpl: spawn.spawnImpl, timers });
  manager.configure({
    serialNumber: 'SERIAL_X', cameraMode: 'rtsps', ip: '192.168.1.40', accessCode: 'secret',
  });
  manager.acquire('SERIAL_X');
  const child = spawn.calls[0].child;
  child.kill = function kill(signal) {
    this.killCalls.push(signal);
    if (signal === 'SIGTERM') this.emit('exit', 0);
    return true;
  };

  await manager.shutdown();

  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(timers.count(), 0);
});
