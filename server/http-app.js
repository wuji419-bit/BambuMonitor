import { createHash } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

import {
  assertMutationRequest,
  buildSessionCookie,
  clearSessionCookie,
  createSlidingWindowLimiter,
  parseCookies,
  readJsonBody,
  requestIsSecure,
} from './http-security.js';
import { projectPublicDeviceEvent } from './public-device.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const SESSION_COOKIE = 'bambu_session';
const STREAM_BOUNDARY = 'bambuframe';
const READINESS_PUBLIC_CODES = new Map([
  ['storage-unavailable', 'STORAGE_UNAVAILABLE'],
]);
const DEFAULT_LIMITS = Object.freeze({
  bodyBytes: 65_536,
  frameWaitMs: 4_000,
  maxFrameBytes: 8 * 1024 * 1024,
  maxWsEventBytes: 512 * 1024,
  streamsPerCamera: 4,
  streamsGlobal: 20,
  wsPerSession: 5,
  login: Object.freeze({ limit: 5, windowMs: 15 * 60_000, maxKeys: 2_000 }),
  requestCode: Object.freeze({ limit: 3, windowMs: 60_000, maxKeys: 2_000 }),
  frameRate: Object.freeze({ limit: 4, windowMs: 1_000, maxKeys: 10_000 }),
});
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});
const STATIC_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self' ws: wss:; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WRITE_ONLY_VALUE = '[REDACTED]';
const TARGET_FIELDS = Object.freeze(['id', 'name', 'type', 'enabled']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed, { exact = false } = {}) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => DANGEROUS_KEYS.has(key) || !allowed.includes(key))) return false;
  return !exact || keys.length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
}

function apiError(status, code, message) {
  return Object.assign(new Error(message), { apiStatus: status, apiCode: code, safeMessage: message });
}

function sendJson(res, status, payload, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': JSON_TYPE,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendSuccess(res, data, status = 200, headers) {
  sendJson(res, status, { ok: true, data }, headers);
}

function sendFailure(res, status, code, message, headers) {
  sendJson(res, status, { ok: false, error: { code, message } }, headers);
}

function logSafe(logger, level, operation, details = {}) {
  if (typeof logger?.[level] !== 'function') return;
  try {
    logger[level]({ operation, ...details });
  } catch {
    // Diagnostics must never affect request ownership.
  }
}

function contentTypeIsJson(req) {
  const value = req.headers['content-type'];
  return typeof value === 'string' && /^application\/json(?:\s*;|$)/i.test(value);
}

async function jsonBody(req, maxBytes) {
  if (!contentTypeIsJson(req)) throw apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected application/json');
  try {
    return await readJsonBody(req, { maxBytes });
  } catch (error) {
    if (error?.message === 'Request body too large') {
      throw apiError(413, 'BODY_TOO_LARGE', 'Request body too large');
    }
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
}

function effectiveOrigin(req, trustProxy) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length < 1 || host.length > 255 || /[\s\\/@?#]/.test(host)) {
    throw apiError(403, 'FORBIDDEN', 'Request verification failed');
  }
  const protocol = requestIsSecure(req, { trustProxy }) ? 'https' : 'http';
  try {
    const value = new URL(`${protocol}://${host}`);
    if (value.origin !== `${protocol}://${host}` || value.username || value.password) throw new Error('invalid');
    return value.origin;
  } catch {
    throw apiError(403, 'FORBIDDEN', 'Request verification failed');
  }
}

function assertOrigin(req, trustProxy, { optional = false } = {}) {
  const origin = req.headers.origin;
  if (optional && origin === undefined) return;
  if (typeof origin !== 'string' || origin.length > 512 || origin === 'null') {
    throw apiError(403, 'FORBIDDEN', 'Request verification failed');
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw apiError(403, 'FORBIDDEN', 'Request verification failed');
  }
  if (parsed.origin !== origin || parsed.username || parsed.password || origin !== effectiveOrigin(req, trustProxy)) {
    throw apiError(403, 'FORBIDDEN', 'Request verification failed');
  }
}

function remoteAddress(req, trustProxy) {
  let address = req.socket?.remoteAddress;
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') address = forwarded.split(',', 1)[0].trim();
  }
  const normalized = typeof address === 'string' ? address.trim() : '';
  return normalized.length > 0 && normalized.length <= 128 && !/[\s\r\n]/.test(normalized)
    ? normalized
    : 'unknown';
}

function limiterKey(req, account, trustProxy) {
  const normalized = account.trim().toLowerCase().replace(/\s+/g, '');
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${remoteAddress(req, trustProxy)}:${digest}`;
}

function enforceLimit(limiter, key) {
  const result = limiter.check(key);
  if (!result.allowed) {
    throw apiError(429, 'RATE_LIMITED', 'Too many requests');
  }
}

function validateAccount(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 320;
}

function validatePassword(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096;
}

function validateCode(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function maskAccount(account) {
  const value = String(account || '').trim();
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  if (value.length <= 4) return '*'.repeat(Math.max(1, value.length));
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function isMaskedAccount(value) {
  return typeof value === 'string' && value.length <= 512 && (value === '***'
    || /^\d{3}\*{4}\d{4}$/.test(value)
    || /^[\s\S]\*{3}@[\s\S]+$/u.test(value)
    || /^[\s\S]{2}\*{3}[\s\S]{2}$/u.test(value));
}

function decodeSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
  if (!decoded || decoded.length > 256 || decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) {
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
  return decoded;
}

function validateDevicePatch(body) {
  const fields = ['ip', 'name', 'model'];
  if (!hasOnlyKeys(body, fields) || Object.keys(body).length === 0) {
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
}

function validateSettingsPatch(body) {
  if (!hasOnlyKeys(body, ['version', 'camera', 'notifications', 'debug'])) {
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
  if (Object.hasOwn(body, 'version') && !Number.isInteger(body.version)) {
    throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }
  if (Object.hasOwn(body, 'camera')) {
    if (!hasOnlyKeys(body.camera, ['autoOpen', 'customUrls'])) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
    if (Object.hasOwn(body.camera, 'customUrls') && !safeDictionary(body.camera.customUrls)) {
      throw apiError(400, 'BAD_REQUEST', 'Invalid request');
    }
  }
  if (Object.hasOwn(body, 'notifications')) {
    if (!hasOnlyKeys(body.notifications, ['enabled', 'targets'])) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
    if (Object.hasOwn(body.notifications, 'targets')) {
      if (!Array.isArray(body.notifications.targets)) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      for (const target of body.notifications.targets) {
        if (!hasOnlyKeys(target, ['id', 'name', 'type', 'enabled', 'url', 'secret', 'token', 'headers'])) {
          throw apiError(400, 'BAD_REQUEST', 'Invalid request');
        }
        if (Object.hasOwn(target, 'headers') && !safeDictionary(target.headers)) {
          throw apiError(400, 'BAD_REQUEST', 'Invalid request');
        }
      }
    }
  }
}

function safeDictionary(value) {
  return isPlainObject(value) && Object.keys(value).every((key) => !DANGEROUS_KEYS.has(key));
}

function isSensitiveName(value) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('authorization') || normalized.includes('cookie')
    || normalized.includes('apikey') || normalized.includes('token')
    || normalized.includes('secret') || normalized.includes('password')
    || normalized.includes('credential') || normalized.includes('accesscode');
}

function projectOpaque(value) {
  return typeof value === 'string' && value.length === 0 ? '' : WRITE_ONLY_VALUE;
}

function projectCredentialUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveName(name)) url.searchParams.set(name, WRITE_ONLY_VALUE);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function projectHeaders(value) {
  const projected = {};
  if (!safeDictionary(value)) return projected;
  for (const [name, headerValue] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(name) || typeof headerValue !== 'string') continue;
    projected[name] = isSensitiveName(name) ? projectOpaque(headerValue) : headerValue;
  }
  return projected;
}

function projectTarget(value) {
  const projected = {};
  if (!isPlainObject(value)) return projected;
  for (const field of TARGET_FIELDS) {
    if (Object.hasOwn(value, field)) projected[field] = value[field];
  }
  if (Object.hasOwn(value, 'url')) projected.url = projectCredentialUrl(value.url);
  for (const field of ['secret', 'token']) {
    if (Object.hasOwn(value, field)) projected[field] = projectOpaque(value[field]);
  }
  if (Object.hasOwn(value, 'headers')) projected.headers = projectHeaders(value.headers);
  return projected;
}

function projectSettings(value) {
  const projected = {};
  if (!isPlainObject(value)) return projected;
  if (Number.isInteger(value.version)) projected.version = value.version;
  if (isPlainObject(value.camera)) {
    const camera = {};
    if (typeof value.camera.autoOpen === 'boolean') camera.autoOpen = value.camera.autoOpen;
    if (safeDictionary(value.camera.customUrls)) {
      camera.customUrls = {};
      for (const [serial, url] of Object.entries(value.camera.customUrls)) {
        if (!DANGEROUS_KEYS.has(serial)) camera.customUrls[serial] = projectCredentialUrl(url);
      }
    }
    projected.camera = camera;
  }
  if (isPlainObject(value.notifications)) {
    const notifications = {};
    if (typeof value.notifications.enabled === 'boolean') notifications.enabled = value.notifications.enabled;
    if (Array.isArray(value.notifications.targets)) {
      notifications.targets = value.notifications.targets.map(projectTarget);
    }
    projected.notifications = notifications;
  }
  if (typeof value.debug === 'boolean') projected.debug = value.debug;
  return projected;
}

function cloneStoredHeaders(value) {
  const result = {};
  if (!safeDictionary(value)) return result;
  for (const [name, headerValue] of Object.entries(value)) {
    if (!DANGEROUS_KEYS.has(name) && typeof headerValue === 'string') result[name] = headerValue;
  }
  return result;
}

function mergeCredentialHeaders(incoming, stored) {
  const result = {};
  const storedHeaders = cloneStoredHeaders(stored);
  const represented = new Set();
  for (const [name, value] of Object.entries(incoming)) {
    const normalized = name.toLowerCase();
    represented.add(normalized);
    const storedName = Object.keys(storedHeaders).find((candidate) => candidate.toLowerCase() === normalized);
    if (isSensitiveName(name) && storedName
      && value === projectOpaque(storedHeaders[storedName])) {
      result[name] = storedHeaders[storedName];
    } else {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(storedHeaders)) {
    if (isSensitiveName(name) && !represented.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function findStoredTarget(incoming, index, targets, used) {
  if (typeof incoming.id === 'string' && incoming.id.length > 0) {
    const matchedIndex = targets.findIndex((target, candidateIndex) => !used.has(candidateIndex)
      && isPlainObject(target) && target.id === incoming.id);
    if (matchedIndex < 0) return null;
    used.add(matchedIndex);
    return targets[matchedIndex];
  }
  if (index >= targets.length || used.has(index) || !isPlainObject(targets[index])) return null;
  used.add(index);
  return targets[index];
}

function mergeWriteOnlyTarget(incoming, stored) {
  const target = {};
  for (const field of TARGET_FIELDS) {
    if (Object.hasOwn(incoming, field)) target[field] = incoming[field];
  }
  for (const field of ['secret', 'token']) {
    if (Object.hasOwn(incoming, field)) {
      target[field] = stored && Object.hasOwn(stored, field)
        && incoming[field] === projectOpaque(stored[field])
        ? stored[field]
        : incoming[field];
    } else if (stored && Object.hasOwn(stored, field)) {
      target[field] = stored[field];
    }
  }
  if (Object.hasOwn(incoming, 'url')) {
    target.url = stored && Object.hasOwn(stored, 'url')
      && incoming.url === projectCredentialUrl(stored.url)
      ? stored.url
      : incoming.url;
  } else if (stored && Object.hasOwn(stored, 'url')) {
    target.url = stored.url;
  }
  if (Object.hasOwn(incoming, 'headers')) {
    target.headers = mergeCredentialHeaders(incoming.headers, stored?.headers);
  } else if (stored && Object.hasOwn(stored, 'headers')) {
    target.headers = cloneStoredHeaders(stored.headers);
  }
  return target;
}

function prepareSettingsPatch(incoming, storedSettings) {
  const patch = {};
  if (Object.hasOwn(incoming, 'camera')) {
    const camera = {};
    if (Object.hasOwn(incoming.camera, 'autoOpen')) camera.autoOpen = incoming.camera.autoOpen;
    if (Object.hasOwn(incoming.camera, 'customUrls')) {
      camera.customUrls = {};
      const storedUrls = safeDictionary(storedSettings?.camera?.customUrls)
        ? storedSettings.camera.customUrls
        : {};
      for (const [serial, url] of Object.entries(incoming.camera.customUrls)) {
        if (DANGEROUS_KEYS.has(serial)) continue;
        camera.customUrls[serial] = Object.hasOwn(storedUrls, serial)
          && url === projectCredentialUrl(storedUrls[serial])
          ? storedUrls[serial]
          : url;
      }
    }
    patch.camera = camera;
  }
  if (Object.hasOwn(incoming, 'notifications')) {
    const notifications = {};
    if (Object.hasOwn(incoming.notifications, 'enabled')) {
      notifications.enabled = incoming.notifications.enabled;
    }
    if (Object.hasOwn(incoming.notifications, 'targets')) {
      const storedTargets = Array.isArray(storedSettings?.notifications?.targets)
        ? storedSettings.notifications.targets
        : [];
      const used = new Set();
      notifications.targets = incoming.notifications.targets.map((target, index) => (
        mergeWriteOnlyTarget(target, findStoredTarget(target, index, storedTargets, used))
      ));
    }
    patch.notifications = notifications;
  }
  if (Object.hasOwn(incoming, 'debug')) patch.debug = incoming.debug;
  return patch;
}

function normalizeRelease(value) {
  if (typeof value === 'function') return value;
  if (typeof value?.release === 'function') return value.release.bind(value);
  return () => {};
}

function fixedRoot(distDir) {
  if (distDir === null || distDir === undefined) return null;
  try {
    const resolveRealPath = realpathSync.native ?? realpathSync;
    const root = resolveRealPath(path.resolve(distDir));
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
}

function splitTarget(req) {
  const target = typeof req.url === 'string' ? req.url : '';
  const query = target.indexOf('?');
  const rawPath = query < 0 ? target : target.slice(0, query);
  return { rawPath, hasQuery: query >= 0 };
}

function resolveLimits(overrides = {}) {
  const value = isPlainObject(overrides) ? overrides : {};
  return {
    ...DEFAULT_LIMITS,
    ...value,
    login: { ...DEFAULT_LIMITS.login, ...(isPlainObject(value.login) ? value.login : {}) },
    requestCode: { ...DEFAULT_LIMITS.requestCode, ...(isPlainObject(value.requestCode) ? value.requestCode : {}) },
    frameRate: { ...DEFAULT_LIMITS.frameRate, ...(isPlainObject(value.frameRate) ? value.frameRate : {}) },
  };
}

function validateDependencies(deps) {
  const required = [
    [deps.cloud, ['loginPassword', 'requestVerifyCode', 'loginCode']],
    [deps.sessionStore, ['create', 'authenticate', 'clear']],
    [deps.deviceRuntime, [
      'start', 'stopSession', 'refresh', 'updateDevice', 'snapshot', 'getCameraConfig', 'subscribe',
    ]],
    [deps.cameraManager, ['configure', 'acquire', 'getLatestFrame', 'subscribe']],
    [deps.configStore, ['get', 'update']],
  ];
  if (required.some(([owner, methods]) => methods.some((method) => typeof owner?.[method] !== 'function'))) {
    throw new TypeError('Invalid HTTP app dependencies');
  }
}

export function createHttpApp(deps = {}) {
  validateDependencies(deps);
  const {
    cloud, sessionStore, deviceRuntime, cameraManager, configStore, logger,
    notificationSender, trustProxy = false, readiness = true,
  } = deps;
  const timers = {
    setTimeout: deps.timers?.setTimeout?.bind(deps.timers) ?? setTimeout,
    clearTimeout: deps.timers?.clearTimeout?.bind(deps.timers) ?? clearTimeout,
    setInterval: deps.timers?.setInterval?.bind(deps.timers) ?? setInterval,
    clearInterval: deps.timers?.clearInterval?.bind(deps.timers) ?? clearInterval,
  };
  const limits = resolveLimits(deps.limits);
  const root = fixedRoot(deps.distDir);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const loginLimiter = createSlidingWindowLimiter({ ...limits.login, now });
  const requestCodeLimiter = createSlidingWindowLimiter({ ...limits.requestCode, now });
  const frameLimiter = createSlidingWindowLimiter({ ...limits.frameRate, now });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxWsEventBytes });
  const wsBySession = new Map();
  const wsCleanup = new Map();
  const streamCounts = new Map();
  const activeCameraClosers = new Set();
  const sockets = new Set();
  let activeStreams = 0;
  let closingPromise = null;
  let closed = false;

  async function authenticate(req) {
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (typeof sessionId !== 'string') return null;
    const session = await sessionStore.authenticate(sessionId, { renew: true });
    return session ? { sessionId, session } : null;
  }

  async function requireSession(req) {
    const auth = await authenticate(req);
    if (!auth) throw apiError(401, 'UNAUTHORIZED', 'Authentication required');
    return auth;
  }

  function assertMutation(req, auth) {
    try {
      assertMutationRequest(req, { csrfToken: auth.session.csrfToken, trustProxy });
    } catch {
      throw apiError(403, 'FORBIDDEN', 'Request verification failed');
    }
  }

  async function requireEmptyJson(req) {
    const body = await jsonBody(req, limits.bodyBytes);
    if (!hasOnlyKeys(body, [])) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
  }

  async function completeLogin(req, res, body, method) {
    assertOrigin(req, trustProxy);
    const expected = method === 'loginCode' ? ['account', 'code'] : ['account', 'password'];
    if (!hasOnlyKeys(body, expected, { exact: true }) || !validateAccount(body.account)
      || method === 'loginCode' && !validateCode(body.code)
      || method === 'loginPassword' && !validatePassword(body.password)) {
      throw apiError(400, 'BAD_REQUEST', 'Invalid request');
    }
    enforceLimit(loginLimiter, limiterKey(req, body.account, trustProxy));
    let result;
    try {
      result = await cloud[method](body);
    } finally {
      if (Object.hasOwn(body, 'password')) body.password = '';
      if (Object.hasOwn(body, 'code')) body.code = '';
    }
    if (!result?.success || typeof result.accessToken !== 'string' || result.accessToken.length < 1
      || result.accessToken.length > 16_384) {
      result = null;
      throw apiError(401, 'AUTH_FAILED', 'Authentication failed');
    }
    let accessToken = result.accessToken;
    let username = typeof result.username === 'string' ? result.username.trim().slice(0, 256) : '';
    if (!username && typeof cloud.getCloudUsername === 'function') {
      try {
        const value = await cloud.getCloudUsername(accessToken);
        if (typeof value === 'string') username = value.trim().slice(0, 256);
      } catch {
        username = '';
      }
    }
    const priorBambuSession = typeof sessionStore.getBambuSession === 'function'
      ? sessionStore.getBambuSession()
      : null;
    const priorAccount = typeof priorBambuSession?.account === 'string'
      ? priorBambuSession.account
      : null;
    const created = await sessionStore.create({ account: body.account, accessToken, username });
    const saved = typeof sessionStore.getBambuSession === 'function'
      ? sessionStore.getBambuSession()
      : { accessToken, username };
    const savedAccount = typeof saved?.account === 'string'
      ? saved.account
      : created.account ?? body.account;
    if (priorAccount !== null && priorAccount !== savedAccount) {
      terminateAllSessionSockets();
    }
    await deviceRuntime.start({ accessToken: saved?.accessToken || accessToken, username: saved?.username || username });
    accessToken = null;
    result = null;
    const secure = requestIsSecure(req, { trustProxy });
    sendSuccess(res, {
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt,
      accountMasked: maskAccount(created.account ?? body.account),
    }, 200, { 'Set-Cookie': buildSessionCookie(created.sessionId, { secure }) });
  }

  async function authRoute(req, res, pathname) {
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      return completeLogin(req, res, await jsonBody(req, limits.bodyBytes), 'loginPassword');
    }
    if (pathname === '/api/auth/code/verify' && req.method === 'POST') {
      return completeLogin(req, res, await jsonBody(req, limits.bodyBytes), 'loginCode');
    }
    if (pathname === '/api/auth/code/request' && req.method === 'POST') {
      assertOrigin(req, trustProxy);
      const body = await jsonBody(req, limits.bodyBytes);
      if (!hasOnlyKeys(body, ['account'], { exact: true }) || !validateAccount(body.account)) {
        throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      }
      enforceLimit(requestCodeLimiter, limiterKey(req, body.account, trustProxy));
      const result = await cloud.requestVerifyCode(body);
      if (!result?.success) throw apiError(502, 'CODE_REQUEST_FAILED', 'Unable to request verification code');
      return sendSuccess(res, { sent: true });
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      assertOrigin(req, trustProxy);
      const auth = await authenticate(req);
      if (auth) assertMutation(req, auth);
      await requireEmptyJson(req);
      if (auth) {
        await sessionStore.clear();
        await deviceRuntime.stopSession();
        closeAllSessionSockets(1008, 'Session ended');
      }
      return sendSuccess(res, { authenticated: false }, 200, {
        'Set-Cookie': clearSessionCookie({ secure: requestIsSecure(req, { trustProxy }) }),
      });
    }
    return false;
  }

  async function sessionAndDataRoutes(req, res, pathname) {
    if (pathname === '/api/session' && req.method === 'GET') {
      const auth = await authenticate(req);
      if (!auth) return sendSuccess(res, { authenticated: false });
      return sendSuccess(res, {
        authenticated: true,
        accountMasked: isMaskedAccount(auth.session.accountMasked)
          ? auth.session.accountMasked
          : maskAccount(auth.session.account),
        csrfToken: auth.session.csrfToken,
      });
    }
    if (pathname === '/api/devices' && req.method === 'GET') {
      await requireSession(req);
      return sendSuccess(res, projectPublicDeviceEvent(deviceRuntime.snapshot()));
    }
    if (pathname === '/api/devices/refresh' && req.method === 'POST') {
      const auth = await requireSession(req);
      assertMutation(req, auth);
      await requireEmptyJson(req);
      return sendSuccess(res, projectPublicDeviceEvent(await deviceRuntime.refresh()));
    }
    const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(pathname);
    if (deviceMatch && req.method === 'PATCH') {
      const auth = await requireSession(req);
      assertMutation(req, auth);
      const serial = decodeSegment(deviceMatch[1]);
      const body = await jsonBody(req, limits.bodyBytes);
      validateDevicePatch(body);
      let updated;
      try {
        updated = await deviceRuntime.updateDevice(serial, body);
      } catch {
        throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      }
      if (!updated) throw apiError(404, 'DEVICE_NOT_FOUND', 'Device not found');
      return sendSuccess(res, projectPublicDeviceEvent({ type: 'device.updated', device: updated }).device);
    }
    if (pathname === '/api/settings' && req.method === 'GET') {
      await requireSession(req);
      return sendSuccess(res, projectSettings(configStore.get()));
    }
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const auth = await requireSession(req);
      assertMutation(req, auth);
      const body = await jsonBody(req, limits.bodyBytes);
      validateSettingsPatch(body);
      try {
        const stored = configStore.get();
        const updated = await configStore.update(prepareSettingsPatch(body, stored));
        return sendSuccess(res, projectSettings(updated));
      } catch {
        throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      }
    }
    if (pathname === '/api/notifications/test' && req.method === 'POST') {
      const auth = await requireSession(req);
      assertMutation(req, auth);
      const body = await jsonBody(req, limits.bodyBytes);
      if (!hasOnlyKeys(body, [])) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      if (typeof notificationSender !== 'function') {
        throw apiError(501, 'NOTIFICATION_UNSUPPORTED', 'Notification testing is not supported');
      }
      const result = await notificationSender({
        settings: configStore.get(),
        notification: { title: 'Bambu Monitor test', body: 'NAS notification test' },
      });
      return sendSuccess(res, { sent: result?.success !== false });
    }
    return false;
  }

  function cameraUnavailable() {
    return apiError(503, 'CAMERA_UNAVAILABLE', 'Camera is unavailable');
  }

  function canonicalCamera(serial) {
    let privateConfig;
    let settings;
    try {
      privateConfig = deviceRuntime.getCameraConfig(serial);
      settings = configStore.get();
    } catch {
      throw cameraUnavailable();
    }
    if (!isPlainObject(privateConfig)) throw cameraUnavailable();
    const canonical = privateConfig.serialNumber ?? privateConfig.dev_id;
    if (typeof canonical !== 'string' || canonical.length < 1 || canonical.length > 256
      || canonical.includes('/') || canonical.includes('\\') || canonical.includes('\0')) {
      throw cameraUnavailable();
    }
    const customUrl = settings?.camera?.customUrls?.[canonical];
    const cameraConfig = { serialNumber: canonical, dev_id: canonical };
    for (const field of ['ip', 'name', 'model', 'cameraMode', 'accessCode']) {
      if (typeof privateConfig[field] === 'string' && privateConfig[field].trim()) {
        cameraConfig[field] = privateConfig[field];
      }
    }
    if (typeof customUrl === 'string' && customUrl.trim()) cameraConfig.customUrl = customUrl;
    const hasExternalSource = typeof cameraConfig.customUrl === 'string';
    const hasBuiltInSource = typeof cameraConfig.ip === 'string'
      && typeof cameraConfig.accessCode === 'string';
    if (!hasExternalSource && !hasBuiltInSource) throw cameraUnavailable();
    try {
      cameraManager.configure(cameraConfig);
    } catch {
      throw cameraUnavailable();
    }
    return { canonical };
  }

  async function cameraFrame(req, res, serial, auth) {
    enforceLimit(frameLimiter, `${auth.sessionId}:${createHash('sha256').update(serial).digest('hex')}`);
    const release = normalizeRelease(cameraManager.acquire(serial));
    let unsubscribe = () => {};
    let timeout = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (timeout) timers.clearTimeout(timeout);
      timeout = null;
      unsubscribe();
      release();
      activeCameraClosers.delete(abort);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      res.removeListener('error', abort);
    };
    const abort = () => cleanup();
    activeCameraClosers.add(abort);
    req.once('aborted', abort);
    res.once('close', abort);
    res.once('error', abort);
    const sendFrame = (frame) => {
      const copy = Buffer.isBuffer(frame) ? Buffer.from(frame) : null;
      if (cleaned || !copy || copy.length < 1 || copy.length > limits.maxFrameBytes) return;
      cleanup();
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': copy.length,
        'Cache-Control': 'no-store',
      });
      res.end(copy);
    };
    const latest = cameraManager.getLatestFrame(serial);
    if (latest) return sendFrame(latest);
    let subscription;
    try {
      subscription = cameraManager.subscribe(serial, sendFrame);
    } catch {
      cleanup();
      throw apiError(503, 'CAMERA_UNAVAILABLE', 'Camera is unavailable');
    }
    unsubscribe = normalizeRelease(subscription);
    if (cleaned) {
      unsubscribe();
      return;
    }
    timeout = timers.setTimeout(() => {
      if (cleaned) return;
      cleanup();
      sendFailure(res, 504, 'CAMERA_TIMEOUT', 'Camera frame timed out');
    }, limits.frameWaitMs);
    timeout?.unref?.();
  }

  function cameraStream(req, res, serial) {
    const cameraCount = streamCounts.get(serial) ?? 0;
    if (cameraCount >= limits.streamsPerCamera || activeStreams >= limits.streamsGlobal) {
      throw apiError(429, 'CAMERA_STREAM_LIMIT', 'Camera stream limit reached');
    }
    streamCounts.set(serial, cameraCount + 1);
    activeStreams += 1;
    let unsubscribe = () => {};
    let cleaned = false;
    let blocked = false;
    let pending = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pending = null;
      unsubscribe();
      activeStreams = Math.max(0, activeStreams - 1);
      const next = Math.max(0, (streamCounts.get(serial) ?? 1) - 1);
      if (next === 0) streamCounts.delete(serial);
      else streamCounts.set(serial, next);
      activeCameraClosers.delete(abort);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      res.removeListener('error', abort);
      res.removeListener('finish', abort);
      res.removeListener('drain', drain);
    };
    const abort = () => cleanup();
    const writeFrame = (rawFrame) => {
      if (cleaned || !Buffer.isBuffer(rawFrame) || rawFrame.length < 1 || rawFrame.length > limits.maxFrameBytes) return;
      const frame = Buffer.from(rawFrame);
      if (blocked) {
        pending = frame;
        return;
      }
      const header = Buffer.from(`--${STREAM_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      blocked = !res.write(Buffer.concat([header, frame, Buffer.from('\r\n')]));
    };
    const drain = () => {
      blocked = false;
      if (!pending) return;
      const frame = pending;
      pending = null;
      writeFrame(frame);
    };
    activeCameraClosers.add(abort);
    req.once('aborted', abort);
    res.once('close', abort);
    res.once('error', abort);
    res.once('finish', abort);
    res.on('drain', drain);
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    try {
      unsubscribe = normalizeRelease(cameraManager.subscribe(serial, writeFrame));
    } catch {
      cleanup();
      res.destroy();
    }
  }

  async function cameraRoutes(req, res, pathname) {
    const match = /^\/api\/cameras\/([^/]+)\/(frame|stream)$/.exec(pathname);
    if (!match || req.method !== 'GET') return false;
    const auth = await requireSession(req);
    assertOrigin(req, trustProxy, { optional: true });
    const requested = decodeSegment(match[1]);
    const { canonical } = canonicalCamera(requested);
    if (match[2] === 'frame') return cameraFrame(req, res, canonical, auth);
    return cameraStream(req, res, canonical);
  }

  async function serveFile(req, res, file, { index = false, asset = false } = {}) {
    let info;
    try {
      const resolved = await realpath(file);
      if (!insideRoot(root, resolved)) return sendFailure(res, 404, 'NOT_FOUND', 'Not found');
      info = await stat(resolved);
      if (!info.isFile()) return sendFailure(res, 404, 'NOT_FOUND', 'Not found');
      file = resolved;
    } catch {
      return sendFailure(res, 404, 'NOT_FOUND', 'Not found');
    }
    const headers = {
      ...STATIC_SECURITY_HEADERS,
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': index ? 'no-cache' : asset ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.once('error', () => {
      if (!res.headersSent) sendFailure(res, 500, 'INTERNAL_ERROR', 'Internal server error');
      else res.destroy();
    });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  }

  async function staticRoute(req, res, rawPath) {
    if (!root) return sendFailure(res, 404, 'NOT_FOUND', 'Not found');
    if (!['GET', 'HEAD'].includes(req.method)) return sendFailure(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      return sendFailure(res, 400, 'BAD_REQUEST', 'Invalid request');
    }
    const segments = decoded.split('/').filter(Boolean);
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')
      || segments.some((segment) => segment === '.' || segment === '..')) {
      return sendFailure(res, 400, 'BAD_REQUEST', 'Invalid request');
    }
    if (segments.some((segment) => segment.startsWith('.') || ['server', 'data'].includes(segment.toLowerCase()))) {
      return sendFailure(res, 404, 'NOT_FOUND', 'Not found');
    }
    const candidate = path.resolve(root, `.${decoded}`);
    if (!insideRoot(root, candidate)) return sendFailure(res, 400, 'BAD_REQUEST', 'Invalid request');
    if (segments.length === 0) return serveFile(req, res, path.join(root, 'index.html'), { index: true });
    try {
      const info = await stat(candidate);
      if (info.isFile()) return serveFile(req, res, candidate, { asset: segments[0] === 'assets' });
    } catch {
      // Valid client routes fall through to the SPA shell.
    }
    return serveFile(req, res, path.join(root, 'index.html'), { index: true });
  }

  function knownApiPath(pathname) {
    return new Set([
      '/api/auth/login', '/api/auth/code/request', '/api/auth/code/verify', '/api/auth/logout',
      '/api/session', '/api/devices', '/api/devices/refresh', '/api/settings', '/api/notifications/test',
    ]).has(pathname) || /^\/api\/(devices|cameras)\//.test(pathname);
  }

  async function requestHandler(req, res) {
    const { rawPath, hasQuery } = splitTarget(req);
    try {
      if (!rawPath.startsWith('/')) throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      if (rawPath === '/healthz' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' });
      if (rawPath === '/readyz' && req.method === 'GET') {
        const ready = typeof readiness === 'function' ? await readiness() : readiness;
        const isReady = ready === true || ready?.ready === true;
        const payload = { status: isReady ? 'ready' : 'not_ready' };
        const code = isReady ? undefined : READINESS_PUBLIC_CODES.get(ready?.category);
        if (code) payload.code = code;
        return sendJson(res, isReady ? 200 : 503, payload);
      }
      if (hasQuery && (rawPath.startsWith('/api/') || rawPath === '/healthz' || rawPath === '/readyz')) {
        throw apiError(400, 'BAD_REQUEST', 'Invalid request');
      }
      if (rawPath.startsWith('/api/')) {
        if (await authRoute(req, res, rawPath) !== false) return;
        if (await sessionAndDataRoutes(req, res, rawPath) !== false) return;
        if (await cameraRoutes(req, res, rawPath) !== false) return;
        if (knownApiPath(rawPath)) throw apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        throw apiError(404, 'NOT_FOUND', 'Not found');
      }
      if ((rawPath === '/healthz' || rawPath === '/readyz') && req.method !== 'GET') {
        throw apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      return staticRoute(req, res, rawPath);
    } catch (error) {
      if (res.headersSent || res.destroyed || res.writableEnded) {
        res.destroy();
        return;
      }
      if (error?.apiStatus) {
        sendFailure(res, error.apiStatus, error.apiCode, error.safeMessage);
        return;
      }
      logSafe(logger, 'warn', 'http.request-failed', { method: req.method, path: rawPath.slice(0, 256) });
      sendFailure(res, 500, 'INTERNAL_ERROR', 'Internal server error');
    }
  }

  const server = http.createServer((req, res) => { void requestHandler(req, res); });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  function rejectUpgrade(socket, status, code, message) {
    if (socket.destroyed) return;
    const payload = JSON.stringify({ ok: false, error: { code, message } });
    socket.end(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n`
      + `Content-Type: ${JSON_TYPE}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
    );
  }

  function closeSessionSockets(sessionId, code = 1008, reason = 'Session invalid') {
    for (const ws of [...(wsBySession.get(sessionId) ?? [])]) {
      try { ws.close(code, reason); } catch { ws.terminate(); }
    }
  }

  function closeAllSessionSockets(code = 1008, reason = 'Session invalid') {
    for (const sessionId of [...wsBySession.keys()]) closeSessionSockets(sessionId, code, reason);
  }

  function terminateAllSessionSockets() {
    for (const [ws, cleanup] of [...wsCleanup]) {
      cleanup();
      try { ws.terminate(); } catch { /* already closed */ }
    }
  }

  function safeWsSend(ws, event, afterSend) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    let payload;
    try {
      payload = JSON.stringify(structuredClone(event));
      if (Buffer.byteLength(payload) > limits.maxWsEventBytes) return false;
      ws.send(payload, (error) => {
        if (error) {
          try { ws.terminate(); } catch { /* already closed */ }
          return;
        }
        try { afterSend?.(); } catch { ws.terminate(); }
      });
      return true;
    } catch {
      logSafe(logger, 'warn', 'websocket.event-dropped');
      return false;
    }
  }

  function attachWebSocket(ws, sessionId) {
    const group = wsBySession.get(sessionId) ?? new Set();
    group.add(ws);
    wsBySession.set(sessionId, group);
    ws.missedPongs = 0;
    ws.on('pong', () => { ws.missedPongs = 0; });
    let cleaned = false;
    let unsubscribe = () => {};
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe();
      wsCleanup.delete(ws);
      group.delete(ws);
      if (group.size === 0) wsBySession.delete(sessionId);
    };
    wsCleanup.set(ws, cleanup);
    ws.once('close', cleanup);
    ws.once('error', cleanup);
    safeWsSend(ws, projectPublicDeviceEvent(deviceRuntime.snapshot()));
    let subscribing = true;
    try {
      unsubscribe = normalizeRelease(deviceRuntime.subscribe((event) => {
        if (subscribing && event?.type === 'devices.snapshot') return;
        if (event?.type === 'session.invalid') {
          cleanup();
          const sent = safeWsSend(ws, event, () => {
            try { ws.close(1008, 'Session invalid'); } catch { ws.terminate(); }
          });
          if (!sent) {
            try { ws.close(1008, 'Session invalid'); } catch { ws.terminate(); }
          }
          return;
        }
        safeWsSend(ws, projectPublicDeviceEvent(event));
      }));
    } catch {
      ws.close(1011, 'Subscription unavailable');
    } finally {
      subscribing = false;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const { rawPath, hasQuery } = splitTarget(req);
      if (closed || rawPath !== '/api/ws' || hasQuery || req.method !== 'GET') {
        rejectUpgrade(socket, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      try {
        assertOrigin(req, trustProxy);
        const auth = await requireSession(req);
        const group = wsBySession.get(auth.sessionId);
        if ((group?.size ?? 0) >= limits.wsPerSession) {
          rejectUpgrade(socket, 429, 'WEBSOCKET_LIMIT', 'WebSocket limit reached');
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
          attachWebSocket(ws, auth.sessionId);
        });
      } catch (error) {
        if (error?.apiStatus) rejectUpgrade(socket, error.apiStatus, error.apiCode, error.safeMessage);
        else rejectUpgrade(socket, 500, 'INTERNAL_ERROR', 'Internal server error');
      }
    })();
  });

  const pingTimer = timers.setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.missedPongs >= 2) {
        try { ws.terminate(); } catch { /* already closing */ }
        continue;
      }
      ws.missedPongs += 1;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, 30_000);
  pingTimer?.unref?.();

  function close() {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      closed = true;
      timers.clearInterval(pingTimer);
      loginLimiter.clear();
      requestCodeLimiter.clear();
      frameLimiter.clear();
      for (const cleanup of [...activeCameraClosers]) cleanup();
      for (const [ws, cleanup] of [...wsCleanup]) {
        cleanup();
        try { ws.terminate(); } catch { /* already closed */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    })();
    return closingPromise;
  }

  return {
    server,
    listen(...args) { return server.listen(...args); },
    close,
  };
}
