import { spawn as nodeSpawn } from 'node:child_process';

import cameraStream from '../electron/camera-stream.cjs';
import { isValidPrinterAddress } from '../src/utils/printerAddress.js';

const {
  ChamberImageStream,
  buildBambuRtspUrl,
  createJpegStreamParser,
  isChamberImageCamera,
} = cameraStream;

const DEFAULT_IDLE_STOP_MS = 30_000;
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const DEFAULT_SHUTDOWN_KILL_MS = 5_000;
const MAX_HTTP_REDIRECTS = 3;
const DEFAULT_MAX_FRAME_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = DEFAULT_MAX_FRAME_BYTES + 64 * 1024;
const NOOP = () => {};

function normalizeSerial(value) {
  return String(value || '').trim().toUpperCase();
}

function text(value) {
  return String(value || '').trim();
}

function safeRandom(random) {
  try {
    const value = Number(random());
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  } catch {
    return 0;
  }
}

function headersFromDevice(device) {
  const headers = {};
  if (device?.headers && typeof device.headers === 'object') {
    for (const [name, value] of Object.entries(device.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
  }
  if (typeof device?.authorization === 'string') headers.Authorization = device.authorization;
  return headers;
}

function hasAuthorization(headers) {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization');
}

function canonicalHeaderEntries(headers) {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value])
    .sort(([leftName, leftValue], [rightName, rightValue]) => (
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    ));
}

function externalConfig(rawUrl, device) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const headers = headersFromDevice(device);
    if ((url.username || url.password) && !hasAuthorization(headers)) {
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    }
    url.username = '';
    url.password = '';
    return { requestUrl: url.toString(), headers };
  } catch {
    return null;
  }
}

function selectConfig(device, serialNumber) {
  const customUrl = text(device?.customUrl) || text(device?.cameraUrl);
  if (customUrl) {
    const external = externalConfig(customUrl, device);
    return {
      serialNumber,
      mode: 'external-http',
      valid: external !== null,
      requestUrl: external?.requestUrl || '',
      headers: external?.headers || {},
      fingerprint: JSON.stringify([
        'external-http',
        external?.requestUrl || '',
        canonicalHeaderEntries(external?.headers || {}),
      ]),
    };
  }

  const explicitMode = text(device?.cameraMode).toLowerCase();
  const mode = explicitMode === 'chamber-image'
    ? 'chamber-image'
    : explicitMode === 'rtsps'
      ? 'rtsps'
      : isChamberImageCamera(device) ? 'chamber-image' : 'rtsps';
  const ip = text(device?.ip ?? device?.host);
  const accessCode = text(device?.accessCode ?? device?.access_code ?? device?.dev_access_code);
  return {
    serialNumber,
    mode,
    valid: isValidPrinterAddress(ip) && accessCode.length > 0,
    ip,
    accessCode,
    fingerprint: JSON.stringify([mode, ip, accessCode]),
  };
}

function ffmpegArgs(config) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp',
    '-i', buildBambuRtspUrl(config),
    '-an', '-vf', 'fps=4,scale=960:-1', '-q:v', '6', '-f', 'image2pipe',
    '-vcodec', 'mjpeg', 'pipe:1',
  ];
}

function remove(emitter, event, listener) {
  emitter?.removeListener?.(event, listener);
}

export function createCameraSourceManager(options = {}) {
  const {
    ChamberImageStreamImpl = ChamberImageStream,
    AbortController: AbortControllerOption,
    AbortControllerImpl = AbortControllerOption ?? globalThis.AbortController,
    fetchImpl = globalThis.fetch,
    ffmpegPath = 'ffmpeg',
    idleStopMs = DEFAULT_IDLE_STOP_MS,
    httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    logger,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    random = Math.random,
    shutdownKillAfterMs = DEFAULT_SHUTDOWN_KILL_MS,
    spawnImpl = nodeSpawn,
    timers = { setTimeout, clearTimeout },
  } = options;
  const entries = new Map();
  const terminatingFfmpeg = new Map();
  let stopped = false;
  let shutdownPromise = null;

  function log(level, event, entry) {
    if (typeof logger?.[level] !== 'function') return;
    try {
      logger[level]('camera-source-manager', event, {
        serialNumber: entry?.serialNumber,
        mode: entry?.mode,
      });
    } catch {
      // Diagnostics are never part of camera ownership.
    }
  }

  function retryDelay(attempt) {
    const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
    const base = Math.min(30_000, 1_000 * (2 ** Math.min(safeAttempt, 20)));
    return Math.min(30_000, base + Math.floor(base * 0.25 * safeRandom(random)));
  }

  function clearTimer(entry, key) {
    if (!entry[key]) return;
    timers.clearTimeout(entry[key]);
    entry[key] = null;
  }

  function clearRetry(entry) {
    clearTimer(entry, 'retryTimer');
  }

  function clearIdle(entry) {
    clearTimer(entry, 'idleTimer');
  }

  function deliver(entry, frame) {
    for (const listener of [...entry.listeners]) {
      try {
        const result = listener(Buffer.from(frame));
        Promise.resolve(result).catch(() => log('warn', 'listener-failed', entry));
      } catch {
        log('warn', 'listener-failed', entry);
      }
    }
  }

  function acceptFrame(entry, source, rawFrame) {
    if (stopped || entry.source !== source) return;
    const frame = Buffer.isBuffer(rawFrame) ? rawFrame : Buffer.from(rawFrame);
    if (frame.length < 4 || frame.length > maxFrameBytes
      || frame[0] !== 0xff || frame[1] !== 0xd8
      || frame[frame.length - 2] !== 0xff || frame[frame.length - 1] !== 0xd9) return;
    entry.latestFrame = Buffer.from(frame);
    entry.retryAttempt = 0;
    clearRetry(entry);
    entry.status = 'streaming';
    deliver(entry, entry.latestFrame);
  }

  function detachSource(entry, source) {
    if (!source) return;
    if (source.type === 'chamber') {
      const { stream, handlers } = source;
      remove(stream, 'frame', handlers.frame);
      remove(stream, 'error', handlers.error);
      remove(stream, 'close', handlers.close);
      stream.on?.('error', NOOP);
    } else if (source.type === 'ffmpeg') {
      const { child, handlers } = source;
      remove(child.stdout, 'data', handlers.data);
      remove(child, 'error', handlers.error);
      remove(child, 'exit', handlers.exit);
      child.on?.('error', NOOP);
      child.stdout?.on?.('error', NOOP);
      child.stderr?.on?.('error', NOOP);
    } else if (source.type === 'http') {
      clearTimer(entry, 'requestTimer');
    }
  }

  function terminateFfmpeg(entry, source) {
    const existing = terminatingFfmpeg.get(source.child);
    if (existing) return existing.promise;

    let resolveTermination;
    const termination = {
      forceTimer: null,
      killSent: false,
      promise: new Promise((resolve) => { resolveTermination = resolve; }),
      settled: false,
    };
    const finish = () => {
      if (termination.settled) return;
      termination.settled = true;
      if (termination.forceTimer) timers.clearTimeout(termination.forceTimer);
      termination.forceTimer = null;
      remove(source.child, 'exit', finish);
      remove(source.child, 'error', finish);
      terminatingFfmpeg.delete(source.child);
      resolveTermination();
    };
    terminatingFfmpeg.set(source.child, termination);
    source.child.on('exit', finish);
    source.child.on('error', finish);
    try {
      source.child.kill('SIGTERM');
    } catch {
      finish();
      return termination.promise;
    }
    if (termination.settled) return termination.promise;
    termination.forceTimer = timers.setTimeout(() => {
      termination.forceTimer = null;
      if (!termination.killSent) {
        termination.killSent = true;
        try {
          source.child.kill('SIGKILL');
        } catch {
          log('warn', 'source-stop-failed', entry);
        }
      }
      finish();
    }, shutdownKillAfterMs);
    termination.forceTimer?.unref?.();
    return termination.promise;
  }

  function stopCurrent(entry) {
    const source = entry.source;
    if (!source) return null;
    entry.source = null;
    detachSource(entry, source);
    if (source.type === 'chamber') {
      try {
        source.stream.stop();
      } catch {
        log('warn', 'source-stop-failed', entry);
      }
    } else if (source.type === 'ffmpeg') {
      void terminateFfmpeg(entry, source);
    } else if (source.type === 'http') {
      try {
        source.controller.abort();
      } catch {
        log('warn', 'source-stop-failed', entry);
      }
    }
    return source;
  }

  function scheduleRetry(entry) {
    if (stopped || entry.refs === 0 || !entry.config.valid || entry.retryTimer) return;
    const delay = retryDelay(entry.retryAttempt);
    entry.retryAttempt += 1;
    entry.status = 'retrying';
    entry.retryTimer = timers.setTimeout(() => {
      entry.retryTimer = null;
      if (!stopped && entry.refs > 0 && entry.config.valid) start(entry);
    }, delay);
    entry.retryTimer?.unref?.();
  }

  function sourceFailed(entry, source, { exited = false } = {}) {
    if (stopped || entry.source !== source) return;
    entry.source = null;
    detachSource(entry, source);
    if (!exited && source.type === 'chamber') {
      try {
        source.stream.stop();
      } catch {
        log('warn', 'source-stop-failed', entry);
      }
    } else if (!exited && source.type === 'ffmpeg') {
      void terminateFfmpeg(entry, source);
    } else if (source.type === 'http') {
      try {
        source.controller.abort();
      } catch {
        log('warn', 'source-stop-failed', entry);
      }
    }
    scheduleRetry(entry);
  }

  function startChamber(entry) {
    let stream;
    try {
      stream = new ChamberImageStreamImpl({
        host: entry.config.ip,
        accessCode: entry.config.accessCode,
      });
    } catch {
      scheduleRetry(entry);
      return;
    }
    const source = { type: 'chamber', stream, handlers: null };
    const handlers = {
      frame: (frame) => acceptFrame(entry, source, frame),
      error: () => sourceFailed(entry, source),
      close: () => sourceFailed(entry, source),
    };
    source.handlers = handlers;
    entry.source = source;
    stream.on('frame', handlers.frame);
    stream.on('error', handlers.error);
    stream.on('close', handlers.close);
    try {
      stream.start();
    } catch {
      sourceFailed(entry, source);
    }
  }

  function startFfmpeg(entry) {
    let child;
    try {
      child = spawnImpl(ffmpegPath, ffmpegArgs(entry.config), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      scheduleRetry(entry);
      return;
    }
    const source = { type: 'ffmpeg', child, handlers: null };
    const parser = createJpegStreamParser({
      maxFrameBytes,
      maxBufferBytes,
      onFrame: (frame) => acceptFrame(entry, source, frame),
      onWarn: () => log('warn', 'frame-dropped', entry),
    });
    const handlers = {
      data: (chunk) => {
        try {
          parser(chunk);
        } catch {
          sourceFailed(entry, source);
        }
      },
      error: () => sourceFailed(entry, source),
      exit: () => sourceFailed(entry, source, { exited: true }),
    };
    source.handlers = handlers;
    entry.source = source;
    child.on('error', handlers.error);
    child.on('exit', handlers.exit);
    child.stdout?.on('data', handlers.data);
    child.stdout?.on('error', NOOP);
    child.stderr?.on('data', NOOP);
    child.stderr?.on('error', NOOP);
  }

  function armHttpTimeout(entry, source) {
    clearTimer(entry, 'requestTimer');
    entry.requestTimer = timers.setTimeout(() => {
      entry.requestTimer = null;
      if (entry.source !== source) return;
      try {
        source.controller.abort();
      } catch {
        log('warn', 'source-stop-failed', entry);
      }
    }, httpTimeoutMs);
    entry.requestTimer?.unref?.();
  }

  function responseProtocol(response) {
    if (!response?.url) return null;
    try {
      return new URL(response.url).protocol;
    } catch {
      return '';
    }
  }

  function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  async function fetchHttpResponse(entry, source) {
    let requestUrl = entry.config.requestUrl;
    const origin = new URL(requestUrl).origin;
    for (let redirects = 0; ; redirects += 1) {
      armHttpTimeout(entry, source);
      const response = await fetchImpl(requestUrl, {
        signal: source.controller.signal,
        redirect: 'manual',
        headers: { ...entry.config.headers },
      });
      if (stopped || entry.source !== source) return null;
      if (!isRedirectStatus(response?.status)) return response;
      if (redirects >= MAX_HTTP_REDIRECTS) throw new Error('Camera redirect limit exceeded');

      const location = response.headers?.get?.('location');
      if (typeof location !== 'string' || location.length === 0) {
        throw new Error('Camera redirect missing location');
      }
      const nextUrl = new URL(location, requestUrl);
      if ((nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:')
        || nextUrl.username || nextUrl.password || nextUrl.origin !== origin) {
        throw new Error('Camera redirect rejected');
      }
      requestUrl = nextUrl.toString();
    }
  }

  async function readHttpBody(entry, source, response, parser) {
    const body = response.body;
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        if (stopped || entry.source !== source) return;
        armHttpTimeout(entry, source);
        parser(chunk);
      }
      return;
    }
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped || entry.source !== source) return;
        armHttpTimeout(entry, source);
        parser(value);
      }
    }
    if (typeof response.arrayBuffer === 'function') {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBufferBytes) throw new Error('Camera response too large');
      parser(bytes);
      return;
    }
    throw new Error('Camera response body unavailable');
  }

  async function runHttp(entry, source) {
    try {
      const response = await fetchHttpResponse(entry, source);
      if (stopped || entry.source !== source) return;
      const protocol = responseProtocol(response);
      if (!response?.ok || (protocol && protocol !== 'http:' && protocol !== 'https:')) {
        throw new Error('Camera request failed');
      }
      const contentType = text(response.headers?.get?.('content-type')).toLowerCase();
      if (!contentType.startsWith('image/jpeg')
        && !contentType.startsWith('multipart/x-mixed-replace')) {
        throw new Error('Unsupported camera response');
      }
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBufferBytes) {
        throw new Error('Camera response too large');
      }
      const parser = createJpegStreamParser({
        maxFrameBytes,
        maxBufferBytes,
        onFrame: (frame) => acceptFrame(entry, source, frame),
        onWarn: () => log('warn', 'frame-dropped', entry),
      });
      await readHttpBody(entry, source, response, parser);
    } catch {
      // Errors are intentionally represented only by sanitized status and retry state.
    } finally {
      if (!stopped && entry.source === source) {
        clearTimer(entry, 'requestTimer');
        sourceFailed(entry, source, { exited: true });
      }
    }
  }

  function startHttp(entry) {
    if (typeof fetchImpl !== 'function' || typeof AbortControllerImpl !== 'function') {
      scheduleRetry(entry);
      return;
    }
    const controller = new AbortControllerImpl();
    const source = { type: 'http', controller };
    entry.source = source;
    void runHttp(entry, source).catch(() => {});
  }

  function start(entry) {
    if (stopped || entry.source || entry.retryTimer || entry.refs === 0) return;
    if (!entry.config.valid) {
      entry.status = 'misconfigured';
      return;
    }
    entry.status = 'starting';
    entry.upstreamStarts += 1;
    if (entry.mode === 'chamber-image') startChamber(entry);
    else if (entry.mode === 'rtsps') startFfmpeg(entry);
    else startHttp(entry);
  }

  function stopForIdle(entry) {
    clearRetry(entry);
    stopCurrent(entry);
    entry.status = entry.config.valid ? 'idle' : 'misconfigured';
  }

  function scheduleIdle(entry) {
    if (stopped || entry.refs !== 0 || entry.idleTimer) return;
    entry.idleTimer = timers.setTimeout(() => {
      entry.idleTimer = null;
      if (!stopped && entry.refs === 0) stopForIdle(entry);
    }, idleStopMs);
    entry.idleTimer?.unref?.();
  }

  function configure(device = {}) {
    if (stopped) return false;
    const serialNumber = normalizeSerial(device.serialNumber ?? device.dev_id ?? device.serial);
    if (!serialNumber) return false;
    const config = selectConfig(device, serialNumber);
    const existing = entries.get(serialNumber);
    if (existing?.fingerprint === config.fingerprint) return false;

    if (!existing) {
      entries.set(serialNumber, {
        serialNumber,
        mode: config.mode,
        config,
        fingerprint: config.fingerprint,
        status: config.valid ? 'idle' : 'misconfigured',
        refs: 0,
        listeners: new Set(),
        source: null,
        latestFrame: null,
        retryAttempt: 0,
        retryTimer: null,
        idleTimer: null,
        requestTimer: null,
        upstreamStarts: 0,
      });
      return true;
    }

    clearRetry(existing);
    clearIdle(existing);
    stopCurrent(existing);
    existing.mode = config.mode;
    existing.config = config;
    existing.fingerprint = config.fingerprint;
    existing.status = config.valid ? 'idle' : 'misconfigured';
    existing.latestFrame = null;
    existing.retryAttempt = 0;
    if (existing.refs > 0) start(existing);
    return true;
  }

  function acquire(serialNumber) {
    if (stopped) return () => {};
    const entry = entries.get(normalizeSerial(serialNumber));
    if (!entry) return () => {};
    clearIdle(entry);
    entry.refs += 1;
    start(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs === 0) scheduleIdle(entry);
    };
  }

  function getLatestFrame(serialNumber) {
    const frame = entries.get(normalizeSerial(serialNumber))?.latestFrame;
    return frame ? Buffer.from(frame) : null;
  }

  function subscribe(serialNumber, listener) {
    if (typeof listener !== 'function') throw new TypeError('Camera listener must be a function');
    if (stopped) return () => {};
    const entry = entries.get(normalizeSerial(serialNumber));
    if (!entry) return () => {};
    // A subscription is also a lease, so API streaming cannot idle-stop underneath its listener.
    const subscription = (frame) => listener(frame);
    entry.listeners.add(subscription);
    const release = acquire(serialNumber);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      entry.listeners.delete(subscription);
      release();
    };
  }

  function inspect() {
    return [...entries.values()].map((entry) => ({
      serialNumber: entry.serialNumber,
      mode: entry.mode,
      status: entry.status,
      refs: entry.refs,
      listeners: entry.listeners.size,
      hasFrame: entry.latestFrame !== null,
      retryAttempt: entry.retryAttempt,
      retryScheduled: entry.retryTimer !== null,
      idleScheduled: entry.idleTimer !== null,
      upstreamStarts: entry.upstreamStarts,
    }));
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopped = true;
    const pending = [...terminatingFfmpeg.values()].map((termination) => termination.promise);
    for (const entry of entries.values()) {
      clearIdle(entry);
      clearRetry(entry);
      clearTimer(entry, 'requestTimer');
      entry.listeners.clear();
      entry.refs = 0;
      entry.latestFrame = null;
      const source = entry.source;
      if (!source) {
        entry.status = 'stopped';
        continue;
      }
      entry.source = null;
      detachSource(entry, source);
      if (source.type === 'ffmpeg') pending.push(terminateFfmpeg(entry, source));
      else if (source.type === 'chamber') {
        try {
          source.stream.stop();
        } catch {
          log('warn', 'source-stop-failed', entry);
        }
      } else {
        try {
          source.controller.abort();
        } catch {
          log('warn', 'source-stop-failed', entry);
        }
      }
      entry.status = 'stopped';
    }
    shutdownPromise = Promise.allSettled([...new Set(pending)]).then(() => inspect());
    return shutdownPromise;
  }

  return {
    configure,
    acquire,
    getLatestFrame,
    subscribe,
    retryDelay,
    inspect,
    shutdown,
  };
}
