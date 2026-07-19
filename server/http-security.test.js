import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  assertMutationRequest,
  buildSessionCookie,
  clearSessionCookie,
  createSlidingWindowLimiter,
  parseCookies,
  readJsonBody,
  redactSecrets,
  requestIsSecure,
} from './http-security.js';

function request(headers = {}, encrypted = false) {
  return { headers, socket: { encrypted } };
}

test('readJsonBody counts UTF-8 bytes across chunks and accepts the exact limit', async () => {
  const body = '{"name":"打印"}';
  const chunks = [Buffer.from(body).subarray(0, 10), Buffer.from(body).subarray(10)];
  assert.deepEqual(await readJsonBody(Readable.from(chunks), { maxBytes: Buffer.byteLength(body) }), {
    name: '打印',
  });
  await assert.rejects(
    readJsonBody(Readable.from(chunks), { maxBytes: Buffer.byteLength(body) - 1 }),
    { message: 'Request body too large' },
  );
});

test('readJsonBody prechecks content-length and rejects chunk overflow without values', async () => {
  const declared = Readable.from(['{}']);
  declared.headers = { 'content-length': '100' };
  await assert.rejects(readJsonBody(declared, { maxBytes: 2 }), { message: 'Request body too large' });

  const overflow = Readable.from([Buffer.alloc(4, 0x61), Buffer.alloc(4, 0x62)]);
  await assert.rejects(readJsonBody(overflow, { maxBytes: 7 }), (error) => {
    assert.equal(error.message, 'Request body too large');
    assert.doesNotMatch(error.message, /aaaa|bbbb/);
    return true;
  });
});

test('readJsonBody rejects aborted, failed, invalid UTF-8, empty, and malformed bodies stably', async () => {
  const aborted = Readable.from(['{}']);
  aborted.aborted = true;
  await assert.rejects(readJsonBody(aborted), { message: 'Request aborted' });

  const failed = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      throw new Error('socket secret');
    },
  };
  await assert.rejects(readJsonBody(failed), { message: 'Unable to read request body' });
  await assert.rejects(readJsonBody(Readable.from([Buffer.from([0xc3, 0x28])])), {
    message: 'Invalid UTF-8 body',
  });
  await assert.rejects(readJsonBody(Readable.from([])), { message: 'Invalid JSON body' });
  await assert.rejects(readJsonBody(Readable.from(['{"secret":'])), (error) => {
    assert.equal(error.message, 'Invalid JSON body');
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('readJsonBody validates limits and removes listeners added while reading', async () => {
  await assert.rejects(readJsonBody(Readable.from(['{}']), { maxBytes: 0 }), {
    message: 'Invalid JSON body limit',
  });
  const stream = Readable.from(['{}']);
  const before = Object.fromEntries(['aborted', 'error', 'data', 'end', 'close'].map((name) => [name, stream.listenerCount(name)]));
  await readJsonBody(stream);
  for (const [name, count] of Object.entries(before)) assert.equal(stream.listenerCount(name), count);
});

test('parseCookies is null-prototype, first-wins, decoding-safe, and pollution-safe', () => {
  const parsed = parseCookies('bambu_session=first; encoded=hello%20world; broken=%E0%A4%A; bambu_session=second; __proto__=owned; constructor=kept; empty=');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.bambu_session, 'first');
  assert.equal(parsed.encoded, 'hello world');
  assert.equal(parsed.broken, '%E0%A4%A');
  assert.equal(parsed.__proto__, 'owned');
  assert.equal(parsed.constructor, 'kept');
  assert.equal(parsed.empty, '');
  assert.equal({}.owned, undefined);
  assert.deepEqual({ ...parseCookies(['a=1']), ...parseCookies(null) }, {});
});

test('session cookies enforce bounded base64url values and exact attributes', () => {
  const value = Buffer.alloc(32, 7).toString('base64url');
  assert.equal(
    buildSessionCookie(value, { secure: true, maxAgeSeconds: 60 }),
    `bambu_session=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60`,
  );
  assert.equal(
    buildSessionCookie(value, { secure: false, maxAgeSeconds: 0 }),
    `bambu_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  for (const badValue of ['', 'x=y', 'x'.repeat(257)]) {
    assert.throws(() => buildSessionCookie(badValue, { maxAgeSeconds: 1 }), /Invalid session cookie/);
  }
  for (const maxAgeSeconds of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildSessionCookie(value, { maxAgeSeconds }), /Invalid session cookie/);
  }
});

test('clearSessionCookie expires the same cookie and applies Secure conditionally', () => {
  assert.equal(
    clearSessionCookie({ secure: true }),
    'bambu_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  );
  assert.doesNotMatch(clearSessionCookie(), /; Secure/);
});

test('requestIsSecure trusts TLS and only the first forwarded hop when configured', () => {
  assert.equal(requestIsSecure(request({}, true)), true);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': 'https' })), false);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': 'https, http' }), { trustProxy: true }), true);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': 'http, https' }), { trustProxy: true }), false);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': ['https'] }), { trustProxy: true }), false);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': ' https ' }), { trustProxy: true }), true);
  assert.equal(requestIsSecure(request({ 'x-forwarded-proto': 'https\r\nspoof' }), { trustProxy: true }), false);
});

test('assertMutationRequest accepts exact origin including ports and IPv6 hosts', () => {
  assert.doesNotThrow(() => assertMutationRequest(request({
    host: 'nas.local:3080', origin: 'http://nas.local:3080', 'x-csrf-token': 'same-token',
  }), { csrfToken: 'same-token' }));
  assert.doesNotThrow(() => assertMutationRequest(request({
    host: '[2001:db8::1]:3080', origin: 'https://[2001:db8::1]:3080',
    'x-forwarded-proto': 'https', 'x-csrf-token': 'same-token',
  }), { csrfToken: 'same-token', trustProxy: true }));
});

test('assertMutationRequest rejects origin, Host, proxy, and CSRF spoofing', () => {
  const cases = [
    [{ host: 'nas.local', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'null', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'not a url', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'bad host', origin: 'http://bad host', 'x-csrf-token': 'x' }, 'Invalid request host'],
    [{ host: ['nas.local'], origin: 'http://nas.local', 'x-csrf-token': 'x' }, 'Invalid request host'],
    [{ host: 'nas.local', origin: ['http://nas.local'], 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'https://nas.local', 'x-forwarded-proto': 'https', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'http://nas.local:80', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'http://nas.local/path', 'x-csrf-token': 'x' }, 'Invalid request origin'],
    [{ host: 'nas.local', origin: 'http://nas.local', 'x-csrf-token': ['x'] }, 'Invalid CSRF token'],
    [{ host: 'nas.local', origin: 'http://nas.local' }, 'Invalid CSRF token'],
    [{ host: 'nas.local', origin: 'http://nas.local', 'x-csrf-token': 'wrong' }, 'Invalid CSRF token'],
  ];
  for (const [headers, message] of cases) {
    assert.throws(() => assertMutationRequest(request(headers), { csrfToken: 'x' }), { message });
  }
  assert.doesNotThrow(() => assertMutationRequest(request({
    host: 'nas.local', origin: 'https://nas.local', 'x-forwarded-proto': 'https', 'x-csrf-token': 'x',
  }), { csrfToken: 'x', trustProxy: true }));
});

test('sliding limiter has deterministic boundaries, remaining count, and retry time', () => {
  const clock = { value: 0 };
  const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1_000, maxKeys: 3, now: () => clock.value });
  assert.deepEqual(limiter.check('a'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  clock.value = 100;
  assert.deepEqual(limiter.check('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  clock.value = 999;
  assert.deepEqual(limiter.check('a'), { allowed: false, remaining: 0, retryAfterMs: 1 });
  clock.value = 1_000;
  assert.deepEqual(limiter.check('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
});

test('sliding limiter prunes expiry, bounds keys, and supports reset and clear', () => {
  const clock = { value: 0 };
  const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 10, maxKeys: 2, now: () => clock.value });
  limiter.check('a');
  limiter.check('b');
  assert.equal(limiter.size, 2);
  assert.deepEqual(limiter.check('c'), { allowed: false, remaining: 0, retryAfterMs: 10 });
  assert.equal(limiter.size, 2);
  limiter.reset('a');
  assert.equal(limiter.size, 1);
  assert.equal(limiter.check('c').allowed, true);
  limiter.clear();
  assert.equal(limiter.size, 0);
  clock.value = 10;
  limiter.check('new');
  assert.equal(limiter.size, 1);
  limiter.reset();
  assert.equal(limiter.size, 0);
});

test('sliding limiter validates bounded configuration, keys, and clock values', () => {
  for (const options of [{ limit: 0 }, { windowMs: 0 }, { maxKeys: 0 }, { limit: 1.5 }, { now: 1 }]) {
    assert.throws(() => createSlidingWindowLimiter(options), /Invalid rate limiter/);
  }
  const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 10, maxKeys: 1, now: () => Number.NaN });
  assert.throws(() => limiter.check('a'), /Invalid rate limiter time/);
  assert.throws(() => limiter.check(''), /Invalid rate limiter key/);
  assert.throws(() => limiter.check('x'.repeat(257)), /Invalid rate limiter key/);
});

test('redactSecrets clones nested arrays, cycles, errors, and format-insensitive fields', () => {
  const error = new Error('login failed password=hunter2');
  error.authorization = 'Bearer token';
  const source = {
    Password: 'one', access_token: 'two', 'api-key': 'three', ACCESSCODE: 'four', cookie: 'five',
    nested: [{ verificationCode: 'six', safe: true }], error,
  };
  source.self = source;
  const redacted = redactSecrets(source);
  assert.notEqual(redacted, source);
  assert.equal(redacted.self, '[Circular]');
  assert.equal(redacted.Password, '[REDACTED]');
  assert.equal(redacted.access_token, '[REDACTED]');
  assert.equal(redacted['api-key'], '[REDACTED]');
  assert.equal(redacted.ACCESSCODE, '[REDACTED]');
  assert.equal(redacted.nested[0].verificationCode, '[REDACTED]');
  assert.equal(redacted.error.authorization, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(redacted), /one|two|three|four|five|six|hunter2|Bearer/);
});

test('redactSecrets strips URL userinfo without exposing malformed or nested credentials', () => {
  const redacted = redactSecrets({
    url: 'rtsps://bblp:access-secret@192.168.1.2/streaming/live/1',
    endpoint: 'https://user:pass@example.test/a?token=still-in-query',
    malformed: 'https://user:pass@%',
  });
  assert.equal(redacted.url, 'rtsps://[REDACTED]@192.168.1.2/streaming/live/1');
  assert.equal(redacted.endpoint, 'https://[REDACTED]@example.test/a?token=[REDACTED]');
  assert.equal(redacted.malformed, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(redacted), /access-secret|user|pass|still-in-query/);
});

test('redactSecrets strips embedded URL credentials from plain strings and Error messages', () => {
  const plain = 'camera failed: rtsps://viewer:plain-secret@camera.local/live; retry later';
  const error = new Error('request failed at https://admin:error-secret@example.test/path (offline)');
  const ordinary = 'camera failed: retry later without a URL';

  const redacted = redactSecrets({ plain, error, ordinary });

  assert.equal(
    redacted.plain,
    'camera failed: rtsps://[REDACTED]@camera.local/live; retry later',
  );
  assert.equal(
    redacted.error.message,
    'request failed at https://[REDACTED]@example.test/path (offline)',
  );
  assert.equal(redacted.ordinary, ordinary);
  assert.doesNotMatch(JSON.stringify(redacted), /viewer|plain-secret|admin|error-secret/);
});

test('redactSecrets applies depth, collection, string, and property bounds', () => {
  const deep = { value: 'ok' };
  let cursor = deep;
  for (let index = 0; index < 20; index += 1) {
    cursor.next = { password: 'never-leak' };
    cursor = cursor.next;
  }
  const redacted = redactSecrets({ deep, list: Array.from({ length: 200 }, (_, index) => index), text: 'x'.repeat(20_000) });
  const output = JSON.stringify(redacted);
  assert.ok(output.length < 20_000);
  assert.doesNotMatch(output, /never-leak/);
  assert.match(output, /Truncated/);
});

test('readJsonBody supports a minimal async iterable without EventEmitter APIs', async () => {
  const req = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"ok":');
      yield Buffer.from('true}');
    },
  };
  assert.deepEqual(await readJsonBody(req), { ok: true });
});

test('readJsonBody maps an emitted request error without retaining listeners', async () => {
  class FailedRequest extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
    }
  }
  const req = new FailedRequest();
  const pending = readJsonBody(req);
  req.emit('error', new Error('private transport detail'));
  await assert.rejects(pending, { message: 'Unable to read request body' });
  assert.equal(req.listenerCount('error'), 0);
  assert.equal(req.listenerCount('aborted'), 0);
});
