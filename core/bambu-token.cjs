function decodeBase64UrlJson(value) {
  const segment = String(value || '');
  if (!segment) return null;

  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function extractBambuUsername(authToken, fallbackUsername = '') {
  const fallback = String(fallbackUsername || '').trim();
  if (fallback) return fallback;

  const parts = String(authToken || '').split('.');
  if (parts.length !== 3) return '';

  const payload = decodeBase64UrlJson(parts[1]);
  return String(payload?.username || '').trim();
}

module.exports = {
  extractBambuUsername,
};
