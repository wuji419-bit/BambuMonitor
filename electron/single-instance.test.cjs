const test = require('node:test');
const assert = require('node:assert/strict');

const { enforceSingleInstance } = require('./single-instance.cjs');

test('quits immediately when another app instance owns the lock', () => {
  const events = [];
  const app = {
    requestSingleInstanceLock: () => false,
    on: (...args) => events.push(args),
    quit: () => events.push(['quit']),
  };

  const ownsLock = enforceSingleInstance(app, () => events.push(['activate']));

  assert.equal(ownsLock, false);
  assert.deepEqual(events, [['quit']]);
});

test('activates the existing window when a second launch is requested', () => {
  const listeners = new Map();
  const events = [];
  const app = {
    requestSingleInstanceLock: () => true,
    on: (eventName, listener) => listeners.set(eventName, listener),
    quit: () => events.push('quit'),
  };

  const ownsLock = enforceSingleInstance(app, () => events.push('activate'));
  listeners.get('second-instance')();

  assert.equal(ownsLock, true);
  assert.deepEqual(events, ['activate']);
});
