import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStorage } from './storage.js';
import { createSessionStore } from './session-store.js';

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;
const BAMBU = { account: 'maker@example.test', accessToken: '  opaque-access-token\t', username: 'Maker' };

function memoryStorage(initial = null) {
  let value = initial === null ? null : structuredClone(initial);
  const writes = [];
  let writeError = null;
  let removeError = null;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  return {
    key: Buffer.alloc(32, 0x5a), writes,
    get value() { return value === null ? null : structuredClone(value); },
    set writeError(error) { writeError = error; },
    set removeError(error) { removeError = error; },
    get maxActiveWrites() { return maxActiveWrites; },
    getSecretKey() { return Buffer.from(this.key); },
    async readEncrypted(name) {
      assert.equal(name, 'session.enc');
      return value === null ? null : structuredClone(value);
    },
    async writeEncrypted(name, next) {
      assert.equal(name, 'session.enc');
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (writeError) throw writeError;
        value = structuredClone(next);
        writes.push(structuredClone(next));
      } finally { activeWrites -= 1; }
    },
    async remove(name) {
      assert.equal(name, 'session.enc');
      if (removeError) throw removeError;
      value = null;
    },
  };
}

function byteGenerator({ collide = 0 } = {}) {
  let call = 0;
  const lengths = [];
  const randomBytes = (length) => {
    lengths.push(length);
    call += 1;
    return Buffer.alloc(length, call <= collide ? 1 : call - collide);
  };
  return { randomBytes, lengths, get calls() { return call; } };
}

async function createAt(storage, clock, options = {}) {
  return createSessionStore({ storage, now: () => clock.value,
    randomBytes: options.randomBytes ?? byteGenerator().randomBytes, cryptoApi: options.cryptoApi });
}

test('create persists only a session hash in the exact v1 shape and preserves opaque credentials', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const random = byteGenerator();
  const store = await createAt(storage, clock, random);
  const created = await store.create(BAMBU);

  assert.equal(Buffer.from(created.sessionId, 'base64url').length, 32);
  assert.equal(Buffer.from(created.csrfToken, 'base64url').length, 32);
  assert.deepEqual(created, { sessionId: created.sessionId, csrfToken: created.csrfToken,
    expiresAt: clock.value + MONTH, account: BAMBU.account });
  assert.deepEqual(storage.value, {
    version: 1,
    bambu: { ...BAMBU, savedAt: clock.value },
    sessions: [{ idHash: storage.value.sessions[0].idHash, createdAt: clock.value,
      lastSeenAt: clock.value, expiresAt: clock.value + MONTH }],
  });
  assert.match(storage.value.sessions[0].idHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(storage.value).includes(created.sessionId), false);
  assert.equal(JSON.stringify(storage.value).includes(created.csrfToken), false);
  assert.deepEqual(random.lengths, [32]);
});

test('real encrypted storage hides account, token, and raw session ID and authenticates after restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-session-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const clock = { value: 50_000 };
  const storage = await createStorage({ dataDir });
  const first = await createAt(storage, clock);
  const created = await first.create(BAMBU);
  const disk = await fs.readFile(path.join(dataDir, 'session.enc'), 'utf8');
  for (const secret of [BAMBU.account, BAMBU.accessToken, created.sessionId]) assert.equal(disk.includes(secret), false);

  const restarted = await createAt(await createStorage({ dataDir }), clock);
  assert.deepEqual(await restarted.authenticate(created.sessionId), {
    account: BAMBU.account, username: BAMBU.username,
    csrfToken: created.csrfToken, expiresAt: created.expiresAt,
  });
});

test('CSRF is stable per session, differs between sessions, and invalid IDs reject', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 10 }, byteGenerator());
  const first = await store.create(BAMBU);
  const second = await store.create(BAMBU);
  assert.notEqual(first.csrfToken, second.csrfToken);
  assert.equal((await store.authenticate(first.sessionId)).csrfToken, first.csrfToken);
  assert.equal((await store.authenticate(first.sessionId)).csrfToken, first.csrfToken);
  assert.equal(await store.authenticate('not-a-session-id'), null);
  assert.equal(await store.authenticate(Buffer.alloc(32, 99).toString('base64url')), null);
});

test('renewal writes at the 24-hour boundary, extends by 30 days, and avoids excess writes', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock);
  const created = await store.create(BAMBU);
  clock.value += DAY - 1;
  assert.equal((await store.authenticate(created.sessionId, { renew: true })).expiresAt, created.expiresAt);
  assert.equal(storage.writes.length, 1);
  clock.value += 1;
  const renewed = await store.authenticate(created.sessionId, { renew: true });
  assert.equal(renewed.expiresAt, clock.value + MONTH);
  assert.equal(storage.writes.length, 2);
  assert.equal(storage.value.sessions[0].lastSeenAt, clock.value);
  clock.value += DAY - 1;
  await store.authenticate(created.sessionId, { renew: true });
  assert.equal(storage.writes.length, 2);
});

test('startup prunes expired sessions only when needed and authenticate rejects expiry', async () => {
  const clock = { value: 500 };
  const active = { idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 1, expiresAt: 501 };
  const expired = { idHash: 'b'.repeat(64), createdAt: 1, lastSeenAt: 1, expiresAt: 500 };
  const storage = memoryStorage({ version: 1, bambu: { ...BAMBU, savedAt: 1 }, sessions: [active, expired] });
  await createAt(storage, clock);
  assert.deepEqual(storage.value.sessions, [active]);
  assert.equal(storage.writes.length, 1);
  const cleanStorage = memoryStorage(storage.value);
  await createAt(cleanStorage, clock);
  assert.equal(cleanStorage.writes.length, 0);

  const expiringStorage = memoryStorage();
  const store = await createAt(expiringStorage, clock);
  const created = await store.create(BAMBU);
  clock.value = created.expiresAt;
  assert.equal(await store.authenticate(created.sessionId), null);
});

test('same identity supports multiple browsers and evicts least recently renewed above 20', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock, byteGenerator());
  const sessions = [];
  for (let index = 0; index < 20; index += 1) {
    clock.value += 1;
    sessions.push(await store.create(BAMBU));
  }
  clock.value += DAY;
  await store.authenticate(sessions[0].sessionId, { renew: true });
  clock.value += 1;
  const newest = await store.create(BAMBU);
  assert.equal(storage.value.sessions.length, 20);
  assert.notEqual(await store.authenticate(sessions[0].sessionId), null);
  assert.equal(await store.authenticate(sessions[1].sessionId), null);
  assert.notEqual(await store.authenticate(newest.sessionId), null);
});

test('logging into a different Bambu identity invalidates prior browser sessions', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 100 });
  const old = await store.create(BAMBU);
  const sibling = await store.create(BAMBU);
  const replacement = await store.create({ ...BAMBU, account: 'other@example.test' });
  assert.equal(await store.authenticate(old.sessionId), null);
  assert.equal(await store.authenticate(sibling.sessionId), null);
  assert.notEqual(await store.authenticate(replacement.sessionId), null);
  assert.equal(storage.value.sessions.length, 1);
});

test('failed create and renewal writes preserve the last committed memory state', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock);
  const created = await store.create(BAMBU);
  storage.writeError = new Error('simulated write failure');
  await assert.rejects(store.create(BAMBU), /simulated write failure/);
  assert.notEqual(await store.authenticate(created.sessionId), null);
  clock.value += DAY;
  await assert.rejects(store.authenticate(created.sessionId, { renew: true }), /simulated write failure/);
  assert.equal((await store.authenticate(created.sessionId)).expiresAt, created.expiresAt);
});

test('clear removes disk before memory and failed remove preserves memory', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 1 });
  const created = await store.create(BAMBU);
  storage.removeError = new Error('simulated remove failure');
  await assert.rejects(store.clear(), /simulated remove failure/);
  assert.notEqual(await store.authenticate(created.sessionId), null);
  assert.notEqual(store.getBambuSession(), null);
  storage.removeError = null;
  await store.clear();
  assert.equal(await store.authenticate(created.sessionId), null);
  assert.equal(store.getBambuSession(), null);
  assert.equal(storage.value, null);
});

test('strict startup validation rejects malformed and future state without overwrite', async () => {
  const bambu = { ...BAMBU, savedAt: 1 };
  const session = { idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 1, expiresAt: 2 };
  const cases = [{}, { version: 2, bambu, sessions: [] },
    { version: 1, bambu: { ...bambu, extra: true }, sessions: [] },
    { version: 1, bambu, sessions: [{ ...session, idHash: 'bad' }] },
    { version: 1, bambu, sessions: [{ ...session, extra: true }] },
    { version: 1, bambu, sessions: [session, session] }];
  for (const value of cases) {
    const storage = memoryStorage(value);
    await assert.rejects(createAt(storage, { value: 1 }), /Invalid session store|Unsupported session store version/);
    assert.equal(storage.writes.length, 0);
  }
});

test('encrypted corruption and authentication errors propagate unchanged', async () => {
  const expected = new Error('Unable to authenticate encrypted file: session.enc');
  const storage = memoryStorage();
  storage.readEncrypted = async () => { throw expected; };
  await assert.rejects(createAt(storage, { value: 1 }), (error) => error === expected);
});

test('getBambuSession returns an isolated clone with runtime credentials', async () => {
  const store = await createAt(memoryStorage(), { value: 99 });
  await store.create(BAMBU);
  const first = store.getBambuSession();
  assert.deepEqual(first, { ...BAMBU, savedAt: 99 });
  first.account = 'mutated';
  first.accessToken = 'mutated';
  assert.deepEqual(store.getBambuSession(), { ...BAMBU, savedAt: 99 });
});

test('serializes concurrent creates and retries bounded hash collisions', async () => {
  const storage = memoryStorage();
  const random = byteGenerator({ collide: 2 });
  const store = await createAt(storage, { value: 1 }, random);
  const created = await Promise.all([store.create(BAMBU), store.create(BAMBU), store.create(BAMBU)]);
  assert.equal(new Set(created.map(({ sessionId }) => sessionId)).size, 3);
  assert.equal(storage.value.sessions.length, 3);
  assert.equal(storage.maxActiveWrites, 1);
  assert.equal(random.calls, 5);
});

test('validates dependencies, bounded strings, time, and exact random output', async () => {
  await assert.rejects(createSessionStore({ storage: {} }), /Invalid session store dependencies/);
  await assert.rejects(createSessionStore({ storage: memoryStorage(), now: 1 }), /Invalid session store dependencies/);
  const store = await createAt(memoryStorage(), { value: 1 });
  for (const input of [null, {}, { ...BAMBU, account: '' }, { ...BAMBU, account: 'x'.repeat(321) },
    { ...BAMBU, username: 'x'.repeat(257) }, { ...BAMBU, accessToken: '' },
    { ...BAMBU, accessToken: 'x'.repeat(16_385) }]) {
    await assert.rejects(store.create(input), /Invalid session input/);
  }
  for (const badRandom of [() => Buffer.alloc(31), () => new Uint8Array(32)]) {
    const candidate = await createAt(memoryStorage(), { value: 1 }, { randomBytes: badRandom });
    await assert.rejects(candidate.create(BAMBU), /Invalid session randomness/);
  }
  const badClock = await createSessionStore({ storage: memoryStorage(), now: () => Number.NaN });
  await assert.rejects(badClock.create(BAMBU), /Invalid session time/);
});
