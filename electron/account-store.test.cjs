const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AccountStoreRecoverableError,
  createAccountStore,
  getAccountStorePath,
} = require('./account-store.cjs');
const { getAuthSessionPath, writeAuthSession } = require('./auth-session.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bambu-account-store-'));
}

function makeProtectionAdapter(prefix = 'protected:') {
  return {
    protect(value) {
      return Buffer.from(`${prefix}${value}`, 'utf8');
    },
    unprotect(value) {
      const decoded = Buffer.from(value).toString('utf8');
      if (!decoded.startsWith(prefix)) throw new Error('cannot decrypt');
      return decoded.slice(prefix.length);
    },
  };
}

function createStore(dir, options = {}) {
  let nextId = 1;
  let timestamp = 100;
  const store = createAccountStore({
    userDataPath: dir,
    randomId: () => `acc-${nextId += 1}`,
    now: () => timestamp,
    ...options,
  });
  return {
    store,
    setTime(value) { timestamp = value; },
  };
}

test('adds accounts as public records while retaining private credentials internally', () => {
  const store = createAccountStore({
    userDataPath: makeTempDir(),
    randomId: () => 'acc-one',
    now: () => 100,
  });

  const added = store.addAccount({
    account: 'maker@example.com',
    accessToken: 'secret-token',
    username: 'maker',
    remark: 'Workshop',
  });

  assert.deepEqual(added, {
    accountId: 'acc-one',
    accountMasked: 'm***@example.com',
    remark: 'Workshop',
    label: 'Workshop',
    savedAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(store.listAccounts(), [added]);
  assert.equal(store.getPrivateAccount('acc-one').accessToken, 'secret-token');
  assert.equal(JSON.stringify(store.listAccounts()).includes('secret-token'), false);
});

test('protects the entire account repository without leaving account secrets on disk', () => {
  const dir = makeTempDir();
  const protection = makeProtectionAdapter();
  const { store } = createStore(dir, { protection });
  store.addAccount({ account: 'secure@example.com', accessToken: 'secret-token' });

  const raw = fs.readFileSync(getAccountStorePath(dir), 'utf8');
  assert.doesNotMatch(raw, /secure@example\.com|secret-token/);
  assert.deepEqual(createStore(dir, { protection }).store.getPrivateAccounts(), store.getPrivateAccounts());
  assert.equal(JSON.parse(raw).protected, true);
});

test('migrates a plaintext legacy auth session only when the account repository is absent', () => {
  const dir = makeTempDir();
  writeAuthSession(dir, { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 });

  const { store } = createStore(dir);

  assert.equal(store.getPrivateAccounts()[0].account, 'legacy@example.com');
  assert.equal(store.getPrivateAccounts()[0].savedAt, 50);
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), false);
  assert.equal(fs.existsSync(getAccountStorePath(dir)), true);
});

test('migrates a protected legacy auth session into a protected account repository', () => {
  const dir = makeTempDir();
  const protection = makeProtectionAdapter();
  writeAuthSession(dir, { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 }, protection);

  const { store } = createStore(dir, { protection });

  assert.equal(store.getPrivateAccounts()[0].accessToken, 'legacy-token');
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), false);
  assert.doesNotMatch(fs.readFileSync(getAccountStorePath(dir), 'utf8'), /legacy-token/);
});

test('uses the existing account repository instead of a leftover legacy session', () => {
  const dir = makeTempDir();
  const { store } = createStore(dir);
  store.addAccount({ account: 'new@example.com', accessToken: 'new-token' });
  writeAuthSession(dir, { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 });

  assert.deepEqual(createStore(dir).store.getPrivateAccounts().map((account) => account.account), ['new@example.com']);
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), true);
});

test('keeps the legacy session when migration cannot persist the new repository', () => {
  const dir = makeTempDir();
  writeAuthSession(dir, { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk is locked'); };
  try {
    assert.throws(() => createStore(dir), /disk is locked/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.existsSync(getAuthSessionPath(dir)), true);
  assert.equal(fs.existsSync(getAccountStorePath(dir)), false);
});

test('refreshes duplicate accounts in place and only changes an explicitly supplied remark', () => {
  const dir = makeTempDir();
  const { store, setTime } = createStore(dir);
  const first = store.addAccount({
    account: 'same@example.com', accessToken: 'token-one', username: 'first', remark: 'Original',
  });
  setTime(200);
  const refreshed = store.addAccount({ account: 'same@example.com', accessToken: 'token-two', username: 'second' });
  setTime(300);
  const renamed = store.addAccount({ account: 'same@example.com', accessToken: 'token-three', remark: 'Updated' });

  assert.equal(refreshed.accountId, first.accountId);
  assert.equal(refreshed.remark, 'Original');
  assert.equal(renamed.remark, 'Updated');
  assert.deepEqual(store.getPrivateAccounts(), [{
    accountId: first.accountId,
    account: 'same@example.com',
    accountMasked: 's***@example.com',
    remark: 'Updated',
    accessToken: 'token-three',
    username: 'second',
    savedAt: 100,
    updatedAt: 300,
  }]);
});

test('keeps account order stable while updating, reauthenticating, removing, and clearing', () => {
  const { store, setTime } = createStore(makeTempDir());
  const first = store.addAccount({ account: 'first@example.com', accessToken: 'first' });
  const second = store.addAccount({ account: 'second@example.com', accessToken: 'second' });
  setTime(200);
  store.updateRemark(first.accountId, 'First');
  store.reauthenticateAccount(second.accountId, { account: 'second@example.com', accessToken: 'renewed' });

  assert.deepEqual(store.listAccounts().map((account) => account.accountId), [first.accountId, second.accountId]);
  assert.throws(
    () => store.reauthenticateAccount(second.accountId, { account: 'other@example.com', accessToken: 'bad' }),
    /different account/,
  );
  assert.equal(store.removeAccount(first.accountId).accountId, first.accountId);
  assert.deepEqual(store.listAccounts().map((account) => account.accountId), [second.accountId]);
  store.clear();
  assert.deepEqual(store.listAccounts(), []);
});

test('leaves memory and disk unchanged when an atomic mutation fails', () => {
  const dir = makeTempDir();
  const { store } = createStore(dir);
  const account = store.addAccount({ account: 'maker@example.com', accessToken: 'token-one' });
  const beforeDisk = fs.readFileSync(getAccountStorePath(dir), 'utf8');
  const beforeMemory = store.getPrivateAccounts();
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk is locked'); };
  try {
    assert.throws(() => store.updateRemark(account.accountId, 'Blocked'), /disk is locked/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.deepEqual(store.getPrivateAccounts(), beforeMemory);
  assert.equal(fs.readFileSync(getAccountStorePath(dir), 'utf8'), beforeDisk);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('rolls back the repository when post-rename verification fails', () => {
  const dir = makeTempDir();
  const { store } = createStore(dir);
  const account = store.addAccount({ account: 'maker@example.com', accessToken: 'token-one' });
  const repositoryPath = getAccountStorePath(dir);
  const beforeDisk = fs.readFileSync(repositoryPath, 'utf8');
  const beforeMemory = store.getPrivateAccounts();
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filePath, ...args) => {
    const raw = originalReadFileSync(filePath, ...args);
    if (filePath === repositoryPath && Buffer.from(raw).toString('utf8') !== beforeDisk) {
      throw new Error('verification read failed');
    }
    return raw;
  };
  try {
    let error;
    try {
      store.updateRemark(account.accountId, 'Blocked');
    } catch (failure) {
      error = failure;
    }
    assert.match(error.message, /Unable to read Bambu account repository/);
    assert.equal(error.cause.message, 'verification read failed');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(store.getPrivateAccounts(), beforeMemory);
  assert.equal(fs.readFileSync(repositoryPath, 'utf8'), beforeDisk);
  assert.deepEqual(createStore(dir).store.getPrivateAccounts(), beforeMemory);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('surfaces a recoverable error when rollback cannot restore the previous repository', () => {
  const dir = makeTempDir();
  const { store } = createStore(dir);
  const account = store.addAccount({ account: 'maker@example.com', accessToken: 'token-one' });
  const repositoryPath = getAccountStorePath(dir);
  const beforeDisk = fs.readFileSync(repositoryPath, 'utf8');
  const originalReadFileSync = fs.readFileSync;
  const originalRenameSync = fs.renameSync;
  let renameCount = 0;
  fs.readFileSync = (filePath, ...args) => {
    const raw = originalReadFileSync(filePath, ...args);
    if (filePath === repositoryPath && Buffer.from(raw).toString('utf8') !== beforeDisk) {
      throw new Error('verification read failed');
    }
    return raw;
  };
  fs.renameSync = (...args) => {
    renameCount += 1;
    if (renameCount === 2) throw new Error('rollback is locked');
    return originalRenameSync(...args);
  };
  try {
    let error;
    try {
      store.updateRemark(account.accountId, 'Blocked');
    } catch (failure) {
      error = failure;
    }
    assert.ok(error instanceof AccountStoreRecoverableError);
    assert.equal(error.cause.message, 'rollback is locked');
    assert.match(error.verificationError.message, /Unable to read Bambu account repository/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.renameSync = originalRenameSync;
  }
});

test('removes a failed migration candidate after post-rename verification and preserves legacy data', () => {
  const dir = makeTempDir();
  writeAuthSession(dir, { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 });
  const repositoryPath = getAccountStorePath(dir);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filePath, ...args) => {
    const raw = originalReadFileSync(filePath, ...args);
    if (filePath === repositoryPath) throw new Error('verification read failed');
    return raw;
  };
  try {
    assert.throws(() => createStore(dir), /Unable to read Bambu account repository/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(fs.existsSync(repositoryPath), false);
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), true);
});

test('rejects an undecryptable protected legacy session without creating a repository', () => {
  const dir = makeTempDir();
  writeAuthSession(
    dir,
    { account: 'legacy@example.com', accessToken: 'legacy-token', savedAt: 50 },
    makeProtectionAdapter('key-a:'),
  );

  assert.throws(
    () => createStore(dir, { protection: makeProtectionAdapter('key-b:') }),
    (error) => error instanceof AccountStoreRecoverableError && error.code === 'BAMBU_ACCOUNT_STORE_RECOVERABLE',
  );
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), true);
  assert.equal(fs.existsSync(getAccountStorePath(dir)), false);
});

test('throws recoverable errors for corrupt and unknown-version repositories', () => {
  const dir = makeTempDir();
  fs.writeFileSync(getAccountStorePath(dir), '{broken', { mode: 0o600 });
  assert.throws(
    () => createStore(dir),
    (error) => error instanceof AccountStoreRecoverableError && error.code === 'BAMBU_ACCOUNT_STORE_RECOVERABLE',
  );

  fs.writeFileSync(getAccountStorePath(dir), JSON.stringify({ version: 2, accounts: [] }), { mode: 0o600 });
  assert.throws(
    () => createStore(dir),
    (error) => error instanceof AccountStoreRecoverableError && error.code === 'BAMBU_ACCOUNT_STORE_RECOVERABLE',
  );
});

test('throws a recoverable error when protected repository data cannot be decrypted', () => {
  const dir = makeTempDir();
  const { store } = createStore(dir, { protection: makeProtectionAdapter('key-a:') });
  store.addAccount({ account: 'secure@example.com', accessToken: 'secret-token' });

  assert.throws(
    () => createStore(dir, { protection: makeProtectionAdapter('key-b:') }),
    (error) => error instanceof AccountStoreRecoverableError && error.code === 'BAMBU_ACCOUNT_STORE_RECOVERABLE',
  );
});

test('the desktop package registers the account repository and its tests', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.build.files.includes('electron/account-store.cjs'), true);
  assert.match(packageJson.scripts.test, /electron\/account-store\.test\.cjs/);
});
