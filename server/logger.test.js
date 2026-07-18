import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from './logger.js';

function capture(options = {}) {
  const lines = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date('2026-07-19T12:34:56.789Z'),
    deviceSalt: 'salt-one',
    ...options,
  });
  return { logger, lines };
}

test('logger emits one newline-terminated single-line JSON record for every level', () => {
  const { logger, lines } = capture({ debug: true });
  logger.debug('http', 'debug_event', { ok: true });
  logger.info('http', 'info_event');
  logger.warn('http', 'warn_event', null);
  logger.error('http', 'error_event', new Error('failure'));
  assert.equal(lines.length, 4);
  for (const [index, level] of ['debug', 'info', 'warn', 'error'].entries()) {
    assert.match(lines[index], /^[^\r\n]+\n$/);
    assert.equal(lines[index].slice(0, -1).includes('\n'), false);
    const record = JSON.parse(lines[index]);
    assert.equal(record.time, '2026-07-19T12:34:56.789Z');
    assert.equal(record.level, level);
    assert.equal(record.component, 'http');
    assert.equal(record.event, `${level}_event`);
  }
});

test('logger skips debug when disabled and validates its dependencies', () => {
  const { logger, lines } = capture({ debug: false });
  logger.debug('http', 'hidden', { password: 'secret' });
  assert.deepEqual(lines, []);
  assert.throws(() => createLogger({}), /Invalid logger/);
  assert.throws(() => createLogger({ write() {}, now: 1 }), /Invalid logger/);
});

test('logger creates stable 12-hex device IDs that vary by serial and salt', () => {
  const first = capture();
  first.logger.info('camera', 'started', { serialNumber: '01P00ABC', safe: 1 });
  first.logger.info('camera', 'stopped', { deviceId: '01P00ABC', safe: 2 });
  first.logger.info('camera', 'other', { serial: '01P00XYZ' });
  const second = capture({ deviceSalt: 'salt-two' });
  second.logger.info('camera', 'started', { serialNumber: '01P00ABC' });
  const records = first.lines.map(JSON.parse);
  assert.match(records[0].device, /^[a-f0-9]{12}$/);
  assert.equal(records[0].device, records[1].device);
  assert.notEqual(records[0].device, records[2].device);
  assert.notEqual(records[0].device, JSON.parse(second.lines[0]).device);
  assert.doesNotMatch(first.lines.join(''), /01P00ABC|01P00XYZ/);
});

test('nondebug logs recursively omit IP, address, and raw device identifiers', () => {
  const { logger, lines } = capture();
  logger.info('camera', 'source_started', {
    ip: '192.168.1.92', address: '10.0.0.2', remoteAddress: '::1',
    nested: { hostAddress: 'private-host', serialNumber: '01P00ABC', device_id: 'device-raw', keep: 'yes' },
    url: 'rtsps://bblp:12345678@192.168.1.92/live',
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.details.nested.keep, 'yes');
  assert.equal(record.device.length, 12);
  assert.doesNotMatch(lines[0], /192\.168|10\.0\.0\.2|::1|private-host|01P00ABC|device-raw|12345678/);
});

test('debug logs may retain IP fields but always redact credentials and raw device IDs', () => {
  const { logger, lines } = capture({ debug: true });
  logger.debug('camera', 'source_started', {
    ip: '192.168.1.92', remoteAddress: '::1', serialNumber: '01P00ABC',
    password: 'secret', authorization: 'Bearer abc', apiKey: 'key',
    url: 'https://user:pass@192.168.1.92/path?token=query-secret',
  });
  const record = JSON.parse(lines[0]);
  assert.equal(record.details.ip, '192.168.1.92');
  assert.equal(record.details.remoteAddress, '::1');
  assert.equal(record.details.password, '[REDACTED]');
  assert.doesNotMatch(lines[0], /01P00ABC|query-secret|Bearer abc|https:\/\/user:pass/);
});

test('logger safely bounds circular Error details without leaking message secrets', () => {
  const { logger, lines } = capture();
  const error = new Error('password=hidden-value\nsecond line');
  error.code = 'AUTH_SECRET_CODE';
  error.accessToken = 'token-value';
  error.self = error;
  logger.error('auth\nforged', 'login\rforged', { error, huge: 'x'.repeat(100_000) });
  assert.equal(lines.length, 1);
  assert.ok(Buffer.byteLength(lines[0]) < 20_000);
  const record = JSON.parse(lines[0]);
  assert.equal(record.component.includes('\n'), false);
  assert.equal(record.event.includes('\r'), false);
  assert.doesNotMatch(lines[0], /hidden-value|AUTH_SECRET_CODE|token-value|second line/);
  assert.match(lines[0], /REDACTED|Truncated/);
});

test('logger omits device when no raw serial is present and tolerates write failures', () => {
  const { logger, lines } = capture({ deviceSalt: '' });
  logger.info('system', 'ready', { ok: true });
  assert.equal(Object.hasOwn(JSON.parse(lines[0]), 'device'), false);
  const throwing = createLogger({ write() { throw new Error('disk path secret'); } });
  assert.doesNotThrow(() => throwing.error('system', 'write_failed', { password: 'secret' }));
});
