const { EventEmitter } = require('events');
const tls = require('tls');

const CHAMBER_IMAGE_PORT = 6000;
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CHAMBER_RECONNECT_MS = 3000;
const DEFAULT_MAX_FRAME_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = DEFAULT_MAX_FRAME_BYTES + 64 * 1024;

function buildBambuRtspUrl({ ip, accessCode }) {
  const safeIp = String(ip || '').trim();
  const safeAccessCode = encodeURIComponent(String(accessCode || '').trim());
  if (!safeIp || !safeAccessCode) return '';
  return `rtsps://bblp:${safeAccessCode}@${safeIp}:322/streaming/live/1`;
}

function buildChamberAuthPacket(accessCode) {
  const packet = Buffer.alloc(80, 0);
  packet.writeUInt32LE(0x40, 0);
  packet.writeUInt32LE(0x3000, 4);
  packet.write('bblp', 16, 32, 'ascii');
  packet.write(String(accessCode || ''), 48, 32, 'ascii');
  return packet;
}

function isChamberImageCamera(printer = {}) {
  if (printer.cameraMode === 'chamber-image') return true;
  if (printer.cameraMode === 'rtsps') return false;

  const model = `${printer.name || ''} ${printer.model || ''} ${printer.modelCode || ''}`.toUpperCase();
  if (!model) return false;
  return /A1|P1P|P1S|P1SC|A2L|A2/.test(model);
}

function parserLimits(maxFrameBytes, maxBufferBytes) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 4
    || !Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < maxFrameBytes) {
    throw new TypeError('Invalid camera parser limits');
  }
}

function asBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError('Camera parser chunk must be bytes');
}

function createJpegStreamParser({
  onFrame,
  onWarn,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  parserLimits(maxFrameBytes, maxBufferBytes);
  let buffer = Buffer.alloc(0);

  function warn(message) {
    if (onWarn) onWarn(message);
  }

  function parseAvailable() {
    for (;;) {
      const start = buffer.indexOf(JPEG_START);
      if (start < 0) {
        if (buffer.length > 0) {
          const trailingMarker = buffer[buffer.length - 1] === 0xff;
          buffer = trailingMarker ? Buffer.from([0xff]) : Buffer.alloc(0);
        }
        return;
      }
      if (start > 0) {
        warn('Dropped bytes before JPEG frame');
        buffer = buffer.subarray(start);
      }

      const end = buffer.indexOf(JPEG_END, 2);
      if (end >= 0) {
        const frameLength = end + JPEG_END.length;
        if (frameLength <= maxFrameBytes) {
          if (onFrame) onFrame(Buffer.from(buffer.subarray(0, frameLength)));
        } else {
          warn('JPEG frame exceeds size limit');
        }
        buffer = buffer.subarray(frameLength);
        continue;
      }

      if (buffer.length >= maxFrameBytes) {
        warn('JPEG frame exceeds size limit');
        const nextStart = buffer.indexOf(JPEG_START, 2);
        if (nextStart >= 0) buffer = buffer.subarray(nextStart);
        else buffer = buffer[buffer.length - 1] === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0);
        continue;
      }
      return;
    }
  }

  return (rawChunk) => {
    const chunk = asBuffer(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const capacity = maxBufferBytes - buffer.length;
      if (capacity <= 0) {
        warn('Camera byte buffer exceeds size limit');
        buffer = buffer[buffer.length - 1] === 0xff ? Buffer.from([0xff]) : Buffer.alloc(0);
        continue;
      }
      const take = Math.min(capacity, chunk.length - offset);
      const part = chunk.subarray(offset, offset + take);
      buffer = buffer.length === 0 ? Buffer.from(part) : Buffer.concat([buffer, part]);
      offset += take;
      parseAvailable();
    }
  };
}

function createChamberFrameParser({
  onFrame,
  onWarn,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  parserLimits(maxFrameBytes, maxBufferBytes);
  const header = Buffer.alloc(16);
  let headerBytes = 0;
  let frame = null;
  let frameBytes = 0;
  let skipBytes = 0;

  return (rawChunk) => {
    const chunk = asBuffer(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      if (skipBytes > 0) {
        const take = Math.min(skipBytes, chunk.length - offset);
        skipBytes -= take;
        offset += take;
        continue;
      }

      if (frame === null) {
        const take = Math.min(16 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + take);
        headerBytes += take;
        offset += take;
        if (headerBytes < 16) continue;

        const payloadSize = header.readUIntLE(0, 3);
        headerBytes = 0;
        if (payloadSize < 4 || payloadSize > maxFrameBytes) {
          if (onWarn) onWarn('Chamber image frame exceeds size limit');
          skipBytes = payloadSize;
          continue;
        }
        frame = Buffer.allocUnsafe(payloadSize);
        frameBytes = 0;
      }

      const take = Math.min(frame.length - frameBytes, chunk.length - offset);
      chunk.copy(frame, frameBytes, offset, offset + take);
      frameBytes += take;
      offset += take;
      if (frameBytes < frame.length) continue;

      const completed = frame;
      frame = null;
      frameBytes = 0;
      if (completed.subarray(0, 2).equals(JPEG_START) && completed.subarray(-2).equals(JPEG_END)) {
        if (onFrame) onFrame(completed);
      } else if (onWarn) {
        onWarn('JPEG magic bytes missing');
      }
    }
  };
}

class ChamberImageStream extends EventEmitter {
  constructor({ host, accessCode }) {
    super();
    this.host = host;
    this.accessCode = accessCode;
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.frameCount = 0;
    this._socket = null;
    this._reconnectTimer = null;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._connect();
    return this;
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socket) {
      try {
        this._socket.destroy();
      } catch {
        // Ignore cleanup races.
      }
      this._socket = null;
    }
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, CHAMBER_RECONNECT_MS);
  }

  _connect() {
    if (this._stopped) return;

    const parser = createChamberFrameParser({
      onFrame: (frame) => {
        this.lastFrame = frame;
        this.lastFrameAt = Date.now();
        this.frameCount += 1;
        this.emit('frame', frame);
      },
      onWarn: (warning) => this.emit('warn', warning),
    });

    const socket = tls.connect({
      host: this.host,
      port: CHAMBER_IMAGE_PORT,
      rejectUnauthorized: false,
      timeout: 8000,
    }, () => {
      socket.write(buildChamberAuthPacket(this.accessCode));
      this.emit('connect');
    });

    this._socket = socket;
    socket.on('data', parser);
    socket.on('error', (error) => {
      this.emit('error', error);
      try {
        socket.destroy();
      } catch {
        // Ignore cleanup races.
      }
      this._scheduleReconnect();
    });
    socket.on('timeout', () => {
      try {
        socket.destroy();
      } catch {
        // Ignore cleanup races.
      }
      this._scheduleReconnect();
    });
    socket.on('close', () => {
      if (!this._stopped) this._scheduleReconnect();
    });
  }
}

module.exports = {
  CHAMBER_IMAGE_PORT,
  ChamberImageStream,
  buildBambuRtspUrl,
  buildChamberAuthPacket,
  createChamberFrameParser,
  createJpegStreamParser,
  isChamberImageCamera,
};
