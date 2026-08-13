import * as defaultCrypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createAccountRecord,
  toPublicAccount,
  updateAccountRecord,
  validateAccountRecord,
} = require('../core/account-records.cjs');

const SESSION_NAME = 'session.enc';
const CURRENT_VERSION = 2;
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const MAX_ACCOUNTS = 50;
const MAX_COLLISION_ATTEMPTS = 8;
const MAX_ACCOUNT_LENGTH = 320;
const MAX_USERNAME_LENGTH = 256;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function namedError(message) {
  return new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readTime(now) {
  const value = now();
  if (!validTimestamp(value) || value > Number.MAX_SAFE_INTEGER - SESSION_TTL_MS) {
    throw namedError('Invalid session time');
  }
  return value;
}

function validateText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateUsername(value) {
  return typeof value === 'string' && value.length <= MAX_USERNAME_LENGTH;
}

function normalizeInput(value, { allowEmptyAccount = false } = {}) {
  const username = isPlainObject(value) && Object.hasOwn(value, 'username') ? value.username : '';
  if (!isPlainObject(value)
    || !validateText(value.account, MAX_ACCOUNT_LENGTH)
    || (!allowEmptyAccount && value.account.trim().length === 0)
    || !validateText(value.accessToken, MAX_ACCESS_TOKEN_LENGTH)
    || value.accessToken.trim().length === 0
    || !validateUsername(username)) {
    throw namedError('Invalid account input');
  }
  const input = { account: value.account, accessToken: value.accessToken, username };
  if (Object.hasOwn(value, 'remark')) input.remark = value.remark;
  return input;
}

function validateLegacyBambu(value) {
  if (!hasExactKeys(value, ['account', 'accessToken', 'username', 'savedAt'])
    || !validateText(value.account, MAX_ACCOUNT_LENGTH)
    || !validateText(value.accessToken, MAX_ACCESS_TOKEN_LENGTH)
    || !validateUsername(value.username)
    || !validTimestamp(value.savedAt)) {
    throw namedError('Invalid session store');
  }
  return { ...value };
}

function validateSession(value) {
  if (!hasExactKeys(value, ['idHash', 'createdAt', 'lastSeenAt', 'expiresAt'])
    || typeof value.idHash !== 'string'
    || !HASH_PATTERN.test(value.idHash)
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.lastSeenAt)
    || !validTimestamp(value.expiresAt)
    || value.lastSeenAt < value.createdAt
    || value.lastSeenAt > Number.MAX_SAFE_INTEGER - SESSION_TTL_MS
    || value.expiresAt !== value.lastSeenAt + SESSION_TTL_MS) {
    throw namedError('Invalid session store');
  }
  return { ...value };
}

function validateSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) {
    throw namedError('Invalid session store');
  }
  const validated = sessions.map(validateSession);
  if (new Set(validated.map(({ idHash }) => idHash)).size !== validated.length) {
    throw namedError('Invalid session store');
  }
  return validated;
}

function validateV1State(value) {
  if (!hasExactKeys(value, ['version', 'bambu', 'sessions']) || value.version !== 1) {
    throw namedError('Invalid session store');
  }
  return { version: 1, bambu: validateLegacyBambu(value.bambu), sessions: validateSessions(value.sessions) };
}

function validateV2State(value) {
  if (!hasExactKeys(value, ['version', 'accounts', 'sessions']) || value.version !== CURRENT_VERSION
    || !Array.isArray(value.accounts) || value.accounts.length === 0 || value.accounts.length > MAX_ACCOUNTS) {
    throw namedError('Invalid session store');
  }
  let accounts;
  try {
    accounts = value.accounts.map(validateAccountRecord);
  } catch {
    throw namedError('Invalid session store');
  }
  const accountIds = new Set(accounts.map(({ accountId }) => accountId));
  const rawAccounts = new Set(accounts.map(({ account }) => account));
  if (accountIds.size !== accounts.length || rawAccounts.size !== accounts.length) {
    throw namedError('Invalid session store');
  }
  return { version: CURRENT_VERSION, accounts, sessions: validateSessions(value.sessions) };
}

function validateLoadedState(value) {
  if (!isPlainObject(value) || !Number.isInteger(value.version)) {
    throw namedError('Invalid session store');
  }
  if (value.version === 1) return validateV1State(value);
  if (value.version === CURRENT_VERSION) return validateV2State(value);
  throw namedError('Unsupported session store version');
}

function validateDependencies(storage, now, randomBytes, randomId, cryptoApi) {
  const storageMethods = ['getSecretKey', 'readEncrypted', 'writeEncrypted', 'remove'];
  const cryptoMethods = ['createHash', 'createHmac', 'timingSafeEqual'];
  if (!storage || storageMethods.some((method) => typeof storage[method] !== 'function')
    || typeof now !== 'function' || typeof randomBytes !== 'function' || typeof randomId !== 'function'
    || !cryptoApi || cryptoMethods.some((method) => typeof cryptoApi[method] !== 'function')) {
    throw namedError('Invalid session store dependencies');
  }
}

function pruneSessions(state, timestamp) {
  if (state === null) return { state, changed: false };
  const sessions = state.sessions.filter(({ expiresAt }) => expiresAt > timestamp);
  return {
    state: sessions.length === state.sessions.length ? state : { ...state, sessions },
    changed: sessions.length !== state.sessions.length,
  };
}

function evictSessions(sessions, limit = MAX_SESSIONS) {
  if (sessions.length <= limit) return sessions;
  const ordered = [...sessions].sort((left, right) => left.lastSeenAt - right.lastSeenAt
    || left.createdAt - right.createdAt || left.idHash.localeCompare(right.idHash));
  const evicted = new Set(ordered.slice(0, sessions.length - limit).map(({ idHash }) => idHash));
  return sessions.filter(({ idHash }) => !evicted.has(idHash));
}

function cloneAccount(account) {
  return account === null ? null : structuredClone(account);
}

export async function createSessionStore({
  storage,
  now = Date.now,
  randomBytes = defaultCrypto.randomBytes,
  randomId = defaultCrypto.randomUUID,
  cryptoApi = defaultCrypto,
}) {
  validateDependencies(storage, now, randomBytes, randomId, cryptoApi);
  const secretKey = storage.getSecretKey();
  if (!Buffer.isBuffer(secretKey) || secretKey.length !== SESSION_BYTES) {
    secretKey?.fill?.(0);
    throw namedError('Invalid session store dependencies');
  }

  function createUniqueAccount(input, timestamp, accounts = []) {
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      let candidate;
      try {
        candidate = createAccountRecord(input, { randomId, timestamp });
      } catch {
        throw namedError('Invalid account input');
      }
      if (!accounts.some(({ accountId }) => accountId === candidate.accountId)) return candidate;
    }
    throw namedError('Unable to create unique account');
  }

  function migrateV1State(legacy) {
    const bambu = legacy.bambu;
    return {
      version: CURRENT_VERSION,
      accounts: [createUniqueAccount({ ...bambu, remark: '' }, bambu.savedAt)],
      sessions: legacy.sessions,
    };
  }

  let state;
  try {
    const loaded = await storage.readEncrypted(SESSION_NAME);
    if (loaded === null) {
      state = null;
    } else {
      const validated = validateLoadedState(loaded);
      if (validated.version === 1) {
        const migrated = migrateV1State(validated);
        try {
          await storage.writeEncrypted(SESSION_NAME, migrated);
        } catch (error) {
          try {
            const onDisk = await storage.readEncrypted(SESSION_NAME);
            if (onDisk !== null) validateV2State(onDisk);
          } catch {
            // The original storage failure communicates the migration outcome.
          }
          throw error;
        }
        state = migrated;
      } else {
        state = validated;
      }
      const timestamp = readTime(now);
      const pruned = pruneSessions(state, timestamp);
      if (pruned.changed) {
        await storage.writeEncrypted(SESSION_NAME, pruned.state);
        state = pruned.state;
      }
    }
  } catch (error) {
    secretKey.fill(0);
    throw error;
  }

  let queue = Promise.resolve();

  function serialize(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function reconcileAfterMutationError(originalError, knownState) {
    try {
      const loaded = await storage.readEncrypted(SESSION_NAME);
      if (loaded === null) {
        state = null;
      } else {
        const validated = validateV2State(loaded);
        state = pruneSessions(validated, readTime(now)).state;
      }
    } catch {
      state = knownState;
    }
    throw originalError;
  }

  async function persistState(candidate) {
    const knownState = state;
    try {
      await storage.writeEncrypted(SESSION_NAME, candidate);
    } catch (error) {
      await reconcileAfterMutationError(error, knownState);
    }
    state = candidate;
  }

  async function removeState() {
    const knownState = state;
    try {
      await storage.remove(SESSION_NAME);
    } catch (error) {
      await reconcileAfterMutationError(error, knownState);
    }
    state = null;
  }

  function hashSessionId(sessionId) {
    let bytes;
    try {
      bytes = Buffer.from(sessionId, 'utf8');
      return cryptoApi.createHash('sha256').update(bytes).digest('hex');
    } finally {
      bytes?.fill(0);
    }
  }

  function csrfFor(sessionId) {
    let input;
    try {
      input = Buffer.from(`csrf:${sessionId}`, 'utf8');
      return cryptoApi.createHmac('sha256', secretKey).update(input).digest('base64url');
    } finally {
      input?.fill(0);
    }
  }

  function parseSessionId(value) {
    if (typeof value !== 'string') return null;
    let bytes;
    try {
      bytes = Buffer.from(value, 'base64url');
      if (bytes.length !== SESSION_BYTES || bytes.toString('base64url') !== value) return null;
      return value;
    } catch {
      return null;
    } finally {
      bytes?.fill(0);
    }
  }

  function findSession(sessions, idHash) {
    const candidate = Buffer.from(idHash, 'hex');
    try {
      return sessions.find((session) => {
        const persisted = Buffer.from(session.idHash, 'hex');
        try {
          return persisted.length === candidate.length && cryptoApi.timingSafeEqual(persisted, candidate);
        } finally {
          persisted.fill(0);
        }
      }) ?? null;
    } finally {
      candidate.fill(0);
    }
  }

  function newSessionId(existingSessions) {
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      let bytes;
      try {
        bytes = randomBytes(SESSION_BYTES);
        if (!Buffer.isBuffer(bytes) || bytes.length !== SESSION_BYTES) {
          bytes?.fill?.(0);
          throw namedError('Invalid session randomness');
        }
        const sessionId = bytes.toString('base64url');
        const idHash = hashSessionId(sessionId);
        if (!findSession(existingSessions, idHash)) return { sessionId, idHash };
      } catch (error) {
        if (error?.message === 'Invalid session randomness') throw error;
        throw namedError('Invalid session randomness');
      } finally {
        bytes?.fill?.(0);
      }
    }
    throw namedError('Unable to create unique session');
  }

  function publicSession(sessionId, session) {
    const first = state.accounts[0];
    return {
      accountMasked: first.accountMasked,
      csrfToken: csrfFor(sessionId),
      expiresAt: session.expiresAt,
    };
  }

  function upsertAccount(accounts, input, timestamp) {
    const existingIndex = accounts.findIndex(({ account }) => account === input.account.trim());
    if (existingIndex !== -1) {
      let updated;
      try {
        updated = updateAccountRecord(accounts[existingIndex], input, { timestamp });
      } catch (error) {
        throw error?.message === 'Cannot update credentials for a different account'
          ? error : namedError('Invalid account input');
      }
      return {
        accounts: accounts.map((account, index) => index === existingIndex ? updated : account),
        account: updated,
      };
    }
    if (accounts.length >= MAX_ACCOUNTS) throw namedError('Account limit reached');
    const created = createUniqueAccount(input, timestamp, accounts);
    return { accounts: [...accounts, created], account: created };
  }

  return {
    listAccounts() {
      return state === null ? [] : state.accounts.map((account) => structuredClone(toPublicAccount(account)));
    },

    getPrivateAccounts() {
      return state === null ? [] : state.accounts.map((account) => cloneAccount(account));
    },

    getPrivateAccount(accountId) {
      if (state === null || typeof accountId !== 'string') return null;
      return cloneAccount(state.accounts.find((account) => account.accountId === accountId) ?? null);
    },

    addAccount(input) {
      return serialize(async () => {
        const accountInput = normalizeInput(input);
        const timestamp = readTime(now);
        const currentAccounts = state?.accounts ?? [];
        const upserted = upsertAccount(currentAccounts, accountInput, timestamp);
        const candidate = {
          version: CURRENT_VERSION,
          accounts: upserted.accounts,
          sessions: state?.sessions ?? [],
        };
        await persistState(candidate);
        return structuredClone(toPublicAccount(upserted.account));
      });
    },

    updateRemark(accountId, remark) {
      return serialize(async () => {
        if (state === null || typeof accountId !== 'string') return null;
        const index = state.accounts.findIndex((account) => account.accountId === accountId);
        if (index === -1) return null;
        const timestamp = readTime(now);
        let updated;
        try {
          updated = updateAccountRecord(state.accounts[index], { remark }, { timestamp });
        } catch {
          throw namedError('Invalid account input');
        }
        const candidate = { ...state, accounts: state.accounts.map((account, current) => current === index ? updated : account) };
        await persistState(candidate);
        return structuredClone(toPublicAccount(updated));
      });
    },

    reauthenticateAccount(accountId, input) {
      return serialize(async () => {
        if (state === null || typeof accountId !== 'string') return null;
        const index = state.accounts.findIndex((account) => account.accountId === accountId);
        if (index === -1) return null;
        const accountInput = normalizeInput(input);
        const timestamp = readTime(now);
        let updated;
        try {
          updated = updateAccountRecord(state.accounts[index], accountInput, { timestamp });
        } catch (error) {
          throw error?.message === 'Cannot update credentials for a different account'
            ? error : namedError('Invalid account input');
        }
        const candidate = { ...state, accounts: state.accounts.map((account, current) => current === index ? updated : account) };
        await persistState(candidate);
        return structuredClone(toPublicAccount(updated));
      });
    },

    removeAccount(accountId) {
      return serialize(async () => {
        if (state === null || typeof accountId !== 'string') return null;
        const index = state.accounts.findIndex((account) => account.accountId === accountId);
        if (index === -1) return null;
        const removed = state.accounts[index];
        if (state.accounts.length === 1) {
          await removeState();
        } else {
          await persistState({ ...state, accounts: state.accounts.filter((_, current) => current !== index) });
        }
        return structuredClone(toPublicAccount(removed));
      });
    },

    create(input) {
      return serialize(async () => {
        const accountInput = normalizeInput(input);
        const timestamp = readTime(now);
        const pruned = pruneSessions(state, timestamp).state;
        const upserted = upsertAccount(pruned?.accounts ?? [], accountInput, timestamp);
        const collisionSessions = pruned?.sessions ?? [];
        const { sessionId, idHash } = newSessionId(collisionSessions);
        const session = {
          idHash,
          createdAt: timestamp,
          lastSeenAt: timestamp,
          expiresAt: timestamp + SESSION_TTL_MS,
        };
        const candidate = {
          version: CURRENT_VERSION,
          accounts: upserted.accounts,
          sessions: [...evictSessions(collisionSessions, MAX_SESSIONS - 1), session],
        };
        await persistState(candidate);
        return {
          sessionId,
          csrfToken: csrfFor(sessionId),
          expiresAt: session.expiresAt,
          account: upserted.account.account,
        };
      });
    },

    authenticate(sessionId, { renew = false } = {}) {
      return serialize(async () => {
        const parsedId = parseSessionId(sessionId);
        if (parsedId === null || state === null || typeof renew !== 'boolean') return null;
        const timestamp = readTime(now);
        const pruned = pruneSessions(state, timestamp);
        const idHash = hashSessionId(parsedId);
        const session = findSession(pruned.state.sessions, idHash);
        if (session === null) {
          if (pruned.changed) await persistState(pruned.state);
          return null;
        }
        if (!renew || timestamp - session.lastSeenAt < RENEWAL_INTERVAL_MS) {
          if (pruned.changed) await persistState(pruned.state);
          return publicSession(parsedId, session);
        }
        const renewed = { ...session, lastSeenAt: timestamp, expiresAt: timestamp + SESSION_TTL_MS };
        const candidate = {
          ...pruned.state,
          sessions: pruned.state.sessions.map((entry) => entry.idHash === session.idHash ? renewed : entry),
        };
        await persistState(candidate);
        return publicSession(parsedId, renewed);
      });
    },

    getBambuSession() {
      return cloneAccount(state?.accounts[0] ?? null);
    },

    clear() {
      return serialize(async () => {
        if (state !== null) await removeState();
      });
    },
  };
}
