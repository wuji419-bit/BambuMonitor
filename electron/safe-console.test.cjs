const test = require('node:test');
const assert = require('node:assert/strict');

const {
  installSafeConsole,
  isBrokenPipeError,
} = require('./safe-console.cjs');

test('detects broken pipe console write errors', () => {
  const error = new Error('EPIPE: broken pipe, write');
  error.code = 'EPIPE';

  assert.equal(isBrokenPipeError(error), true);
  assert.equal(isBrokenPipeError(new Error('something else')), false);
});

test('swallows EPIPE from console methods without hiding other errors', () => {
  const epipe = new Error('EPIPE: broken pipe, write');
  epipe.code = 'EPIPE';

  const fatal = new Error('unexpected logging failure');
  const fakeConsole = {
    log() {
      throw epipe;
    },
    warn() {
      throw fatal;
    },
    error() {
      return 'ok';
    },
  };

  installSafeConsole(fakeConsole);

  assert.doesNotThrow(() => fakeConsole.log('mqtt reconnecting'));
  assert.throws(() => fakeConsole.warn('real issue'), fatal);
  assert.doesNotThrow(() => fakeConsole.error('still ok'));
});
