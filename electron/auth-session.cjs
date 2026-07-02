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

function readAuthSession(userDataPath) {
  try {
    const raw = fs.readFileSync(getAuthSessionPath(userDataPath), 'utf8');
    return normalizeAuthSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeAuthSession(userDataPath, session) {
  const normalized = normalizeAuthSession(session);
  if (!normalized) {
    throw new Error('缺少登录令牌');
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(getAuthSessionPath(userDataPath), JSON.stringify(normalized, null, 2), 'utf8');
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
