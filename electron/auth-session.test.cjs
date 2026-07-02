const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearAuthSession,
  getAuthSessionPath,
  readAuthSession,
  writeAuthSession,
} = require('./auth-session.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-auth-session-'));
}

test('persists and reads Bambu auth session outside renderer localStorage', () => {
  const dir = makeTempDir();
  const saved = writeAuthSession(dir, {
    account: 'user@example.com',
    accessToken: 'token-123',
    savedAt: 1234,
  });

  assert.deepEqual(saved, {
    account: 'user@example.com',
    accessToken: 'token-123',
    savedAt: 1234,
  });
  assert.deepEqual(readAuthSession(dir), saved);
});

test('clears persisted auth session', () => {
  const dir = makeTempDir();
  writeAuthSession(dir, { account: 'user@example.com', accessToken: 'token-123' });
  assert.ok(fs.existsSync(getAuthSessionPath(dir)));

  clearAuthSession(dir);

  assert.equal(readAuthSession(dir), null);
});

test('rejects empty persisted session tokens', () => {
  assert.throws(
    () => writeAuthSession(makeTempDir(), { account: 'user@example.com', accessToken: '' }),
    /登录令牌/,
  );
});
