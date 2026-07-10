import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsConnectionGeneration, beginConnectionGeneration } from './sessionGeneration.js';

test('initial login creates a new connection generation', () => assert.equal(beginConnectionGeneration(4), 5));
test('post-signout LAN result is rejected', () => assert.equal(acceptsConnectionGeneration(6, 5), false));
test('new login is not overwritten by an older generation', () => assert.equal(acceptsConnectionGeneration(7, 6), false));
test('same-generation LAN result is accepted', () => assert.equal(acceptsConnectionGeneration(7, 7), true));
