import * as defaultCrypto from 'node:crypto';
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
const WINDOWS_DIRECTORY_SYNC_ERRORS = new Set([
  'EBADF',
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EPERM',
  'UNKNOWN',
]);

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

function invalidSecretKeyError() {
  return namedError(`Invalid secret key file: ${SECRET_KEY_NAME}`);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function inspectTarget(fsApi, targetPath, name, { keyFile = false } = {}) {
  if (typeof fsApi.lstat !== 'function') return { available: false, exists: undefined };

  let stat;
  try {
    stat = await fsApi.lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) return { available: true, exists: false };
    throw error;
  }

  if (stat.isSymbolicLink()) throw unsafeLinkError(name);
  if (!stat.isFile()) {
    throw keyFile ? invalidSecretKeyError() : invalidStorageFileError(name);
  }
  return { available: true, exists: true, stat };
}

async function inspectManagedTarget(fsApi, targetPath, name) {
  return inspectTarget(fsApi, targetPath, name);
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

function isUnsupportedWindowsDirectorySync(error) {
  return process.platform === 'win32' && WINDOWS_DIRECTORY_SYNC_ERRORS.has(error?.code);
}

async function syncDirectory(fsApi, directory) {
  let handle;
  try {
    handle = await fsApi.open(directory, 'r');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await closeQuietly(handle);
    if (!isUnsupportedWindowsDirectorySync(error)) throw error;
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
  await inspectManagedTarget(fsApi, targetPath, name);

  let bytes;
  try {
    bytes = await fsApi.readFile(targetPath);
  } catch (error) {
    if (isMissing(error)) return null;
    if (error?.code === 'EISDIR') throw invalidStorageFileError(name);
    throw error;
  }

  try {
    await inspectManagedTarget(fsApi, targetPath, name);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

async function inspectSecretKey(fsApi, keyPath) {
  const inspected = await inspectTarget(fsApi, keyPath, SECRET_KEY_NAME, { keyFile: true });
  if (inspected.available && !inspected.exists) return { state: 'missing' };
  if (inspected.stat && inspected.stat.size !== SECRET_KEY_BYTES) return { state: 'incomplete' };

  let bytes;
  try {
    bytes = await fsApi.readFile(keyPath);
  } catch (error) {
    if (isMissing(error)) return { state: 'missing' };
    if (error?.code === 'EISDIR') throw invalidSecretKeyError();
    throw error;
  }

  try {
    await inspectTarget(fsApi, keyPath, SECRET_KEY_NAME, { keyFile: true });
    if (bytes.length !== SECRET_KEY_BYTES) {
      bytes.fill(0);
      return { state: 'incomplete' };
    }
    return { state: 'ready', key: bytes };
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
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

  let handle;
  let ownsKey = false;
  let durableFile = false;
  try {
    handle = await fsApi.open(keyPath, 'wx', 0o600);
    ownsKey = true;
    await writeAll(handle, candidate);
    await handle.sync();
    await handle.close();
    handle = undefined;
    durableFile = true;
    await syncDirectory(fsApi, dataDir);
    return Buffer.from(candidate);
  } catch (error) {
    await closeQuietly(handle);
    if (ownsKey && !durableFile) await unlinkQuietly(fsApi, keyPath);
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
    if (inspected.state === 'ready') {
      if (typeof fsApi.chmod === 'function') {
        try {
          await fsApi.chmod(keyPath, 0o600);
        } catch (error) {
          inspected.key.fill(0);
          throw error;
        }
      }
      return inspected.key;
    }

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
  const existing = keyInitializations.get(keyPath);
  if (existing) return existing;

  const created = Promise.resolve().then(factory);
  keyInitializations.set(keyPath, created);
  const clear = () => {
    if (keyInitializations.get(keyPath) === created) keyInitializations.delete(keyPath);
  };
  created.then(clear, clear);
  return created;
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

function parseEnvelope(name, bytes) {
  try {
    const envelope = JSON.parse(bytes.toString('utf8'));
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

  const resolvedDataDir = path.resolve(dataDir);
  await fsApi.mkdir(resolvedDataDir, { recursive: true, mode: 0o700 });
  if (typeof fsApi.chmod === 'function') {
    await fsApi.chmod(resolvedDataDir, 0o700);
  }

  const keyPath = path.join(resolvedDataDir, SECRET_KEY_NAME);
  const initializedKey = await sharedKeyInitialization(
    keyPath,
    () => initializeSecretKey(fsApi, cryptoApi, keyPath, resolvedDataDir),
  );
  const secretKey = Buffer.from(initializedKey);

  return {
    dataDir: resolvedDataDir,

    getSecretKey() {
      return Buffer.from(secretKey);
    },

    async readJson(name, fallback) {
      validateName(name);
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
      const bytes = serializeJson(name, value);
      try {
        await atomicWrite(fsApi, resolvedDataDir, name, bytes);
      } finally {
        bytes.fill(0);
      }
    },

    async readEncrypted(name) {
      validateName(name);
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
      const sourcePath = path.join(resolvedDataDir, name);
      const backupPath = path.join(resolvedDataDir, backupName);
      await inspectManagedTarget(fsApi, sourcePath, name);
      const backupTarget = await inspectManagedTarget(fsApi, backupPath, backupName);
      if (backupTarget.exists) return false;

      let sourceBytes;
      let handle;
      let ownsBackup = false;
      let complete = false;
      try {
        sourceBytes = await fsApi.readFile(sourcePath);
        await inspectManagedTarget(fsApi, sourcePath, name);
        try {
          handle = await fsApi.open(backupPath, 'wx', 0o600);
          ownsBackup = true;
        } catch (error) {
          if (error?.code === 'EEXIST') {
            await inspectManagedTarget(fsApi, backupPath, backupName);
            return false;
          }
          throw error;
        }
        await writeAll(handle, sourceBytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        complete = true;
        await syncDirectory(fsApi, resolvedDataDir);
        return true;
      } catch (error) {
        await closeQuietly(handle);
        if (ownsBackup && !complete) await unlinkQuietly(fsApi, backupPath);
        throw error;
      } finally {
        sourceBytes?.fill(0);
      }
    },
  };
}
