import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStorage } from './storage.js';
import { createSessionStore } from './session-store.js';

const require = createRequire(import.meta.url);
const { createAccountRecord } = require('../core/account-records.cjs');

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;
const BAMBU = { account: 'maker@example.test', accessToken: '  opaque-access-token\t', username: 'Maker' };
const SECOND = { account: 'second@example.test', accessToken: 'second-token', username: 'Second' };

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

function accountIdGenerator() {
  let call = 0;
  return () => `account-${++call}`;
}

async function createAt(storage, clock, options = {}) {
  return createSessionStore({
    storage,
    now: () => clock.value,
    randomBytes: options.randomBytes ?? byteGenerator().randomBytes,
    randomId: options.randomId ?? accountIdGenerator(),
    cryptoApi: options.cryptoApi,
  });
}

function sessionFor(sessionId, timestamp = 1) {
  return {
    idHash: createHash('sha256').update(sessionId).digest('hex'),
    createdAt: timestamp,
    lastSeenAt: timestamp,
    expiresAt: timestamp + MONTH,
  };
}

function account(input, accountId, timestamp = 1) {
  return createAccountRecord(input, { accountId, timestamp });
}

test('migrates encrypted v1 bambu state to an exact v2 repository and preserves browser sessions', async () => {
  const rawSessionId = Buffer.alloc(32, 9).toString('base64url');
  const storage = memoryStorage({
    version: 1,
    bambu: { ...BAMBU, savedAt: 50 },
    sessions: [sessionFor(rawSessionId, 50)],
  });
  const store = await createAt(storage, { value: 100 });

  assert.deepEqual(store.listAccounts(), [{
    accountId: 'account-1', accountMasked: 'm***@example.test', remark: '',
    label: 'm***@example.test', savedAt: 50, updatedAt: 50,
  }]);
  assert.deepEqual(store.getPrivateAccount('account-1'), account(BAMBU, 'account-1', 50));
  assert.notEqual(await store.authenticate(rawSessionId), null);
  assert.deepEqual(storage.value, {
    version: 2,
    accounts: [account(BAMBU, 'account-1', 50)],
    sessions: [sessionFor(rawSessionId, 50)],
  });
});

test('migration write failures reject startup while the valid v1 state remains recoverable', async () => {
  const legacy = { version: 1, bambu: { ...BAMBU, savedAt: 50 }, sessions: [] };
  const storage = memoryStorage(legacy);
  storage.writeError = new Error('migration write failed');

  await assert.rejects(createAt(storage, { value: 100 }), /migration write failed/);
  assert.deepEqual(storage.value, legacy);
  storage.writeError = null;
  assert.equal((await createAt(storage, { value: 100 })).listAccounts().length, 1);
});

test('post-commit migration errors leave a reconciled v2 repository on disk', async () => {
  const storage = memoryStorage({ version: 1, bambu: { ...BAMBU, savedAt: 50 }, sessions: [] });
  const error = new Error('migration directory sync failed');
  storage.writeAfterCommitError = error;

  await assert.rejects(createAt(storage, { value: 100 }), (actual) => actual === error);
  storage.writeAfterCommitError = null;
  const restarted = await createAt(storage, { value: 100 });
  assert.equal(restarted.listAccounts().length, 1);
  assert.equal(storage.value.version, 2);
});

test('account APIs expose isolated public/private records and preserve insertion order', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 100 });
  const first = await store.addAccount({ ...BAMBU, remark: 'Workshop' });
  const second = await store.addAccount({ ...SECOND, remark: 'Fleet' });

  assert.deepEqual(store.listAccounts().map(({ accountId, label }) => ({ accountId, label })), [
    { accountId: first.accountId, label: 'Workshop' },
    { accountId: second.accountId, label: 'Fleet' },
  ]);
  assert.equal(JSON.stringify(store.listAccounts()).includes(BAMBU.accessToken), false);
  assert.deepEqual((await store.authenticate(Buffer.alloc(32, 7).toString('base64url'))), null);
  assert.equal(storage.value.sessions.length, 0);
  first.remark = 'mutated';
  assert.equal(store.listAccounts()[0].remark, 'Workshop');
  const privateAccount = store.getPrivateAccount(first.accountId);
  privateAccount.accessToken = 'mutated';
  assert.equal(store.getPrivateAccount(first.accountId).accessToken, BAMBU.accessToken);
  const privateAccounts = store.getPrivateAccounts();
  privateAccounts[0].account = 'mutated';
  assert.equal(store.getPrivateAccounts()[0].account, BAMBU.account);
  assert.equal(store.getPrivateAccount('missing'), null);
});

test('duplicate raw identities refresh credentials, preserve omitted remarks, and explicit blanks clear remarks', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 100 });
  const first = await store.addAccount({ ...BAMBU, remark: 'Workshop' });
  const duplicate = await store.addAccount({ ...BAMBU, accessToken: 'fresh-token', username: 'Fresh' });

  assert.equal(duplicate.accountId, first.accountId);
  assert.equal(duplicate.remark, 'Workshop');
  assert.equal(store.getPrivateAccount(first.accountId).accessToken, 'fresh-token');
  const cleared = await store.updateRemark(first.accountId, '  ');
  assert.equal(cleared.remark, '');
  assert.equal(storage.value.accounts.length, 1);
});

test('reauthentication rejects identity swaps but completes one legacy token-only account', async () => {
  const legacy = account({ account: '', accessToken: 'legacy-token', username: '' }, 'legacy', 10);
  const store = await createAt(memoryStorage({ version: 2, accounts: [legacy], sessions: [] }), { value: 20 });

  const completed = await store.reauthenticateAccount('legacy', { ...BAMBU, remark: 'ignored' });
  assert.equal(completed.accountId, 'legacy');
  assert.equal(completed.remark, 'ignored');
  await assert.rejects(
    store.reauthenticateAccount('legacy', { ...SECOND }),
    /different account/,
  );
});

test('adding, updating, and removing non-final accounts keeps browser sessions valid', async () => {
  const store = await createAt(memoryStorage(), { value: 100 });
  const browser = await store.create(BAMBU);
  const second = await store.addAccount({ ...SECOND, remark: 'Fleet' });
  await store.reauthenticateAccount(second.accountId, { ...SECOND, username: 'Fresh second' });
  await store.updateRemark(second.accountId, 'Renamed fleet');
  await store.removeAccount(second.accountId);

  assert.notEqual(await store.authenticate(browser.sessionId), null);
  assert.equal(store.listAccounts().length, 1);
});

test('removing the final account removes encrypted state and all browser authentication', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 100 });
  const browser = await store.create(BAMBU);
  const [first] = store.listAccounts();

  await store.removeAccount(first.accountId);
  assert.equal(storage.value, null);
  assert.equal(await store.authenticate(browser.sessionId), null);
  assert.equal(store.getBambuSession(), null);
});

test('create remains login-compatible by upserting an account and creating browsers without cross-account invalidation', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 100 });
  const first = await store.create(BAMBU);
  const second = await store.create({ ...SECOND, remark: 'Fleet' });
  const refreshed = await store.create({ ...BAMBU, accessToken: 'fresh-token', username: 'Fresh' });

  assert.equal(first.account, BAMBU.account);
  assert.equal(refreshed.account, BAMBU.account);
  assert.equal(store.listAccounts().length, 2);
  assert.equal(store.getPrivateAccounts()[0].accessToken, 'fresh-token');
  assert.notEqual(await store.authenticate(first.sessionId), null);
  assert.notEqual(await store.authenticate(second.sessionId), null);
  assert.notEqual(await store.authenticate(refreshed.sessionId), null);
  assert.equal(storage.value.sessions.length, 3);
});

test('browser authentication remains hashed, timing-safe, renewable, and never returns account tokens', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock, byteGenerator());
  const created = await store.create(BAMBU);
  const authenticated = await store.authenticate(created.sessionId);

  assert.equal(Buffer.from(created.sessionId, 'base64url').length, 32);
  assert.equal(Buffer.from(created.csrfToken, 'base64url').length, 32);
  assert.deepEqual(Object.keys(authenticated).sort(), ['accountMasked', 'csrfToken', 'expiresAt', 'username']);
  assert.equal(JSON.stringify(authenticated).includes(BAMBU.accessToken), false);
  assert.equal(JSON.stringify(storage.value).includes(created.sessionId), false);
  assert.equal(JSON.stringify(storage.value).includes(created.csrfToken), false);
  assert.equal(await store.authenticate('not-a-session-id'), null);
  assert.equal(await store.authenticate(Buffer.alloc(32, 99).toString('base64url')), null);
  clock.value += DAY;
  const renewed = await store.authenticate(created.sessionId, { renew: true });
  assert.equal(renewed.expiresAt, clock.value + MONTH);
  assert.equal(storage.value.sessions[0].lastSeenAt, clock.value);
});

test('CSRF stays stable for a browser, differs across browsers, and renewal avoids excess writes', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock, byteGenerator());
  const first = await store.create(BAMBU);
  const second = await store.create(BAMBU);

  assert.notEqual(first.csrfToken, second.csrfToken);
  assert.equal((await store.authenticate(first.sessionId)).csrfToken, first.csrfToken);
  assert.equal((await store.authenticate(first.sessionId)).csrfToken, first.csrfToken);
  clock.value += DAY - 1;
  assert.equal((await store.authenticate(first.sessionId, { renew: true })).expiresAt, first.expiresAt);
  assert.equal(storage.writes.length, 2);
  clock.value += 1;
  assert.equal((await store.authenticate(first.sessionId, { renew: true })).expiresAt, clock.value + MONTH);
  assert.equal(storage.writes.length, 3);
});

test('browser session generation retries collisions and deterministically evicts the oldest session', async () => {
  const storage = memoryStorage();
  const values = [7, 7, 8];
  let calls = 0;
  const randomBytes = (length) => Buffer.alloc(length, values[calls++]);
  const store = await createAt(storage, { value: 100 }, { randomBytes });
  const original = await store.create(BAMBU);
  const replacement = await store.create(SECOND);

  assert.equal(calls, 3);
  assert.notEqual(replacement.sessionId, original.sessionId);
  assert.notEqual(await store.authenticate(original.sessionId), null);
  assert.notEqual(await store.authenticate(replacement.sessionId), null);

  const evictionStorage = memoryStorage();
  let evictionCalls = 0;
  const evictionRandom = (length) => Buffer.alloc(length, evictionCalls++ < 20 ? evictionCalls : 0);
  const evictionStore = await createAt(evictionStorage, { value: 1_000 }, { randomBytes: evictionRandom });
  for (let index = 0; index < 20; index += 1) await evictionStore.create(BAMBU);
  const lowestExistingHash = evictionStorage.value.sessions.map(({ idHash }) => idHash).sort()[0];
  const expectedId = Buffer.alloc(32).toString('base64url');
  const expectedHash = createHash('sha256').update(expectedId).digest('hex');
  assert.ok(expectedHash < lowestExistingHash);
  const newest = await evictionStore.create(BAMBU);
  assert.equal(newest.sessionId, expectedId);
  assert.notEqual(await evictionStore.authenticate(newest.sessionId), null);
});

test('startup and authentication prune expired browser sessions without rewriting clean state', async () => {
  const activeId = Buffer.alloc(32, 1).toString('base64url');
  const expiredId = Buffer.alloc(32, 2).toString('base64url');
  const state = {
    version: 2,
    accounts: [account(BAMBU, 'first', 1)],
    sessions: [sessionFor(activeId, 501), sessionFor(expiredId, 500)],
  };
  const storage = memoryStorage(state);
  await createAt(storage, { value: MONTH + 500 });
  assert.deepEqual(storage.value.sessions, [sessionFor(activeId, 501)]);
  assert.equal(storage.writes.length, 1);
  const cleanStorage = memoryStorage(storage.value);
  await createAt(cleanStorage, { value: MONTH + 500 });
  assert.equal(cleanStorage.writes.length, 0);
});

test('limits browser sessions deterministically while preserving multiple accounts', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock, byteGenerator());
  await store.addAccount(SECOND);
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
  assert.equal(store.listAccounts().length, 2);
});

test('account and browser mutations serialize, persist first, and reconcile failed writes', async () => {
  const storage = memoryStorage();
  const clock = { value: 1_000 };
  const store = await createAt(storage, clock);
  const [first, second] = await Promise.all([
    store.addAccount(BAMBU),
    store.addAccount(SECOND),
  ]);
  assert.equal(storage.maxActiveWrites, 1);
  const browser = await store.create(BAMBU);
  const failedWrite = new Error('write failed before commit');
  storage.writeError = failedWrite;
  await assert.rejects(store.updateRemark(first.accountId, 'changed'), (error) => error === failedWrite);
  assert.equal(store.listAccounts()[0].remark, '');
  storage.writeError = null;
  clock.value += DAY;
  const postCommit = new Error('directory sync failed');
  storage.writeAfterCommitError = postCommit;
  await assert.rejects(store.reauthenticateAccount(second.accountId, { ...SECOND, username: 'Updated' }), (error) => error === postCommit);
  storage.writeAfterCommitError = null;
  const restarted = await createAt(storage, clock);
  assert.equal(store.getPrivateAccount(second.accountId).username, restarted.getPrivateAccount(second.accountId).username);
  assert.notEqual(await restarted.authenticate(browser.sessionId), null);
});

test('clear removes disk before memory and reconciles post-commit removal errors', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 1 });
  const browser = await store.create(BAMBU);
  const failedRemove = new Error('remove failed before commit');
  storage.removeError = failedRemove;
  await assert.rejects(store.clear(), (error) => error === failedRemove);
  assert.notEqual(await store.authenticate(browser.sessionId), null);
  storage.removeError = null;
  const postCommit = new Error('remove directory sync failed');
  storage.removeAfterCommitError = postCommit;
  await assert.rejects(store.clear(), (error) => error === postCommit);
  assert.equal(store.getBambuSession(), null);
  assert.equal(await store.authenticate(browser.sessionId), null);
});

test('strict validation rejects malformed, duplicate, oversize, and unsupported encrypted states without overwrite', async () => {
  const validAccount = account(BAMBU, 'first', 1);
  const validSession = sessionFor(Buffer.alloc(32, 4).toString('base64url'), 1);
  const manyAccounts = Array.from({ length: 51 }, (_, index) => account(
    { ...BAMBU, account: `user-${index}@example.test` }, `account-${index}`, 1,
  ));
  const cases = [
    {},
    { version: 3, accounts: [validAccount], sessions: [] },
    { version: 2, accounts: [], sessions: [] },
    { version: 2, accounts: [validAccount, { ...validAccount, accountId: 'second' }], sessions: [] },
    { version: 2, accounts: [validAccount, { ...validAccount, account: 'other@example.test' }], sessions: [] },
    { version: 2, accounts: [account({ account: '', accessToken: 'one' }, 'empty-one'), account({ account: '', accessToken: 'two' }, 'empty-two')], sessions: [] },
    { version: 2, accounts: manyAccounts, sessions: [] },
    { version: 2, accounts: [validAccount], sessions: [{ ...validSession, idHash: 'bad' }] },
    { version: 2, accounts: [validAccount], sessions: [validSession, validSession] },
    { version: 1, bambu: { ...BAMBU, savedAt: 1, extra: true }, sessions: [] },
  ];
  for (const value of cases) {
    const storage = memoryStorage(value);
    await assert.rejects(createAt(storage, { value: 1 }), /Invalid session store|Unsupported session store version/);
    assert.equal(storage.writes.length, 0);
    assert.deepEqual(storage.value, value);
  }
});

test('strict validation rejects non-30-day expiry and timestamp overflow without overwrite', async () => {
  const baseSession = {
    idHash: 'a'.repeat(64), createdAt: 1, lastSeenAt: 10,
  };
  const cases = [
    { ...baseSession, expiresAt: baseSession.lastSeenAt + MONTH - 1 },
    { ...baseSession, expiresAt: baseSession.lastSeenAt + MONTH + 1 },
    {
      ...baseSession,
      lastSeenAt: Number.MAX_SAFE_INTEGER - MONTH + 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  ];
  for (const session of cases) {
    const state = { version: 2, accounts: [account(BAMBU, 'first', 1)], sessions: [session] };
    const storage = memoryStorage(state);
    await assert.rejects(createAt(storage, { value: 1 }), /Invalid session store/);
    assert.deepEqual(storage.value, state);
    assert.equal(storage.writes.length, 0);
  }
});

test('rejects an account limit overflow without mutating the committed repository', async () => {
  const storage = memoryStorage();
  const store = await createAt(storage, { value: 1 });
  for (let index = 0; index < 50; index += 1) {
    await store.addAccount({ ...BAMBU, account: `user-${index}@example.test` });
  }
  await assert.rejects(store.addAccount({ ...BAMBU, account: 'one-too-many@example.test' }), /Account limit reached/);
  assert.equal(storage.value.accounts.length, 50);
});

test('real encrypted storage hides every raw account, token, and browser ID across restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-session-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const clock = { value: 50_000 };
  const storage = await createStorage({ dataDir });
  const first = await createAt(storage, clock);
  const browser = await first.create({ ...BAMBU, remark: 'Workshop' });
  await first.addAccount({ ...SECOND, remark: 'Fleet' });
  const disk = await fs.readFile(path.join(dataDir, 'session.enc'), 'utf8');
  for (const secret of [BAMBU.account, BAMBU.accessToken, SECOND.account, SECOND.accessToken, browser.sessionId]) {
    assert.equal(disk.includes(secret), false);
  }

  const restarted = await createAt(await createStorage({ dataDir }), clock);
  assert.deepEqual(restarted.listAccounts().map(({ remark }) => remark), ['Workshop', 'Fleet']);
  assert.deepEqual(restarted.getPrivateAccounts().map(({ accessToken }) => accessToken), [BAMBU.accessToken, SECOND.accessToken]);
  assert.notEqual(await restarted.authenticate(browser.sessionId), null);
});

test('getBambuSession is an isolated first-account compatibility adapter', async () => {
  const store = await createAt(memoryStorage(), { value: 99 });
  await store.addAccount(BAMBU);
  await store.addAccount(SECOND);
  const first = store.getBambuSession();
  assert.equal(first.account, BAMBU.account);
  first.accessToken = 'mutated';
  assert.equal(store.getBambuSession().accessToken, BAMBU.accessToken);
});

test('encrypted corruption and failed-write reconciliation preserve the original errors and committed memory', async () => {
  const expected = new Error('Unable to authenticate encrypted file: session.enc');
  const unreadable = memoryStorage();
  unreadable.readEncrypted = async () => { throw expected; };
  await assert.rejects(createAt(unreadable, { value: 1 }), (error) => error === expected);

  const storage = memoryStorage();
  const store = await createAt(storage, { value: 1_000 });
  const browser = await store.create(BAMBU);
  const writeError = new Error('write failed before commit');
  storage.writeError = writeError;
  storage.readError = new Error('reconciliation read failed');
  await assert.rejects(store.create(BAMBU), (error) => error === writeError);
  assert.equal(storage.readCalls, 2);
  assert.notEqual(await store.authenticate(browser.sessionId), null);
});

test('validates dependencies, inputs, time, and exact browser randomness', async () => {
  await assert.rejects(createSessionStore({ storage: {} }), /Invalid session store dependencies/);
  await assert.rejects(createSessionStore({ storage: memoryStorage(), now: 1 }), /Invalid session store dependencies/);
  const store = await createAt(memoryStorage(), { value: 1 });
  for (const input of [null, {}, { ...BAMBU, account: '' }, { ...BAMBU, account: 'x'.repeat(321) },
    { ...BAMBU, username: null }, { ...BAMBU, username: 'x'.repeat(257) }, { ...BAMBU, accessToken: '' },
    { ...BAMBU, accessToken: 'x'.repeat(16_385) }]) {
    await assert.rejects(store.addAccount(input), /Invalid account input/);
  }
  for (const badRandom of [() => Buffer.alloc(31), () => new Uint8Array(32)]) {
    const candidate = await createAt(memoryStorage(), { value: 1 }, { randomBytes: badRandom });
    await assert.rejects(candidate.create(BAMBU), /Invalid session randomness/);
  }
  const badClock = await createSessionStore({ storage: memoryStorage(), now: () => Number.NaN });
  await assert.rejects(badClock.addAccount(BAMBU), /Invalid session time/);
});
