const test = require('node:test');
const assert = require('node:assert/strict');

const { extractBambuUsername } = require('./bambu-token.cjs');

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

test('extracts and trims a Bambu username from a JWT payload', () => {
  assert.equal(extractBambuUsername(makeJwt({ username: '  u_2468  ' })), 'u_2468');
});

test('returns an empty username for opaque, malformed, or incomplete tokens', () => {
  assert.equal(extractBambuUsername('not-a-jwt'), '');
  assert.equal(extractBambuUsername('header.not-json.signature'), '');
  assert.equal(extractBambuUsername(makeJwt({ uid: '42' })), '');
});

test('uses the explicit fallback username before decoding the token', () => {
  assert.equal(
    extractBambuUsername('opaque-token', '  u_explicit  '),
    'u_explicit',
  );
});
