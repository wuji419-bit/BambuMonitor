const fs = require('fs');
const path = require('path');

const AUTH_SESSION_FILE = 'bambu-auth-session.json';

function getAuthSessionPath(userDataPath) {
  return path.join(userDataPath, AUTH_SESSION_FILE);
}

function normalizeAuthSession(session = {}) {
  const accessToken = String(session.accessToken || '').trim();
  const account = String(session.account || '').trim();
  if (!accessToken) return null;

  return {
    account,
    accessToken,
    savedAt: Number(session.savedAt) || Date.now(),
  };
}

function canProtect(protection) {
  return typeof protection?.protect === 'function';
}

function canUnprotect(protection) {
  return typeof protection?.unprotect === 'function';
}

function createProtectedEnvelope(session, protection) {
  const protectedValue = protection.protect(JSON.stringify(session));
  return {
    version: 2,
    protected: true,
    payload: Buffer.from(protectedValue).toString('base64'),
  };
}

function readAuthSession(userDataPath, protection = null) {
  try {
    const raw = fs.readFileSync(getAuthSessionPath(userDataPath), 'utf8');
    const stored = JSON.parse(raw);

    if (stored?.protected === true) {
      if (!stored.payload || !canUnprotect(protection)) return null;
      const decrypted = protection.unprotect(Buffer.from(stored.payload, 'base64'));
      return normalizeAuthSession(JSON.parse(decrypted));
    }

    const normalized = normalizeAuthSession(stored);
    if (normalized && canProtect(protection)) {
      writeAuthSession(userDataPath, normalized, protection);
    }
    return normalized;
  } catch {
    return null;
  }
}

function writeAuthSession(userDataPath, session, protection = null) {
  const normalized = normalizeAuthSession(session);
  if (!normalized) {
    throw new Error('缺少登录令牌');
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  const stored = canProtect(protection)
    ? createProtectedEnvelope(normalized, protection)
    : normalized;
  fs.writeFileSync(
    getAuthSessionPath(userDataPath),
    JSON.stringify(stored, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return normalized;
}

function clearAuthSession(userDataPath) {
  try {
    fs.rmSync(getAuthSessionPath(userDataPath), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

module.exports = {
  clearAuthSession,
  getAuthSessionPath,
  readAuthSession,
  writeAuthSession,
};
