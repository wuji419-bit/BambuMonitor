const { EventEmitter } = require('events');
const tls = require('tls');

const CHAMBER_IMAGE_PORT = 6000;
const JPEG_END = Buffer.from([0xff, 0xd9]);
const CHAMBER_RECONNECT_MS = 3000;

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

function createChamberFrameParser({ onFrame, onWarn } = {}) {
  let frame = null;
  let payloadSize = 0;
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (frame === null) {
        if (buffer.length < 16) break;
        payloadSize = buffer.readUIntLE(0, 3);
        buffer = buffer.subarray(16);
        frame = Buffer.alloc(0);
      }

      const need = payloadSize - frame.length;
      if (need <= 0) {
        frame = null;
        continue;
      }

      const take = Math.min(need, buffer.length);
      if (take > 0) {
        frame = Buffer.concat([frame, buffer.subarray(0, take)]);
        buffer = buffer.subarray(take);
      }

      if (frame.length < payloadSize) break;

      const completed = frame;
      frame = null;

      if (completed[0] === 0xff && completed[1] === 0xd8 && completed.subarray(-2).equals(JPEG_END)) {
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
  isChamberImageCamera,
};
