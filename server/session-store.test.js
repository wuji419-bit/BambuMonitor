import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  let readError = null;
  let writeError = null;
  let writeAfterCommitError = null;
  let removeError = null;
  let removeAfterCommitError = null;
  let readCalls = 0;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  return {
    key: Buffer.alloc(32, 0x5a), writes,
    get value() { return value === null ? null : structuredClone(value); },
    set readError(error) { readError = error; },
    set writeError(error) { writeError = error; },
    set writeAfterCommitError(error) { writeAfterCommitError = error; },
    set removeError(error) { removeError = error; },
    set removeAfterCommitError(error) { removeAfterCommitError = error; },
    get readCalls() { return readCalls; },
    get maxActiveWrites() { return maxActiveWrites; },
    getSecretKey() { return Buffer.from(this.key); },
    async readEncrypted(name) {
      assert.equal(name, 'session.enc');
      readCalls += 1;
      if (readError) throw readError;
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
        if (writeAfterCommitError) throw writeAfterCommitError;
      } finally { activeWrites -= 1; }
    },
    async remove(name) {
      assert.equal(name, 'session.enc');
      if (removeError) throw removeError;
      value = null;
      if (removeAfterCommitError) throw removeAfterCommitError;
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
  const clock = { value: MONTH + 500 };
  const active = { idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 501, expiresAt: MONTH + 501 };
  const expired = { idHash: 'b'.repeat(64), createdAt: 1, lastSeenAt: 500, expiresAt: MONTH + 500 };
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

test('cross-account login retries a colliding ID while invalidating the prior account session', async () => {
  const storage = memoryStorage();
  const values = [7, 7, 8];
  let calls = 0;
  const randomBytes = (length) => Buffer.alloc(length, values[calls++]);
  const store = await createAt(storage, { value: 100 }, { randomBytes });
  const original = await store.create(BAMBU);
  const replacement = await store.create({ ...BAMBU, account: 'other@example.test' });

  assert.equal(calls, 3);
  assert.notEqual(replacement.sessionId, original.sessionId);
  assert.equal(await store.authenticate(original.sessionId), null);
  assert.notEqual(await store.authenticate(replacement.sessionId), null);
});

test('same account preserves browser sessions when the Bambu username changes', async () => {
  const storage = memoryStorage();
  const clock = { value: 100 };
  const store = await createAt(storage, clock);
  const original = await store.create(BAMBU);
  clock.value += 1;
  const renamed = await store.create({ ...BAMBU, username: 'Renamed Maker' });

  assert.equal((await store.authenticate(original.sessionId)).username, 'Renamed Maker');
  assert.notEqual(await store.authenticate(renamed.sessionId), null);
  assert.equal(storage.value.sessions.length, 2);
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

test('post-commit create and renewal errors reconcile live memory with restart state', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const random = byteGenerator();
  const store = await createAt(storage, clock, random);
  const sessionId = Buffer.alloc(32, 1).toString('base64url');
  const createError = new Error('create directory sync failed');
  storage.writeAfterCommitError = createError;

  await assert.rejects(store.create(BAMBU), (error) => error === createError);
  storage.writeAfterCommitError = null;
  const afterCreate = await createAt(storage, clock);
  assert.deepEqual(await store.authenticate(sessionId), await afterCreate.authenticate(sessionId));

  clock.value += DAY;
  const renewalError = new Error('renew directory sync failed');
  storage.writeAfterCommitError = renewalError;
  await assert.rejects(store.authenticate(sessionId, { renew: true }), (error) => error === renewalError);
  storage.writeAfterCommitError = null;
  const afterRenewal = await createAt(storage, clock);
  assert.deepEqual(await store.authenticate(sessionId), await afterRenewal.authenticate(sessionId));
});

test('post-commit prune and clear errors reconcile live memory with restart state', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock);
  const expired = await store.create(BAMBU);
  clock.value += DAY;
  const active = await store.create(BAMBU);
  clock.value = expired.expiresAt;

  const pruneError = new Error('prune directory sync failed');
  storage.writeAfterCommitError = pruneError;
  const unknownId = Buffer.alloc(32, 99).toString('base64url');
  await assert.rejects(store.authenticate(unknownId), (error) => error === pruneError);
  storage.writeAfterCommitError = null;
  const afterPrune = await createAt(storage, clock);
  assert.equal(await store.authenticate(expired.sessionId), null);
  assert.deepEqual(await store.authenticate(active.sessionId), await afterPrune.authenticate(active.sessionId));

  const clearError = new Error('clear directory sync failed');
  storage.removeAfterCommitError = clearError;
  await assert.rejects(store.clear(), (error) => error === clearError);
  storage.removeAfterCommitError = null;
  const afterClear = await createAt(storage, clock);
  assert.equal(store.getBambuSession(), null);
  assert.equal(afterClear.getBambuSession(), null);
  assert.equal(await store.authenticate(active.sessionId), null);
});

test('mutation reconciliation keeps known memory and original error when reread fails', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 1_000 });
  const created = await store.create(BAMBU);
  const originalError = new Error('write failed before commit');
  storage.writeError = originalError;
  storage.readError = new Error('reconciliation read failed');

  await assert.rejects(store.create(BAMBU), (error) => error === originalError);
  assert.equal(storage.readCalls, 2);
  assert.notEqual(await store.authenticate(created.sessionId), null);
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
  const session = { idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 1, expiresAt: 1 + MONTH };
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

test('strict startup validation rejects non-30-day expiry and timestamp overflow without overwrite', async () => {
  const bambu = { ...BAMBU, savedAt: 1 };
  const baseSession = { idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 10 };
  const cases = [
    { ...baseSession, expiresAt: baseSession.lastSeenAt + MONTH - 1 },
    { ...baseSession, expiresAt: baseSession.lastSeenAt + MONTH + 1 },
    { ...baseSession, lastSeenAt: Number.MAX_SAFE_INTEGER - MONTH + 1,
      expiresAt: Number.MAX_SAFE_INTEGER },
  ];
  for (const session of cases) {
    const state = { version: 1, bambu, sessions: [session] };
    const storage = memoryStorage(state);
    await assert.rejects(createAt(storage, { value: 1 }), /Invalid session store/);
    assert.deepEqual(storage.value, state);
    assert.equal(storage.writes.length, 0);
  }
});

test('create normalizes a missing username to empty and restores it after restart', async () => {
  const storage = memoryStorage();
  const clock = { value: 100 };
  const store = await createAt(storage, clock);
  const created = await store.create({ account: BAMBU.account, accessToken: BAMBU.accessToken });

  assert.equal(storage.value.bambu.username, '');
  assert.equal(store.getBambuSession().username, '');
  const restarted = await createAt(storage, clock);
  assert.equal((await restarted.authenticate(created.sessionId)).username, '');
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

test('new session survives deterministic eviction when all existing timestamps tie', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const randomBytes = (length) => {
    calls += 1;
    return Buffer.alloc(length, calls <= 20 ? calls : 0);
  };
  const store = await createAt(storage, { value: 1_000 }, { randomBytes });
  for (let index = 0; index < 20; index += 1) await store.create(BAMBU);

  const lowestExistingHash = storage.value.sessions
    .map(({ idHash }) => idHash)
    .sort()[0];
  const expectedId = Buffer.alloc(32).toString('base64url');
  const expectedHash = createHash('sha256').update(expectedId).digest('hex');
  assert.ok(expectedHash < lowestExistingHash);

  const created = await store.create(BAMBU);
  assert.equal(created.sessionId, expectedId);
  assert.equal(storage.value.sessions.length, 20);
  assert.notEqual(await store.authenticate(created.sessionId), null);
});

test('validates dependencies, bounded strings, time, and exact random output', async () => {
  await assert.rejects(createSessionStore({ storage: {} }), /Invalid session store dependencies/);
  await assert.rejects(createSessionStore({ storage: memoryStorage(), now: 1 }), /Invalid session store dependencies/);
  const store = await createAt(memoryStorage(), { value: 1 });
  for (const input of [null, {}, { ...BAMBU, account: '' }, { ...BAMBU, account: 'x'.repeat(321) },
    { ...BAMBU, username: null }, { ...BAMBU, username: 'x'.repeat(257) }, { ...BAMBU, accessToken: '' },
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
