const fs = require('node:fs');
const path = require('node:path');

const {
  createAccountRecord,
  toPublicAccount,
  updateAccountRecord,
  validateAccountRecord,
} = require('../core/account-records.cjs');
const { getAuthSessionPath, readAuthSession } = require('./auth-session.cjs');

const ACCOUNT_STORE_FILE = 'bambu-accounts.json';
const REPOSITORY_VERSION = 1;
const MAX_ACCOUNTS = 50;

class AccountStoreRecoverableError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AccountStoreRecoverableError';
    this.code = 'BAMBU_ACCOUNT_STORE_RECOVERABLE';
  }
}

function getAccountStorePath(userDataPath) {
  return path.join(userDataPath, ACCOUNT_STORE_FILE);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateRepository(value) {
  if (!hasExactKeys(value, ['version', 'accounts']) || value.version !== REPOSITORY_VERSION || !Array.isArray(value.accounts)) {
    throw new AccountStoreRecoverableError('Invalid Bambu account repository');
  }
  if (value.accounts.length > MAX_ACCOUNTS) {
    throw new AccountStoreRecoverableError('Too many Bambu accounts');
  }

  const accountIds = new Set();
  const accounts = new Set();
  const validated = value.accounts.map((record) => {
    try {
      return validateAccountRecord(record);
    } catch (error) {
      throw new AccountStoreRecoverableError('Invalid Bambu account repository', error);
    }
  });
  for (const record of validated) {
    if (accountIds.has(record.accountId) || accounts.has(record.account)) {
      throw new AccountStoreRecoverableError('Duplicate Bambu account repository entry');
    }
    accountIds.add(record.accountId);
    accounts.add(record.account);
  }
  return { version: REPOSITORY_VERSION, accounts: validated };
}

function canProtect(protection) {
  return typeof protection?.protect === 'function';
}

function canUnprotect(protection) {
  return typeof protection?.unprotect === 'function';
}

function serializeRepository(repository, protection) {
  const validated = validateRepository(repository);
  if (!canProtect(protection)) return JSON.stringify(validated, null, 2);

  const protectedValue = protection.protect(JSON.stringify(validated));
  return JSON.stringify({
    version: REPOSITORY_VERSION,
    protected: true,
    payload: Buffer.from(protectedValue).toString('base64'),
  }, null, 2);
}

function parseRepository(raw, protection) {
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (error) {
    throw new AccountStoreRecoverableError('Unable to read Bambu account repository', error);
  }

  if (stored?.protected === true) {
    if (!hasExactKeys(stored, ['version', 'protected', 'payload'])
      || stored.version !== REPOSITORY_VERSION
      || typeof stored.payload !== 'string'
      || !stored.payload
      || !canUnprotect(protection)) {
      throw new AccountStoreRecoverableError('Unable to decrypt Bambu account repository');
    }
    try {
      const decrypted = protection.unprotect(Buffer.from(stored.payload, 'base64'));
      return validateRepository(JSON.parse(decrypted));
    } catch (error) {
      if (error instanceof AccountStoreRecoverableError) throw error;
      throw new AccountStoreRecoverableError('Unable to decrypt Bambu account repository', error);
    }
  }

  return validateRepository(stored);
}

function createAccountStore({ userDataPath, protection = null, randomId, now } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new TypeError('Account store requires a user data path');
  }
  if (randomId !== undefined && typeof randomId !== 'function') {
    throw new TypeError('Account store randomId must be a function');
  }
  if (now !== undefined && typeof now !== 'function') {
    throw new TypeError('Account store now must be a function');
  }

  const accountStorePath = getAccountStorePath(userDataPath);
  const getNow = now || (() => Date.now());
  let temporaryCounter = 0;

  function readRepository() {
    try {
      return parseRepository(fs.readFileSync(accountStorePath, 'utf8'), protection);
    } catch (error) {
      if (error instanceof AccountStoreRecoverableError) throw error;
      throw new AccountStoreRecoverableError('Unable to read Bambu account repository', error);
    }
  }

  function writeRepository(repository) {
    const serialized = serializeRepository(repository, protection);
    const temporaryPath = `${accountStorePath}.${process.pid}.${Date.now()}.${temporaryCounter += 1}.tmp`;
    let descriptor;
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, accountStorePath);
      return readRepository();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  function migrateLegacySession() {
    const session = readAuthSession(userDataPath, protection);
    if (!session) return { version: REPOSITORY_VERSION, accounts: [] };
    const repository = {
      version: REPOSITORY_VERSION,
      accounts: [createAccountRecord(session, {
        randomId,
        timestamp: session.savedAt,
      })],
    };
    const written = writeRepository(repository);
    fs.rmSync(getAuthSessionPath(userDataPath));
    return written;
  }

  let repository = fs.existsSync(accountStorePath)
    ? readRepository()
    : migrateLegacySession();

  function commit(accounts) {
    const written = writeRepository({ version: REPOSITORY_VERSION, accounts });
    repository = written;
  }

  function listAccounts() {
    return repository.accounts.map(toPublicAccount);
  }

  function getPrivateAccounts() {
    return repository.accounts.map((record) => ({ ...record }));
  }

  function getPrivateAccount(accountId) {
    const record = repository.accounts.find((item) => item.accountId === accountId);
    return record ? { ...record } : null;
  }

  function addAccount(input) {
    const account = String(input?.account ?? '').trim();
    const index = repository.accounts.findIndex((record) => record.account === account);
    if (index >= 0) {
      const updated = updateAccountRecord(repository.accounts[index], input, { timestamp: getNow() });
      const accounts = [...repository.accounts];
      accounts[index] = updated;
      commit(accounts);
      return toPublicAccount(updated);
    }
    if (repository.accounts.length >= MAX_ACCOUNTS) {
      throw new RangeError('Bambu account limit reached');
    }
    const record = createAccountRecord(input, { randomId, timestamp: getNow() });
    commit([...repository.accounts, record]);
    return toPublicAccount(record);
  }

  function updateRemark(accountId, remark) {
    const index = repository.accounts.findIndex((record) => record.accountId === accountId);
    if (index < 0) return null;
    const updated = updateAccountRecord(repository.accounts[index], { remark }, { timestamp: getNow() });
    const accounts = [...repository.accounts];
    accounts[index] = updated;
    commit(accounts);
    return toPublicAccount(updated);
  }

  function reauthenticateAccount(accountId, input) {
    const index = repository.accounts.findIndex((record) => record.accountId === accountId);
    if (index < 0) return null;
    const updated = updateAccountRecord(repository.accounts[index], input, { timestamp: getNow() });
    const accounts = [...repository.accounts];
    accounts[index] = updated;
    commit(accounts);
    return toPublicAccount(updated);
  }

  function removeAccount(accountId) {
    const index = repository.accounts.findIndex((record) => record.accountId === accountId);
    if (index < 0) return null;
    const removed = repository.accounts[index];
    commit(repository.accounts.filter((_, currentIndex) => currentIndex !== index));
    return toPublicAccount(removed);
  }

  function clear() {
    commit([]);
  }

  return {
    listAccounts,
    getPrivateAccounts,
    getPrivateAccount,
    addAccount,
    updateRemark,
    reauthenticateAccount,
    removeAccount,
    clear,
  };
}

module.exports = {
  ACCOUNT_STORE_FILE,
  AccountStoreRecoverableError,
  MAX_ACCOUNTS,
  createAccountStore,
  getAccountStorePath,
};
