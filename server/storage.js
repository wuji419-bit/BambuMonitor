import * as defaultCrypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import path from 'node:path';

const SECRET_KEY_NAME = 'secret.key';
const SECRET_KEY_BYTES = 32;
const ENCRYPTION_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_WAIT_ATTEMPTS = 25;
const KEY_WAIT_MS = 5;
const READ_ONLY_NOFOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const DIRECTORY_READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0);
const REQUIRED_FS_METHODS = ['chmod', 'link', 'lstat', 'mkdir', 'open', 'realpath', 'rename', 'unlink'];
const keyInitializations = new Map();
let tempSequence = 0;

function namedError(message) {
  return new Error(message);
}

function validateName(name) {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('\0')
    || name.includes('/')
    || name.includes('\\')
    || path.posix.basename(name) !== name
    || path.win32.basename(name) !== name
    || path.posix.isAbsolute(name)
    || path.win32.isAbsolute(name)
  ) {
    throw namedError('Invalid storage name');
  }
  return name;
}

function unsafeLinkError(name) {
  return namedError(`Unsafe symbolic link: ${name}`);
}

function invalidStorageFileError(name) {
  return namedError(`Invalid storage file: ${name}`);
}

function missingStorageFileError(name) {
  const error = namedError(`Storage file not found: ${name}`);
  error.code = 'ENOENT';
  return error;
}

function invalidSecretKeyError() {
  return namedError(`Invalid secret key file: ${SECRET_KEY_NAME}`);
}

function invalidDataDirectoryError() {
  return namedError('Invalid data directory');
}

function unsafeDataDirectoryError() {
  return namedError('Unsafe data directory');
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function validateFsApi(fsApi) {
  for (const method of REQUIRED_FS_METHODS) {
    if (typeof fsApi?.[method] !== 'function') {
      throw namedError(`Invalid fsApi: missing ${method}`);
    }
  }
}

async function inspectTarget(fsApi, targetPath, name, { keyFile = false } = {}) {
  let stat;
  try {
    stat = await fsApi.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) return { exists: false };
    throw error;
  }

  if (stat.isSymbolicLink()) throw unsafeLinkError(name);
  if (!stat.isFile()) {
    throw keyFile ? invalidSecretKeyError() : invalidStorageFileError(name);
  }
  return { exists: true, stat };
}

async function inspectManagedTarget(fsApi, targetPath, name) {
  return inspectTarget(fsApi, targetPath, name);
}

function fileIdentityMatches(left, right) {
  const validIdentityPart = (value) => typeof value === 'number' || typeof value === 'bigint';
  return validIdentityPart(left?.dev)
    && validIdentityPart(left?.ino)
    && validIdentityPart(right?.dev)
    && validIdentityPart(right?.ino)
    && left.dev === right.dev
    && left.ino === right.ino;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function inspectDataDirectory(fsApi, dataDir, expectedStat) {
  let stat;
  try {
    stat = await fsApi.lstat(dataDir);
  } catch (error) {
    if (isMissing(error) && !expectedStat) return null;
    if (isMissing(error)) throw unsafeDataDirectoryError();
    throw error;
  }

  if (stat.isSymbolicLink()) throw unsafeDataDirectoryError();
  if (!stat.isDirectory()) throw invalidDataDirectoryError();
  if (expectedStat && !fileIdentityMatches(expectedStat, stat)) throw unsafeDataDirectoryError();

  let canonicalPath;
  let canonicalParent;
  try {
    [canonicalPath, canonicalParent] = await Promise.all([
      fsApi.realpath(dataDir),
      fsApi.realpath(path.dirname(dataDir)),
    ]);
  } catch (error) {
    if (isMissing(error)) throw unsafeDataDirectoryError();
    throw error;
  }
  const expectedCanonicalPath = typeof canonicalParent === 'string'
    ? path.join(canonicalParent, path.basename(dataDir))
    : null;
  if (
    typeof canonicalPath !== 'string'
    || expectedCanonicalPath === null
    || comparablePath(canonicalPath) !== comparablePath(expectedCanonicalPath)
  ) {
    throw unsafeDataDirectoryError();
  }
  return stat;
}

function assertDirectoryHandleMatchesPath(pathStat, handleStat) {
  if (typeof handleStat?.isDirectory !== 'function' || !handleStat.isDirectory()) {
    throw invalidDataDirectoryError();
  }
  if (!fileIdentityMatches(pathStat, handleStat)) throw unsafeDataDirectoryError();
}

async function openVerifiedDataDirectory(fsApi, dataDir, expectedStat) {
  const inspectedStat = await inspectDataDirectory(fsApi, dataDir, expectedStat);
  if (inspectedStat === null) throw invalidDataDirectoryError();

  let handle;
  try {
    handle = await fsApi.open(dataDir, DIRECTORY_READ_FLAGS);
  } catch (error) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error?.code)) throw unsafeDataDirectoryError();
    throw error;
  }

  try {
    if (typeof handle.stat !== 'function') {
      throw namedError('Invalid fsApi directory handle: missing stat');
    }
    const handleStat = await handle.stat();
    assertDirectoryHandleMatchesPath(inspectedStat, handleStat);
    await inspectDataDirectory(fsApi, dataDir, handleStat);
    return { handle, stat: handleStat };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

async function prepareDataDirectory(fsApi, dataDir) {
  await inspectDataDirectory(fsApi, dataDir);
  await fsApi.mkdir(dataDir, { recursive: true, mode: 0o700 });

  let opened = await openVerifiedDataDirectory(fsApi, dataDir);
  let { handle } = opened;
  try {
    if (process.platform === 'win32') {
      await fsApi.chmod(dataDir, 0o700);
    } else {
      if (typeof handle.chmod !== 'function') {
        throw namedError('Invalid fsApi directory handle: missing chmod');
      }
      await handle.chmod(0o700);
    }
    const finalStat = await handle.stat();
    assertDirectoryHandleMatchesPath(opened.stat, finalStat);
    await inspectDataDirectory(fsApi, dataDir, finalStat);
    await handle.close();
    handle = undefined;
    return finalStat;
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  } finally {
    opened = undefined;
  }
}

async function verifyDataDirectory(fsApi, dataDir, expectedStat) {
  let opened;
  try {
    opened = await openVerifiedDataDirectory(fsApi, dataDir, expectedStat);
    await opened.handle.close();
    opened = undefined;
  } finally {
    await closeQuietly(opened?.handle);
  }
}

function assertHandleMatchesPath(pathStat, handleStat, name, { keyFile = false } = {}) {
  if (typeof handleStat?.isFile !== 'function' || !handleStat.isFile()) {
    throw keyFile ? invalidSecretKeyError() : invalidStorageFileError(name);
  }
  if (!fileIdentityMatches(pathStat, handleStat)) throw unsafeLinkError(name);
}

async function verifyHandlePath(fsApi, targetPath, name, handleStat, options) {
  const current = await inspectTarget(fsApi, targetPath, name, options);
  if (!current.exists || !fileIdentityMatches(current.stat, handleStat)) {
    throw unsafeLinkError(name);
  }
}

async function openVerifiedReadHandle(fsApi, targetPath, name, options = {}) {
  const inspected = await inspectTarget(fsApi, targetPath, name, options);
  if (!inspected.exists) return null;

  let handle;
  try {
    handle = await fsApi.open(targetPath, READ_ONLY_NOFOLLOW_FLAGS);
  } catch (error) {
    if (error?.code === 'ELOOP') throw unsafeLinkError(name);
    if (isMissing(error)) return null;
    if (error?.code === 'EISDIR') {
      throw options.keyFile ? invalidSecretKeyError() : invalidStorageFileError(name);
    }
    throw error;
  }

  try {
    if (typeof handle.stat !== 'function') throw namedError('Invalid fsApi file handle: missing stat');
    const handleStat = await handle.stat();
    assertHandleMatchesPath(inspected.stat, handleStat, name, options);
    await verifyHandlePath(fsApi, targetPath, name, handleStat, options);
    return { handle, stat: handleStat };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

async function readVerifiedHandle(fsApi, targetPath, name, opened, { mode, ...options } = {}) {
  let { handle } = opened;
  let bytes;
  try {
    if (mode !== undefined) {
      if (typeof handle.chmod !== 'function') {
        throw namedError('Invalid fsApi file handle: missing chmod');
      }
      await handle.chmod(mode);
    }
    if (typeof handle.readFile !== 'function') {
      throw namedError('Invalid fsApi file handle: missing readFile');
    }
    bytes = await handle.readFile();
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    const finalStat = await handle.stat();
    assertHandleMatchesPath(opened.stat, finalStat, name, options);
    await verifyHandlePath(fsApi, targetPath, name, finalStat, options);
    await handle.close();
    handle = undefined;
    return bytes;
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await closeQuietly(handle);
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(result?.bytesWritten) || result.bytesWritten <= 0) {
      throw namedError('Unable to complete storage write');
    }
    offset += result.bytesWritten;
  }
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the operation's original failure.
  }
}

async function unlinkQuietly(fsApi, targetPath) {
  try {
    await fsApi.unlink(targetPath);
  } catch (error) {
    if (!isMissing(error)) {
      // Cleanup is best effort so it cannot hide the primary failure.
    }
  }
}

function isUnsupportedNativeWindowsDirectorySync(fsApi, error, operation) {
  return fsApi === defaultFs
    && process.platform === 'win32'
    && operation === 'sync'
    && error?.code === 'EPERM'
    && error?.syscall === 'fsync';
}

async function syncDirectory(fsApi, directory) {
  let handle;
  let operation = 'open';
  try {
    handle = await fsApi.open(directory, 'r');
    operation = 'sync';
    await handle.sync();
    operation = 'close';
    await handle.close();
    handle = undefined;
  } catch (error) {
    await closeQuietly(handle);
    if (!isUnsupportedNativeWindowsDirectorySync(fsApi, error, operation)) throw error;
  }
}

function nextTempPath(dataDir, name) {
  tempSequence += 1;
  const id = `${process.pid}.${Date.now()}.${tempSequence}.${defaultCrypto.randomUUID()}`;
  return path.join(dataDir, `.${name}.${id}.tmp`);
}

async function atomicWrite(fsApi, dataDir, name, bytes) {
  const destination = path.join(dataDir, name);
  await inspectManagedTarget(fsApi, destination, name);

  const tempPath = nextTempPath(dataDir, name);
  let handle;
  let ownsTemp = false;
  try {
    handle = await fsApi.open(tempPath, 'wx', 0o600);
    ownsTemp = true;
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await inspectManagedTarget(fsApi, destination, name);
    await fsApi.rename(tempPath, destination);
    ownsTemp = false;
    await syncDirectory(fsApi, dataDir);
  } catch (error) {
    await closeQuietly(handle);
    if (ownsTemp) await unlinkQuietly(fsApi, tempPath);
    throw error;
  }
}

function serializeJson(name, value) {
  try {
    const json = JSON.stringify(value, (_key, current) => {
      const type = typeof current;
      if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
        throw namedError('unsupported JSON value');
      }
      return current;
    });
    if (typeof json !== 'string') throw namedError('unsupported JSON root');
    return Buffer.from(`${json}\n`, 'utf8');
  } catch {
    throw namedError(`Value for ${name} is not JSON serializable`);
  }
}

async function readManagedBytes(fsApi, dataDir, name) {
  const targetPath = path.join(dataDir, name);
  const opened = await openVerifiedReadHandle(fsApi, targetPath, name);
  if (opened === null) return null;
  return readVerifiedHandle(fsApi, targetPath, name, opened);
}

async function inspectSecretKey(fsApi, keyPath) {
  const options = { keyFile: true };
  const opened = await openVerifiedReadHandle(fsApi, keyPath, SECRET_KEY_NAME, options);
  if (opened === null) return { state: 'missing' };
  if (opened.stat.size !== SECRET_KEY_BYTES) {
    await closeQuietly(opened.handle);
    return { state: 'incomplete' };
  }

  const bytes = await readVerifiedHandle(fsApi, keyPath, SECRET_KEY_NAME, opened, {
    ...options,
    mode: 0o600,
  });
  if (bytes.length !== SECRET_KEY_BYTES) {
    bytes.fill(0);
    return { state: 'incomplete' };
  }
  return { state: 'ready', key: bytes };
}

async function createSecretKey(fsApi, cryptoApi, keyPath, dataDir) {
  let candidate;
  try {
    candidate = Buffer.from(cryptoApi.randomBytes(SECRET_KEY_BYTES));
  } catch {
    throw namedError(`Unable to create secret key: ${SECRET_KEY_NAME}`);
  }
  if (candidate.length !== SECRET_KEY_BYTES) {
    candidate.fill(0);
    throw invalidSecretKeyError();
  }

  const tempPath = nextTempPath(dataDir, SECRET_KEY_NAME);
  let handle;
  let ownsTemp = false;
  try {
    handle = await fsApi.open(tempPath, 'wx', 0o600);
    ownsTemp = true;
    await writeAll(handle, candidate);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await fsApi.link(tempPath, keyPath);
    await fsApi.unlink(tempPath);
    ownsTemp = false;
    await syncDirectory(fsApi, dataDir);
    return Buffer.from(candidate);
  } catch (error) {
    await closeQuietly(handle);
    if (ownsTemp) await unlinkQuietly(fsApi, tempPath);
    throw error;
  } finally {
    candidate.fill(0);
  }
}

function waitBriefly() {
  return new Promise((resolve) => setTimeout(resolve, KEY_WAIT_MS));
}

async function initializeSecretKey(fsApi, cryptoApi, keyPath, dataDir) {
  for (let attempt = 0; attempt < KEY_WAIT_ATTEMPTS; attempt += 1) {
    const inspected = await inspectSecretKey(fsApi, keyPath);
    if (inspected.state === 'ready') return inspected.key;

    if (inspected.state === 'missing') {
      try {
        return await createSecretKey(fsApi, cryptoApi, keyPath, dataDir);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }

    if (attempt < KEY_WAIT_ATTEMPTS - 1) await waitBriefly();
  }
  throw invalidSecretKeyError();
}

function sharedKeyInitialization(keyPath, factory) {
  let entry = keyInitializations.get(keyPath);
  if (!entry) {
    entry = {
      promise: null,
      sharedKey: null,
      settled: false,
      waiters: 0,
    };
    entry.promise = Promise.resolve()
      .then(factory)
      .then(
        (key) => {
          entry.sharedKey = key;
          entry.settled = true;
          return key;
        },
        (error) => {
          entry.settled = true;
          throw error;
        },
      );
    keyInitializations.set(keyPath, entry);
  }

  entry.waiters += 1;
  return entry.promise
    .then((key) => Buffer.from(key))
    .finally(() => {
      entry.waiters -= 1;
      if (!entry.settled || entry.waiters !== 0) return;
      entry.sharedKey?.fill(0);
      entry.sharedKey = null;
      if (keyInitializations.get(keyPath) === entry) keyInitializations.delete(keyPath);
    });
}

function aadFor(name) {
  return Buffer.from(JSON.stringify({
    version: ENCRYPTION_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    name,
  }), 'utf8');
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string') throw namedError('invalid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    bytes.fill(0);
    throw namedError('invalid base64');
  }
  return bytes;
}

function assertUniqueTopLevelMembers(json) {
  const seen = new Set();
  let depth = 0;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (character === '{' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === '}' || character === ']') {
      depth -= 1;
      continue;
    }
    if (character !== '"') continue;

    const start = index;
    for (index += 1; index < json.length; index += 1) {
      if (json[index] === '\\') {
        index += 1;
      } else if (json[index] === '"') {
        break;
      }
    }
    if (depth !== 1) continue;

    let next = index + 1;
    while (/\s/u.test(json[next] ?? '')) next += 1;
    if (json[next] !== ':') continue;
    const member = JSON.parse(json.slice(start, index + 1));
    if (seen.has(member)) throw namedError('duplicate metadata');
    seen.add(member);
  }
}

function parseEnvelope(name, bytes) {
  try {
    const json = bytes.toString('utf8');
    const envelope = JSON.parse(json);
    assertUniqueTopLevelMembers(json);
    const keys = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
      ? Object.keys(envelope).sort()
      : [];
    const expectedKeys = ['algorithm', 'ciphertext', 'iv', 'tag', 'version'];
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
      || envelope.version !== ENCRYPTION_VERSION
      || envelope.algorithm !== ENCRYPTION_ALGORITHM
    ) {
      throw namedError('invalid metadata');
    }

    const iv = decodeCanonicalBase64(envelope.iv);
    const tag = decodeCanonicalBase64(envelope.tag);
    const ciphertext = decodeCanonicalBase64(envelope.ciphertext);
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
      iv.fill(0);
      tag.fill(0);
      ciphertext.fill(0);
      throw namedError('invalid lengths');
    }
    return { iv, tag, ciphertext };
  } catch {
    throw namedError(`Invalid encrypted envelope: ${name}`);
  }
}

export async function createStorage({ dataDir, fsApi = defaultFs, cryptoApi = defaultCrypto }) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw namedError('Invalid data directory');
  }
  validateFsApi(fsApi);

  const resolvedDataDir = path.resolve(dataDir);
  const dataDirectoryStat = await prepareDataDirectory(fsApi, resolvedDataDir);

  const keyPath = path.join(resolvedDataDir, SECRET_KEY_NAME);
  const secretKey = await sharedKeyInitialization(
    keyPath,
    () => initializeSecretKey(fsApi, cryptoApi, keyPath, resolvedDataDir),
  );
  try {
    await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
  } catch (error) {
    secretKey.fill(0);
    throw error;
  }

  return {
    dataDir: resolvedDataDir,

    getSecretKey() {
      return Buffer.from(secretKey);
    },

    async readJson(name, fallback) {
      validateName(name);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const bytes = await readManagedBytes(fsApi, resolvedDataDir, name);
      if (bytes === null) return structuredClone(fallback);
      try {
        return JSON.parse(bytes.toString('utf8'));
      } catch {
        throw namedError(`Invalid JSON in ${name}`);
      } finally {
        bytes.fill(0);
      }
    },

    async writeJson(name, value) {
      validateName(name);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const bytes = serializeJson(name, value);
      try {
        await atomicWrite(fsApi, resolvedDataDir, name, bytes);
      } finally {
        bytes.fill(0);
      }
    },

    async readEncrypted(name) {
      validateName(name);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const envelopeBytes = await readManagedBytes(fsApi, resolvedDataDir, name);
      if (envelopeBytes === null) return null;

      let encrypted;
      try {
        encrypted = parseEnvelope(name, envelopeBytes);
      } finally {
        envelopeBytes.fill(0);
      }

      let plaintext;
      let plaintextChunk;
      let finalChunk;
      try {
        const decipher = cryptoApi.createDecipheriv(
          ENCRYPTION_ALGORITHM,
          secretKey,
          encrypted.iv,
          { authTagLength: AUTH_TAG_BYTES },
        );
        decipher.setAAD(aadFor(name));
        decipher.setAuthTag(encrypted.tag);
        plaintextChunk = decipher.update(encrypted.ciphertext);
        finalChunk = decipher.final();
        plaintext = Buffer.concat([plaintextChunk, finalChunk]);
      } catch {
        throw namedError(`Unable to authenticate encrypted file: ${name}`);
      } finally {
        plaintextChunk?.fill(0);
        finalChunk?.fill(0);
        encrypted.iv.fill(0);
        encrypted.tag.fill(0);
        encrypted.ciphertext.fill(0);
      }

      try {
        return JSON.parse(plaintext.toString('utf8'));
      } catch {
        throw namedError(`Invalid encrypted payload: ${name}`);
      } finally {
        plaintext.fill(0);
      }
    },

    async writeEncrypted(name, value) {
      validateName(name);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const plaintext = serializeJson(name, value);
      let iv;
      let tag;
      let ciphertext;
      try {
        iv = Buffer.from(cryptoApi.randomBytes(IV_BYTES));
        if (iv.length !== IV_BYTES) throw namedError('invalid IV');
        const cipher = cryptoApi.createCipheriv(
          ENCRYPTION_ALGORITHM,
          secretKey,
          iv,
          { authTagLength: AUTH_TAG_BYTES },
        );
        cipher.setAAD(aadFor(name));
        ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        tag = Buffer.from(cipher.getAuthTag());
        if (tag.length !== AUTH_TAG_BYTES || ciphertext.length === 0) {
          throw namedError('invalid encrypted output');
        }
      } catch {
        throw namedError(`Unable to encrypt file: ${name}`);
      } finally {
        plaintext.fill(0);
      }

      const envelopeBytes = Buffer.from(`${JSON.stringify({
        version: ENCRYPTION_VERSION,
        algorithm: ENCRYPTION_ALGORITHM,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      })}\n`, 'utf8');
      try {
        await atomicWrite(fsApi, resolvedDataDir, name, envelopeBytes);
      } finally {
        iv.fill(0);
        tag.fill(0);
        ciphertext.fill(0);
        envelopeBytes.fill(0);
      }
    },

    async remove(name) {
      validateName(name);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const targetPath = path.join(resolvedDataDir, name);
      await inspectManagedTarget(fsApi, targetPath, name);
      try {
        await fsApi.unlink(targetPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },

    async backup(name, backupName) {
      validateName(name);
      validateName(backupName);
      await verifyDataDirectory(fsApi, resolvedDataDir, dataDirectoryStat);
      const sourcePath = path.join(resolvedDataDir, name);
      const backupPath = path.join(resolvedDataDir, backupName);
      await inspectManagedTarget(fsApi, sourcePath, name);
      const backupTarget = await inspectManagedTarget(fsApi, backupPath, backupName);
      if (backupTarget.exists) return false;

      const tempPath = nextTempPath(resolvedDataDir, backupName);
      let sourceBytes;
      let handle;
      let ownsTemp = false;
      try {
        sourceBytes = await readManagedBytes(fsApi, resolvedDataDir, name);
        if (sourceBytes === null) throw missingStorageFileError(name);
        handle = await fsApi.open(tempPath, 'wx', 0o600);
        ownsTemp = true;
        await writeAll(handle, sourceBytes);
        await handle.sync();
        await handle.close();
        handle = undefined;

        try {
          await fsApi.link(tempPath, backupPath);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          await inspectManagedTarget(fsApi, backupPath, backupName);
          await fsApi.unlink(tempPath);
          ownsTemp = false;
          return false;
        }
        await fsApi.unlink(tempPath);
        ownsTemp = false;
        await syncDirectory(fsApi, resolvedDataDir);
        return true;
      } catch (error) {
        await closeQuietly(handle);
        if (ownsTemp) await unlinkQuietly(fsApi, tempPath);
        throw error;
      } finally {
        sourceBytes?.fill(0);
      }
    },
  };
}
