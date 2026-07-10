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

function makeProtectionAdapter(prefix = 'protected:') {
  return {
    protect(value) {
      return Buffer.from(`${prefix}${value}`, 'utf8');
    },
    unprotect(value) {
      const decoded = Buffer.from(value).toString('utf8');
      if (!decoded.startsWith(prefix)) throw new Error('cannot decrypt');
      return decoded.slice(prefix.length);
    },
  };
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

test('protects the saved session payload when an adapter is available', () => {
  const dir = makeTempDir();
  const protection = makeProtectionAdapter();
  const saved = writeAuthSession(dir, {
    account: 'secure@example.com',
    accessToken: 'secret-token',
    savedAt: 5678,
  }, protection);

  const raw = fs.readFileSync(getAuthSessionPath(dir), 'utf8');
  assert.doesNotMatch(raw, /secret-token|secure@example\.com/);
  assert.deepEqual(readAuthSession(dir, protection), saved);
});

test('migrates a legacy plaintext session when protection becomes available', () => {
  const dir = makeTempDir();
  const legacy = writeAuthSession(dir, {
    account: 'legacy@example.com',
    accessToken: 'legacy-token',
    savedAt: 9012,
  });
  const protection = makeProtectionAdapter();

  assert.deepEqual(readAuthSession(dir, protection), legacy);
  const migrated = fs.readFileSync(getAuthSessionPath(dir), 'utf8');
  assert.doesNotMatch(migrated, /legacy-token|legacy@example\.com/);
  assert.equal(JSON.parse(migrated).protected, true);
});

test('returns no session when protected data cannot be decrypted', () => {
  const dir = makeTempDir();
  writeAuthSession(dir, { accessToken: 'secret-token' }, makeProtectionAdapter('key-a:'));

  assert.equal(readAuthSession(dir, makeProtectionAdapter('key-b:')), null);
});
