const dgram = require('node:dgram');
const nodeTimers = require('node:timers');

const BAMBU_SEARCH_PACKET = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\n'
  + 'HOST: 239.255.255.250:1900\r\n'
  + 'MAN: "ssdp:discover"\r\n'
  + 'MX: 3\r\n'
  + 'ST: urn:bambulab-com:device:3dprinter:1\r\n'
  + '\r\n',
);

const GENERIC_SEARCH_PACKET = Buffer.from(
  'M-SEARCH * HTTP/1.1\r\n'
  + 'HOST: 239.255.255.250:1900\r\n'
  + 'MAN: "ssdp:discover"\r\n'
  + 'MX: 3\r\n'
  + 'ST: ssdp:all\r\n'
  + '\r\n',
);

const MODEL_NAMES = Object.freeze({
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
});

const SEARCH_TARGETS = Object.freeze([
  Object.freeze({ port: 1900, address: '239.255.255.250' }),
  Object.freeze({ port: 2021, address: '255.255.255.255' }),
  Object.freeze({ port: 1990, address: '255.255.255.255' }),
]);

function parseBambuDiscoveryMessage(msg, rinfo = {}) {
  const message = Buffer.isBuffer(msg) ? msg.toString() : String(msg || '');
  if (/M-SEARCH/i.test(message)) return null;

  const hasBambuUrn = /urn:bambulab-com:device:3dprinter/i.test(message);
  const hasBambuHeader = /(?:DevModel|DevName|DevSerialNumber|SerialNumber)\.bambu\.com\s*:/i
    .test(message);
  if (!hasBambuUrn && !hasBambuHeader) return null;

  const printer = {
    ip: String(rinfo.address || '').trim(),
    name: 'Bambu Printer',
    model: 'Unknown',
    serial: '',
  };

  const usnLineMatch = message.match(/^USN:\s*([^\r\n]+)/im);
  if (usnLineMatch) {
    const usnValue = usnLineMatch[1].trim();
    const uuidMatch = usnValue.match(/uuid:([^:\s]+)(?:::|$)/i);
    const tokenMatch = usnValue.match(/^([A-Za-z0-9_-]+)/);
    printer.serial = (uuidMatch?.[1] || tokenMatch?.[1] || '').trim();
  }

  if (!printer.serial) {
    const serialFieldMatch = message.match(
      /(?:DevSerialNumber|SerialNumber)\.bambu\.com:\s*([^\r\n]+)/i,
    );
    if (serialFieldMatch) {
      printer.serial = serialFieldMatch[1].trim();
    }
  }

  const modelMatch = message.match(/DevModel\.bambu\.com:\s*([^\r\n]+)/i);
  if (modelMatch) {
    const modelCode = modelMatch[1].trim();
    printer.model = MODEL_NAMES[modelCode] || modelCode;
  }

  const nameMatch = message.match(/DevName\.bambu\.com:\s*([^\r\n]+)/i);
  if (nameMatch) {
    printer.name = nameMatch[1].trim();
  }

  return printer.serial || printer.ip ? printer : null;
}

function safelyCloseSocket(socket) {
  if (!socket || typeof socket.close !== 'function') return;
  try {
    socket.close();
  } catch {
    // Closing an unbound or already-closed UDP socket is harmless here.
  }
}

function createAbortError() {
  const error = new Error('Bambu printer scan aborted');
  error.name = 'AbortError';
  return error;
}

function scanBambuPrinters({
  dgramImpl = dgram,
  durationMs = 6000,
  logger,
  signal,
  timers = nodeTimers,
} = {}) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  let listenSocket;
  let searchSocket;
  try {
    listenSocket = dgramImpl.createSocket({ type: 'udp4', reuseAddr: true });
    searchSocket = dgramImpl.createSocket('udp4');
  } catch (error) {
    safelyCloseSocket(listenSocket);
    safelyCloseSocket(searchSocket);
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const foundPrinters = [];
    const timeoutIds = new Set();
    let settled = false;

    const safeLog = (operation, deviceCount) => {
      if (!logger || typeof logger.info !== 'function') return;
      const entry = { operation };
      if (typeof deviceCount === 'number') entry.deviceCount = deviceCount;
      try {
        logger.info(entry);
      } catch {
        // Diagnostics must not affect socket ownership.
      }
    };

    const clearScheduledWork = () => {
      for (const timeoutId of timeoutIds) {
        timers.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };

    const removeSocketListeners = () => {
      if (typeof listenSocket?.removeListener === 'function') {
        listenSocket.removeListener('message', onMessage);
        listenSocket.removeListener('error', onSocketError);
      }
      if (typeof searchSocket?.removeListener === 'function') {
        searchSocket.removeListener('message', onMessage);
        searchSocket.removeListener('error', onSocketError);
      }
    };

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearScheduledWork();
      signal?.removeEventListener?.('abort', onAbort);
      removeSocketListeners();
      safelyCloseSocket(listenSocket);
      safelyCloseSocket(searchSocket);

      if (error) {
        safeLog('bambu-lan.scan-failed');
        reject(error);
        return;
      }

      safeLog('bambu-lan.scan-complete', foundPrinters.length);
      resolve(foundPrinters.slice());
    };

    const schedule = (callback, delay) => {
      if (settled) return null;

      let timeoutId;
      timeoutId = timers.setTimeout(() => {
        timeoutIds.delete(timeoutId);
        callback();
      }, delay);
      timeoutIds.add(timeoutId);
      return timeoutId;
    };

    const upsertPrinter = (printer) => {
      let existingIndex = printer.serial
        ? foundPrinters.findIndex((candidate) => candidate.serial === printer.serial)
        : -1;
      if (existingIndex < 0 && printer.ip) {
        existingIndex = foundPrinters.findIndex((candidate) => candidate.ip === printer.ip);
      }

      if (existingIndex < 0) {
        foundPrinters.push(printer);
      } else {
        foundPrinters[existingIndex] = printer;
      }
    };

    function onMessage(message, rinfo) {
      if (settled) return;
      try {
        const printer = parseBambuDiscoveryMessage(message, rinfo);
        if (printer) upsertPrinter(printer);
      } catch (error) {
        finish(error);
      }
    }

    function onSocketError(error) {
      finish(error);
    }

    function onAbort() {
      finish(createAbortError());
    }

    const sendSearchRequests = () => {
      for (const target of SEARCH_TARGETS) {
        searchSocket.send(
          BAMBU_SEARCH_PACKET,
          0,
          BAMBU_SEARCH_PACKET.length,
          target.port,
          target.address,
        );
        searchSocket.send(
          GENERIC_SEARCH_PACKET,
          0,
          GENERIC_SEARCH_PACKET.length,
          target.port,
          target.address,
        );
      }
    };

    const runSearchRound = () => {
      if (settled) return;
      try {
        sendSearchRequests();
      } catch (error) {
        finish(error);
      }
    };

    try {
      listenSocket.on('message', onMessage);
      listenSocket.on('error', onSocketError);
      searchSocket.on('message', onMessage);
      searchSocket.on('error', onSocketError);
      signal?.addEventListener?.('abort', onAbort, { once: true });

      if (signal?.aborted) {
        finish(createAbortError());
        return;
      }

      schedule(() => finish(), durationMs);
      listenSocket.bind(2021);
      searchSocket.bind(() => {
        if (settled) return;
        try {
          searchSocket.setBroadcast(true);
          runSearchRound();
          schedule(runSearchRound, 1500);
          schedule(runSearchRound, 3000);
          schedule(runSearchRound, 4500);
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

module.exports = {
  BAMBU_SEARCH_PACKET,
  GENERIC_SEARCH_PACKET,
  parseBambuDiscoveryMessage,
  scanBambuPrinters,
};
