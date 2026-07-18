import { createHash, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'bambu_session';
const DEFAULT_SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COOKIE_VALUE_LENGTH = 256;
const MAX_RATE_LIMIT = 10_000;
const MAX_RATE_LIMIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RATE_LIMIT_KEYS = 100_000;
const MAX_RATE_LIMIT_KEY_LENGTH = 256;
const REDACTED = '[REDACTED]';
const TRUNCATED = '[Truncated]';
const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_ITEMS = 100;
const MAX_REDACT_STRING = 4_096;

function stableError(message) {
  return new Error(message);
}

function headerValue(req, name) {
  const value = req?.headers?.[name];
  return typeof value === 'string' ? value : null;
}

function validateBodyLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw stableError('Invalid JSON body limit');
  }
}

function precheckContentLength(req, maxBytes) {
  const value = req?.headers?.['content-length'];
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw stableError('Invalid content length');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw stableError('Invalid content length');
  if (length > maxBytes) throw stableError('Request body too large');
}

function decodeJson(chunks) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw stableError('Invalid UTF-8 body');
  }
  if (text.length === 0) throw stableError('Invalid JSON body');
  try {
    return JSON.parse(text);
  } catch {
    throw stableError('Invalid JSON body');
  }
}

function normalizeChunk(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw stableError('Unable to read request body');
}

async function readAsyncIterable(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const rawChunk of req) {
      if (req.aborted === true) throw stableError('Request aborted');
      const chunk = normalizeChunk(rawChunk);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw stableError('Request body too large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error?.message === 'Request body too large' || error?.message === 'Request aborted') throw error;
    if (req.aborted === true || error?.code === 'ABORT_ERR' || error?.code === 'ECONNRESET') {
      throw stableError('Request aborted');
    }
    throw stableError('Unable to read request body');
  }
  if (req.aborted === true) throw stableError('Request aborted');
  return chunks;
}

function readEventStream(req, maxBytes) {
  if (typeof req?.on !== 'function' || typeof req?.removeListener !== 'function') {
    return Promise.reject(stableError('Unable to read request body'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (rawChunk) => {
      try {
        const chunk = normalizeChunk(rawChunk);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          finish(reject, stableError('Request body too large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      } catch {
        finish(reject, stableError('Unable to read request body'));
      }
    };
    const onEnd = () => finish(resolve, chunks);
    const onError = () => finish(reject, stableError('Unable to read request body'));
    const onAborted = () => finish(reject, stableError('Request aborted'));
    const onClose = () => {
      if (!settled) finish(reject, stableError('Request aborted'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

export async function readJsonBody(req, { maxBytes = 65_536 } = {}) {
  validateBodyLimit(maxBytes);
  precheckContentLength(req, maxBytes);
  if (req?.aborted === true) throw stableError('Request aborted');
  const chunks = typeof req?.on === 'function' && typeof req?.removeListener === 'function'
    ? await readEventStream(req, maxBytes)
    : await readAsyncIterable(req, maxBytes);
  return decodeJson(chunks);
}

export function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function validateCookie(value, maxAgeSeconds) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_COOKIE_VALUE_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 2_147_483_647) {
    throw stableError('Invalid session cookie');
  }
}

export function buildSessionCookie(value, {
  secure = false,
  maxAgeSeconds = DEFAULT_SESSION_AGE_SECONDS,
} = {}) {
  validateCookie(value, maxAgeSeconds);
  const attributes = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure === true) attributes.push('Secure');
  attributes.push(`Max-Age=${maxAgeSeconds}`);
  return attributes.join('; ');
}

export function clearSessionCookie({ secure = false } = {}) {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure === true) attributes.push('Secure');
  attributes.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return attributes.join('; ');
}

export function requestIsSecure(req, { trustProxy = false } = {}) {
  if (req?.socket?.encrypted === true) return true;
  if (trustProxy !== true) return false;
  const forwarded = headerValue(req, 'x-forwarded-proto');
  if (forwarded === null) return false;
  const firstHop = forwarded.split(',', 1)[0].trim().toLowerCase();
  return firstHop === 'https';
}

function validHost(host, scheme) {
  if (typeof host !== 'string' || host.length < 1 || host.length > 255
    || /[\s\\/@?#]/.test(host)) return false;
  try {
    const parsed = new URL(`${scheme}://${host}`);
    return parsed.username === '' && parsed.password === '' && parsed.host.length > 0
      && `${parsed.protocol}//${parsed.host}${parsed.pathname}` === `${scheme}://${host}/`;
  } catch {
    return false;
  }
}

function constantTimeEqual(left, right) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function assertMutationRequest(req, { csrfToken, trustProxy = false } = {}) {
  const scheme = requestIsSecure(req, { trustProxy }) ? 'https' : 'http';
  const host = req?.headers?.host;
  if (!validHost(host, scheme)) throw stableError('Invalid request host');

  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || origin === 'null' || origin.length > 512) {
    throw stableError('Invalid request origin');
  }
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password || origin !== `${scheme}://${host}`) {
      throw stableError('Invalid request origin');
    }
  } catch (error) {
    if (error?.message === 'Invalid request origin') throw error;
    throw stableError('Invalid request origin');
  }

  const supplied = req?.headers?.['x-csrf-token'];
  if (typeof csrfToken !== 'string' || csrfToken.length < 1 || csrfToken.length > 1_024
    || typeof supplied !== 'string' || supplied.length < 1 || supplied.length > 1_024
    || !constantTimeEqual(supplied, csrfToken)) {
    throw stableError('Invalid CSRF token');
  }
  return true;
}

function validLimiterInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function createSlidingWindowLimiter({
  limit = 5,
  windowMs = 60_000,
  maxKeys = 1_000,
  now = Date.now,
} = {}) {
  if (!validLimiterInteger(limit, MAX_RATE_LIMIT)
    || !validLimiterInteger(windowMs, MAX_RATE_LIMIT_WINDOW_MS)
    || !validLimiterInteger(maxKeys, MAX_RATE_LIMIT_KEYS) || typeof now !== 'function') {
    throw stableError('Invalid rate limiter configuration');
  }
  const entries = new Map();

  function readTime() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw stableError('Invalid rate limiter time');
    }
    return timestamp;
  }

  function prune(timestamp) {
    for (const [key, timestamps] of entries) {
      const active = timestamps.filter((value) => timestamp - value < windowMs);
      if (active.length === 0) entries.delete(key);
      else if (active.length !== timestamps.length) entries.set(key, active);
    }
  }

  return {
    check(key) {
      if (typeof key !== 'string' || key.length < 1 || key.length > MAX_RATE_LIMIT_KEY_LENGTH) {
        throw stableError('Invalid rate limiter key');
      }
      const timestamp = readTime();
      prune(timestamp);
      let timestamps = entries.get(key);
      if (!timestamps) {
        if (entries.size >= maxKeys) {
          const earliest = Math.min(...[...entries.values()].map((values) => values[0]));
          return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, earliest + windowMs - timestamp) };
        }
        timestamps = [];
        entries.set(key, timestamps);
      }
      if (timestamps.length >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: Math.max(1, timestamps[0] + windowMs - timestamp),
        };
      }
      timestamps.push(timestamp);
      return { allowed: true, remaining: limit - timestamps.length, retryAfterMs: 0 };
    },
    reset(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  const normalized = normalizedKey(key);
  return normalized.includes('password') || normalized === 'code' || normalized.endsWith('code')
    || normalized.includes('token') || normalized.includes('cookie')
    || normalized.includes('authorization') || normalized.includes('apikey')
    || normalized.includes('secret') || normalized.includes('credential');
}

function redactUrl(text) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  try {
    const url = new URL(text);
    const hadUserInfo = url.username !== '' || url.password !== '';
    if (hadUserInfo) {
      url.username = 'redacted';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key)) url.searchParams.set(key, REDACTED);
    }
    const serialized = url.toString();
    return hadUserInfo ? serialized.replace('redacted@', `${REDACTED}@`) : serialized;
  } catch {
    return text.includes('@') ? REDACTED : text;
  }
}

function redactText(value) {
  let text = value.length > MAX_REDACT_STRING
    ? `${value.slice(0, MAX_REDACT_STRING)}${TRUNCATED}`
    : value;
  text = redactUrl(text);
  return text.replace(
    /\b(password|passcode|access[ _-]?code|verification[ _-]?code|token|api[ _-]?key|authorization|cookie|secret)\s*[:=]\s*([^,;&\r\n]+)/gi,
    `$1=${REDACTED}`,
  );
}

function redactValue(value, state, depth) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return '[Undefined]';
  if (typeof value === 'symbol' || typeof value === 'function') return '[Unsupported]';
  if (depth >= MAX_REDACT_DEPTH) return TRUNCATED;
  if (state.seen.has(value)) return '[Circular]';
  state.seen.add(value);

  if (value instanceof Error) {
    const output = Object.create(null);
    output.name = redactText(String(value.name || 'Error').split(/[\r\n]/, 1)[0]);
    output.message = redactText(String(value.message || '').split(/[\r\n]/, 1)[0]);
    for (const key of Object.keys(value).slice(0, MAX_REDACT_ITEMS)) {
      output[key] = isSecretKey(key) ? REDACTED : redactValue(value[key], state, depth + 1);
    }
    return output;
  }
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_REDACT_ITEMS).map((item) => redactValue(item, state, depth + 1));
    if (value.length > MAX_REDACT_ITEMS) output.push(TRUNCATED);
    return output;
  }
  const output = Object.create(null);
  const keys = Object.keys(value).slice(0, MAX_REDACT_ITEMS);
  for (const key of keys) {
    output[key] = isSecretKey(key) ? REDACTED : redactValue(value[key], state, depth + 1);
  }
  if (Object.keys(value).length > MAX_REDACT_ITEMS) output.__truncated__ = TRUNCATED;
  return output;
}

export function redactSecrets(value) {
  return redactValue(value, { seen: new WeakSet() }, 0);
}
