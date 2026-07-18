const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  BAMBU_SEARCH_PACKET,
  GENERIC_SEARCH_PACKET,
  parseBambuDiscoveryMessage,
  scanBambuPrinters,
} = require('./lan-discovery.cjs');

function packet(lines) {
  return Buffer.from([...lines, '', ''].join('\r\n'));
}

function createManualTimers() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();

  const api = {
    setTimeout(callback, delay = 0) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, time: now + Number(delay) });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
  };

  function advanceTo(targetTime) {
    while (true) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.time <= targetTime)
        .sort((left, right) => left[1].time - right[1].time || left[0] - right[0])[0];
      if (!due) break;

      const [id, task] = due;
      tasks.delete(id);
      now = task.time;
      task.callback();
    }
    now = targetTime;
  }

  return {
    api,
    advanceTo,
    pendingCount: () => tasks.size,
  };
}

class FakeSocket extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.bindCalls = [];
    this.sendCalls = [];
    this.broadcastValues = [];
    this.closeCount = 0;
    this.sendError = null;
  }

  bind(...args) {
    this.bindCalls.push(args);
    const callback = args.at(-1);
    if (typeof callback === 'function') callback();
  }

  setBroadcast(value) {
    this.broadcastValues.push(value);
  }

  send(...args) {
    if (this.sendError) throw this.sendError;
    this.sendCalls.push(args);
  }

  close() {
    this.closeCount += 1;
  }
}

function createDgramHarness() {
  const listenSocket = new FakeSocket('listen');
  const searchSocket = new FakeSocket('search');
  const createCalls = [];
  const sockets = [listenSocket, searchSocket];
  return {
    listenSocket,
    searchSocket,
    createCalls,
    dgramImpl: {
      createSocket(options) {
        createCalls.push(options);
        return sockets.shift();
      },
    },
  };
}

test('parseBambuDiscoveryMessage parses serial, IP, name, and mapped model', () => {
  const message = packet([
    'HTTP/1.1 200 OK',
    'USN: uuid:01P00ABC::urn:bambulab-com:device:3dprinter:1',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Workshop P1S',
  ]);

  assert.deepEqual(parseBambuDiscoveryMessage(message, { address: '192.168.1.50' }), {
    ip: '192.168.1.50',
    name: 'Workshop P1S',
    model: 'P1S',
    serial: '01P00ABC',
  });
});

test('parser supports USN token and Bambu serial header fallbacks', () => {
  const cases = [
    {
      label: 'USN token',
      line: 'USN: 01TOKEN_ABC::urn:bambulab-com:device:3dprinter:1',
      serial: '01TOKEN_ABC',
    },
    {
      label: 'DevSerialNumber',
      line: 'DevSerialNumber.bambu.com: 01DEV_SERIAL',
      serial: '01DEV_SERIAL',
    },
    {
      label: 'SerialNumber',
      line: 'SerialNumber.bambu.com: 01SERIAL_FALLBACK',
      serial: '01SERIAL_FALLBACK',
    },
  ];

  for (const entry of cases) {
    const message = packet([
      'HTTP/1.1 200 OK',
      'ST: urn:bambulab-com:device:3dprinter:1',
      entry.line,
      'DevName.bambu.com: Test Printer',
    ]);
    assert.equal(
      parseBambuDiscoveryMessage(message, { address: '192.168.1.60' }).serial,
      entry.serial,
      entry.label,
    );
  }
});

test('parser ignores M-SEARCH packets and unrelated SSDP responses', () => {
  const search = packet([
    'M-SEARCH * HTTP/1.1',
    'ST: urn:bambulab-com:device:3dprinter:1',
  ]);
  const unrelated = packet([
    'HTTP/1.1 200 OK',
    'USN: uuid:unrelated-device::urn:schemas-upnp-org:device:MediaServer:1',
    'ST: urn:schemas-upnp-org:device:MediaServer:1',
  ]);

  assert.equal(parseBambuDiscoveryMessage(search, { address: '192.168.1.2' }), null);
  assert.equal(parseBambuDiscoveryMessage(unrelated, { address: '192.168.1.3' }), null);
});

test('parser preserves every existing Bambu model mapping', () => {
  const mappings = {
    C12: 'P1S',
    C11: 'P1P',
    '3DPrinter-X1-Carbon': 'X1 Carbon',
    '3DPrinter-X1': 'X1',
    N2S: 'A1',
    N1: 'A1 Mini',
    O1D: 'H2D',
    O1: 'H2',
    'BL-P001': 'P1P',
    'BL-P002': 'P1S',
    'BL-A001': 'A1',
  };

  for (const [modelCode, modelName] of Object.entries(mappings)) {
    const message = packet([
      'HTTP/1.1 200 OK',
      'ST: urn:bambulab-com:device:3dprinter:1',
      `DevModel.bambu.com: ${modelCode}`,
    ]);
    assert.equal(
      parseBambuDiscoveryMessage(message, { address: '192.168.1.70' }).model,
      modelName,
      modelCode,
    );
  }
});

test('scan sends four rounds, deduplicates by serial then IP, and closes both sockets', async () => {
  const timers = createManualTimers();
  const harness = createDgramHarness();
  const logEntries = [];
  const scanPromise = scanBambuPrinters({
    dgramImpl: harness.dgramImpl,
    durationMs: 6000,
    timers: timers.api,
    logger: { info: (entry) => logEntries.push(entry) },
  });

  assert.deepEqual(harness.createCalls, [{ type: 'udp4', reuseAddr: true }, 'udp4']);
  assert.equal(harness.listenSocket.bindCalls[0][0], 2021);
  assert.deepEqual(harness.searchSocket.broadcastValues, [true]);
  assert.equal(harness.searchSocket.sendCalls.length, 6);

  timers.advanceTo(1499);
  assert.equal(harness.searchSocket.sendCalls.length, 6);
  timers.advanceTo(1500);
  assert.equal(harness.searchSocket.sendCalls.length, 12);
  timers.advanceTo(3000);
  assert.equal(harness.searchSocket.sendCalls.length, 18);
  timers.advanceTo(4500);
  assert.equal(harness.searchSocket.sendCalls.length, 24);

  const sentPorts = harness.searchSocket.sendCalls.map((call) => call[3]);
  assert.deepEqual(sentPorts.slice(0, 6), [1900, 1900, 2021, 2021, 1990, 1990]);
  assert.equal(harness.searchSocket.sendCalls[0][0].toString(), BAMBU_SEARCH_PACKET.toString());
  assert.equal(harness.searchSocket.sendCalls[1][0].toString(), GENERIC_SEARCH_PACKET.toString());

  harness.listenSocket.emit('message', packet([
    'HTTP/1.1 200 OK',
    'USN: uuid:SERIAL-A::urn:bambulab-com:device:3dprinter:1',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: First Address',
  ]), { address: '192.168.1.10' });
  harness.searchSocket.emit('message', packet([
    'HTTP/1.1 200 OK',
    'USN: uuid:SERIAL-A::urn:bambulab-com:device:3dprinter:1',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Updated Address',
  ]), { address: '192.168.1.11' });
  harness.listenSocket.emit('message', packet([
    'HTTP/1.1 200 OK',
    'DevModel.bambu.com: N2S',
    'DevName.bambu.com: First Name',
  ]), { address: '192.168.1.20' });
  harness.searchSocket.emit('message', packet([
    'HTTP/1.1 200 OK',
    'DevModel.bambu.com: N2S',
    'DevName.bambu.com: Updated Name',
  ]), { address: '192.168.1.20' });

  timers.advanceTo(6000);
  assert.deepEqual(await scanPromise, [
    {
      ip: '192.168.1.11',
      name: 'Updated Address',
      model: 'P1S',
      serial: 'SERIAL-A',
    },
    {
      ip: '192.168.1.20',
      name: 'Updated Name',
      model: 'A1',
      serial: '',
    },
  ]);
  assert.equal(harness.listenSocket.closeCount, 1);
  assert.equal(harness.searchSocket.closeCount, 1);
  assert.equal(timers.pendingCount(), 0);
  assert.ok(logEntries.some((entry) => entry.deviceCount === 2));
});

test('scan closes both sockets and rejects when aborted', async () => {
  const timers = createManualTimers();
  const harness = createDgramHarness();
  const controller = new AbortController();
  const scanPromise = scanBambuPrinters({
    dgramImpl: harness.dgramImpl,
    durationMs: 6000,
    timers: timers.api,
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(scanPromise, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(harness.listenSocket.closeCount, 1);
  assert.equal(harness.searchSocket.closeCount, 1);
  assert.equal(timers.pendingCount(), 0);
});

test('scan closes both sockets and rejects socket errors', async () => {
  const timers = createManualTimers();
  const harness = createDgramHarness();
  const scanPromise = scanBambuPrinters({
    dgramImpl: harness.dgramImpl,
    durationMs: 6000,
    timers: timers.api,
  });
  const socketError = new Error('listen failed');

  harness.listenSocket.emit('error', socketError);
  await assert.rejects(scanPromise, (error) => error === socketError);
  assert.equal(harness.listenSocket.closeCount, 1);
  assert.equal(harness.searchSocket.closeCount, 1);
  assert.equal(timers.pendingCount(), 0);
});

test('scan closes both sockets when sending a search packet fails', async () => {
  const timers = createManualTimers();
  const harness = createDgramHarness();
  harness.searchSocket.sendError = new Error('send failed');

  await assert.rejects(
    scanBambuPrinters({
      dgramImpl: harness.dgramImpl,
      durationMs: 6000,
      timers: timers.api,
    }),
    /send failed/,
  );
  assert.equal(harness.listenSocket.closeCount, 1);
  assert.equal(harness.searchSocket.closeCount, 1);
  assert.equal(timers.pendingCount(), 0);
});

test('scan leaves process globals untouched', { concurrency: false }, async () => {
  const timers = createManualTimers();
  const harness = createDgramHarness();
  const listenSentinel = { closeCount: 0, close() { this.closeCount += 1; } };
  const searchSentinel = { closeCount: 0, close() { this.closeCount += 1; } };
  const previousListen = Object.getOwnPropertyDescriptor(globalThis, 'listenSocket');
  const previousSearch = Object.getOwnPropertyDescriptor(globalThis, 'searchSocket');

  Object.defineProperty(globalThis, 'listenSocket', {
    configurable: true,
    writable: true,
    value: listenSentinel,
  });
  Object.defineProperty(globalThis, 'searchSocket', {
    configurable: true,
    writable: true,
    value: searchSentinel,
  });

  try {
    const scanPromise = scanBambuPrinters({
      dgramImpl: harness.dgramImpl,
      durationMs: 1,
      timers: timers.api,
    });
    timers.advanceTo(1);
    await scanPromise;

    assert.equal(globalThis.listenSocket, listenSentinel);
    assert.equal(globalThis.searchSocket, searchSentinel);
    assert.equal(listenSentinel.closeCount, 0);
    assert.equal(searchSentinel.closeCount, 0);
  } finally {
    if (previousListen) {
      Object.defineProperty(globalThis, 'listenSocket', previousListen);
    } else {
      delete globalThis.listenSocket;
    }
    if (previousSearch) {
      Object.defineProperty(globalThis, 'searchSocket', previousSearch);
    } else {
      delete globalThis.searchSocket;
    }
  }
});
