import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStorage } from './storage.js';

async function makeTempDir(t, prefix = 'bambu-storage-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function tempFiles(entries, name) {
  return entries.filter((entry) => entry.startsWith(`.${name}.`) && entry.endsWith('.tmp'));
}

function isTempPath(target, name) {
  return tempFiles([path.basename(String(target))], name).length === 1;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForSignal(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function proxyHandle(handle, overrides = {}) {
  return new Proxy(handle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mutateBase64(value) {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

async function makeFileSymlink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'file' : undefined);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return false;
    throw error;
  }
}

async function makeDirectoryLink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return false;
    throw error;
  }
}

async function fileSymlinksAvailable(root) {
  const target = path.join(root, 'symlink-probe-target');
  const link = path.join(root, 'symlink-probe-link');
  await fs.writeFile(target, 'probe');
  const available = await makeFileSymlink(target, link);
  if (available) await fs.unlink(link);
  await fs.unlink(target);
  return available;
}

function createPathSwapFs({ targetPath, parkedPath, externalPath, symlink = true }) {
  let swapped = false;
  let restored = false;
  let restorePromise;

  async function restore() {
    if (!swapped || restored) return;
    restorePromise ??= (async () => {
      if (symlink) {
        await fs.unlink(targetPath);
      } else {
        await fs.rename(targetPath, externalPath);
      }
      await fs.rename(parkedPath, targetPath);
      restored = true;
    })();
    await restorePromise;
  }

  return {
    ...fs,
    async lstat(target, ...args) {
      const stat = await fs.lstat(target, ...args);
      if (target === targetPath && !swapped) {
        swapped = true;
        await fs.rename(targetPath, parkedPath);
        if (symlink) {
          if (!await makeFileSymlink(externalPath, targetPath)) {
            throw new Error('Symlink privilege disappeared during race test');
          }
        } else {
          await fs.rename(externalPath, targetPath);
        }
      }
      return stat;
    },
    async readFile(target, ...args) {
      const bytes = await fs.readFile(target, ...args);
      if (target === targetPath) await restore();
      return bytes;
    },
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (target !== targetPath) return handle;
      return proxyHandle(handle, {
        stat: async (...statArgs) => {
          const stat = await handle.stat(...statArgs);
          await restore();
          return stat;
        },
      });
    },
  };
}

async function nextChildMessage(child) {
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  return message;
}

const FAILING_KEY_CREATOR_SOURCE = String.raw`
import * as fs from 'node:fs/promises';
import path from 'node:path';

const [storageUrl, dataDir] = process.argv.slice(1);
const { createStorage } = await import(storageUrl);
const keyPath = path.join(dataDir, 'secret.key');
let releaseSync;
const syncRelease = new Promise((resolve) => {
  releaseSync = resolve;
});
process.on('message', (message) => {
  if (message?.type === 'continue') releaseSync();
});

function proxyHandle(handle, overrides) {
  return new Proxy(handle, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

let interceptedKeyWrite = false;
const failingFs = {
  ...fs,
  async open(target, ...args) {
    const handle = await fs.open(target, ...args);
    const basename = path.basename(String(target));
    const isKeyWrite = target === keyPath
      || (basename.startsWith('.secret.key.') && basename.endsWith('.tmp'));
    if (interceptedKeyWrite || !isKeyWrite) return handle;
    interceptedKeyWrite = true;
    return proxyHandle(handle, {
      sync: async () => {
        process.send({ type: 'before-sync' });
        await syncRelease;
        const error = new Error('simulated key sync failure');
        error.code = 'EIO';
        throw error;
      },
    });
  },
};

try {
  await createStorage({ dataDir, fsApi: failingFs });
  process.send({ type: 'result', outcome: 'resolved' });
} catch (error) {
  process.send({ type: 'result', outcome: 'rejected', message: error.message });
} finally {
  process.disconnect();
}
`;

test('creates a private data directory and converges concurrent key initialization', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'nested', 'data');

  const stores = await Promise.all([
    createStorage({ dataDir }),
    createStorage({ dataDir }),
    createStorage({ dataDir }),
  ]);

  const keyOnDisk = await fs.readFile(path.join(dataDir, 'secret.key'));
  assert.equal(keyOnDisk.length, 32);
  assert.deepEqual(stores.map((storage) => storage.getSecretKey()), [keyOnDisk, keyOnDisk, keyOnDisk]);
  assert.equal(stores[0].dataDir, path.resolve(dataDir));

  const callerCopy = stores[0].getSecretKey();
  callerCopy.fill(0);
  assert.deepEqual(stores[0].getSecretKey(), keyOnDisk);

  if (process.platform !== 'win32') {
    assert.equal(modeBits(await fs.stat(dataDir)), 0o700);
    assert.equal(modeBits(await fs.stat(path.join(dataDir, 'secret.key'))), 0o600);
  }
});

test('copies a shared initialized key for each waiter and wipes the shared source buffer', async (t) => {
  const dataDir = await makeTempDir(t);
  const keyPath = path.join(dataDir, 'secret.key');
  const expectedKey = Buffer.alloc(32, 0x5a);
  const observedSharedKey = Buffer.from(expectedKey);
  await fs.writeFile(keyPath, expectedKey, { mode: 0o600 });
  const readStarted = createDeferred();
  const releaseRead = createDeferred();
  const secondDirectoryClose = createDeferred();
  t.after(() => releaseRead.resolve());
  let directoryOpenCalls = 0;
  let keyReadCalls = 0;
  const observingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (target === dataDir && args[0] !== 'r') {
        directoryOpenCalls += 1;
        if (directoryOpenCalls === 2) {
          return proxyHandle(handle, {
            close: async () => {
              await handle.close();
              secondDirectoryClose.resolve();
            },
          });
        }
      }
      if (target !== keyPath) return handle;
      return proxyHandle(handle, {
        readFile: async () => {
          keyReadCalls += 1;
          if (keyReadCalls !== 1) return Buffer.from(expectedKey);
          readStarted.resolve();
          await releaseRead.promise;
          return observedSharedKey;
        },
      });
    },
  };

  const firstStorage = createStorage({ dataDir, fsApi: observingFs });
  await waitForSignal(readStarted.promise, 'the shared key read');
  const secondStorage = createStorage({ dataDir, fsApi: observingFs });
  await waitForSignal(secondDirectoryClose.promise, 'the second storage directory check');
  await new Promise((resolve) => setImmediate(resolve));
  releaseRead.resolve();
  const stores = await Promise.all([firstStorage, secondStorage]);

  assert.equal(keyReadCalls, 1);
  assert.deepEqual(observedSharedKey, Buffer.alloc(32));
  assert.deepEqual(stores.map((storage) => storage.getSecretKey()), [expectedKey, expectedKey]);
  const mutableCopy = stores[0].getSecretKey();
  mutableCopy.fill(0);
  assert.deepEqual(stores[0].getSecretKey(), expectedKey);
  assert.deepEqual(stores[1].getSecretKey(), expectedKey);
});

test('publishes only a fully synced key when a concurrent process fails before sync', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'data');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      FAILING_KEY_CREATOR_SOURCE,
      new URL('./storage.js', import.meta.url).href,
      dataDir,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitPromise = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });

  assert.deepEqual(await nextChildMessage(child), { type: 'before-sync' });
  const competingStorage = await createStorage({ dataDir });
  child.send({ type: 'continue' });
  assert.deepEqual(await nextChildMessage(child), {
    type: 'result',
    outcome: 'rejected',
    message: 'simulated key sync failure',
  });
  const [exitCode] = await exitPromise;
  assert.equal(exitCode, 0, stderr);

  const keyOnDisk = await fs.readFile(path.join(dataDir, 'secret.key'));
  assert.equal(keyOnDisk.length, 32);
  assert.deepEqual(competingStorage.getSecretKey(), keyOnDisk);
  assert.deepEqual((await createStorage({ dataDir })).getSecretKey(), keyOnDisk);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'secret.key'), []);
});

test('rejects injected filesystems missing mandatory security methods', async (t) => {
  const root = await makeTempDir(t);

  for (const method of ['lstat', 'chmod', 'link', 'realpath']) {
    const incompleteFs = { ...fs };
    delete incompleteFs[method];
    await assert.rejects(
      createStorage({ dataDir: path.join(root, method), fsApi: incompleteFs }),
      { message: `Invalid fsApi: missing ${method}` },
    );
  }
});

test('rejects a linked data directory without writing a key through it', async (t) => {
  const root = await makeTempDir(t);
  const externalDir = path.join(root, 'external');
  const linkedDir = path.join(root, 'linked-data');
  await fs.mkdir(externalDir);
  if (!await makeDirectoryLink(externalDir, linkedDir)) {
    t.skip('Windows directory-link privilege is unavailable');
    return;
  }

  await assert.rejects(createStorage({ dataDir: linkedDir }), {
    message: 'Unsafe data directory',
  });
  await assert.rejects(fs.stat(path.join(externalDir, 'secret.key')), { code: 'ENOENT' });
});

test('rejects a data directory path that names a non-directory', async (t) => {
  const root = await makeTempDir(t);
  const filePath = path.join(root, 'not-a-directory');
  await fs.writeFile(filePath, 'not a directory');
  await assert.rejects(createStorage({ dataDir: filePath }), {
    message: 'Invalid data directory',
  });
});

test('rejects a data directory whose canonical path escapes the requested path', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'data');
  const externalDir = path.join(root, 'canonical-target');
  await fs.mkdir(dataDir);
  await fs.mkdir(externalDir);
  const escapingFs = {
    ...fs,
    async realpath(target, ...args) {
      if (target === dataDir) return externalDir;
      return fs.realpath(target, ...args);
    },
  };

  await assert.rejects(createStorage({ dataDir, fsApi: escapingFs }), {
    message: 'Unsafe data directory',
  });
  await assert.rejects(fs.stat(path.join(dataDir, 'secret.key')), { code: 'ENOENT' });
});

test('rejects a data directory replaced while its verified handle is opened', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'data');
  const parkedDir = path.join(root, 'parked-data');
  const replacementDir = path.join(root, 'replacement-data');
  await fs.mkdir(dataDir);
  await fs.mkdir(replacementDir);
  let swapped = false;
  const racingFs = {
    ...fs,
    async open(target, ...args) {
      if (target === dataDir && !swapped) {
        swapped = true;
        await fs.rename(dataDir, parkedDir);
        await fs.rename(replacementDir, dataDir);
      }
      const handle = await fs.open(target, ...args);
      if (target === dataDir) return proxyHandle(handle, { sync: async () => {} });
      return handle;
    },
  };

  await assert.rejects(createStorage({ dataDir, fsApi: racingFs }), {
    message: 'Unsafe data directory',
  });
  await assert.rejects(fs.stat(path.join(dataDir, 'secret.key')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(parkedDir, 'secret.key')), { code: 'ENOENT' });
});

test('fails initialization when private permissions cannot be enforced', async (t) => {
  await t.test('rejects a data directory chmod failure before creating a key', async (t) => {
    const root = await makeTempDir(t);
    const dataDir = path.join(root, 'data');
    const failingFs = {
      ...fs,
      async chmod(target, mode) {
        if (target === dataDir) {
          const error = new Error('simulated data directory chmod failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.chmod(target, mode);
      },
      async open(target, ...args) {
        const handle = await fs.open(target, ...args);
        if (target !== dataDir) return handle;
        return proxyHandle(handle, {
          chmod: async () => {
            const error = new Error('simulated data directory chmod failure');
            error.code = 'EACCES';
            throw error;
          },
        });
      },
    };

    await assert.rejects(
      createStorage({ dataDir, fsApi: failingFs }),
      /simulated data directory chmod failure/,
    );
    await assert.rejects(fs.stat(path.join(dataDir, 'secret.key')), { code: 'ENOENT' });
  });

  await t.test('rejects an existing key chmod failure', async (t) => {
    const dataDir = await makeTempDir(t);
    const keyPath = path.join(dataDir, 'secret.key');
    await fs.writeFile(keyPath, Buffer.alloc(32, 0xa7), { mode: 0o600 });
    const failingFs = {
      ...fs,
      async chmod(target, mode) {
        if (target === keyPath) {
          throw new Error('unsafe path chmod was used for secret.key');
        }
        return fs.chmod(target, mode);
      },
      async open(target, ...args) {
        const handle = await fs.open(target, ...args);
        if (target !== keyPath) return handle;
        return proxyHandle(handle, {
          chmod: async () => {
            const error = new Error('simulated secret key handle chmod failure');
            error.code = 'EACCES';
            throw error;
          },
        });
      },
    };

    await assert.rejects(
      createStorage({ dataDir, fsApi: failingFs }),
      /simulated secret key handle chmod failure/,
    );
  });
});

test('keeps an existing valid key and rejects invalid key files without exposing bytes', async (t) => {
  await t.test('keeps a valid key', async (t) => {
    const dataDir = await makeTempDir(t);
    const original = Buffer.alloc(32, 0xa7);
    await fs.writeFile(path.join(dataDir, 'secret.key'), original, { mode: 0o600 });

    const storage = await createStorage({ dataDir });

    assert.deepEqual(storage.getSecretKey(), original);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'secret.key')), original);
  });

  await t.test('rejects a key with the wrong length', async (t) => {
    const dataDir = await makeTempDir(t);
    const marker = 'DO_NOT_LEAK_KEY_BYTES';
    await fs.writeFile(path.join(dataDir, 'secret.key'), marker, { mode: 0o600 });

    await assert.rejects(
      createStorage({ dataDir }),
      (error) => error.message === 'Invalid secret key file: secret.key' && !error.message.includes(marker),
    );
  });

  await t.test('rejects a non-file key target', async (t) => {
    const dataDir = await makeTempDir(t);
    await fs.mkdir(path.join(dataDir, 'secret.key'));

    await assert.rejects(createStorage({ dataDir }), {
      message: 'Invalid secret key file: secret.key',
    });
  });
});

test('reads and writes deep JSON values with a trailing newline', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const fallback = { nested: { enabled: false } };

  const missing = await storage.readJson('settings.json', fallback);
  missing.nested.enabled = true;
  assert.deepEqual(fallback, { nested: { enabled: false } });

  const input = { nested: { enabled: true }, items: [1, 2, 3] };
  await storage.writeJson('settings.json', input);
  input.nested.enabled = false;

  assert.deepEqual(await storage.readJson('settings.json', null), {
    nested: { enabled: true },
    items: [1, 2, 3],
  });
  const raw = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.endsWith('\n\n'), false);

  if (process.platform !== 'win32') {
    assert.equal(modeBits(await fs.stat(path.join(dataDir, 'settings.json'))), 0o600);
  }
});

test('rejects values that JSON cannot represent without loss', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const cycle = {};
  cycle.self = cycle;

  await assert.rejects(storage.writeJson('root-undefined.json', undefined), {
    message: 'Value for root-undefined.json is not JSON serializable',
  });
  await assert.rejects(storage.writeJson('root-function.json', () => {}), {
    message: 'Value for root-function.json is not JSON serializable',
  });
  await assert.rejects(storage.writeJson('nested.json', { keep: true, missing: undefined }), {
    message: 'Value for nested.json is not JSON serializable',
  });
  await assert.rejects(storage.writeJson('nested-function.json', { unsafe() {} }), {
    message: 'Value for nested-function.json is not JSON serializable',
  });
  await assert.rejects(storage.writeJson('bigint.json', { value: 1n }), {
    message: 'Value for bigint.json is not JSON serializable',
  });
  await assert.rejects(storage.writeJson('cycle.json', cycle), {
    message: 'Value for cycle.json is not JSON serializable',
  });
});

test('rejects managed names that are not simple basenames', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const invalidNames = [
    '',
    '.',
    '..',
    'nested/file.json',
    'nested\\file.json',
    path.resolve(dataDir, '..', 'outside.json'),
  ];

  for (const name of invalidNames) {
    await assert.rejects(storage.readJson(name, null), { message: 'Invalid storage name' });
    await assert.rejects(storage.writeJson(name, {}), { message: 'Invalid storage name' });
    await assert.rejects(storage.readEncrypted(name), { message: 'Invalid storage name' });
    await assert.rejects(storage.writeEncrypted(name, {}), { message: 'Invalid storage name' });
    await assert.rejects(storage.remove(name), { message: 'Invalid storage name' });
    await assert.rejects(storage.backup(name, 'valid.bak'), { message: 'Invalid storage name' });
    await assert.rejects(storage.backup('valid.json', name), { message: 'Invalid storage name' });
  }
});

test('malformed JSON throws a stable filename-only error and non-ENOENT errors are not fallbacks', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const marker = 'SENSITIVE_JSON_FRAGMENT';
  await fs.writeFile(path.join(dataDir, 'broken.json'), `{${marker}`, { mode: 0o600 });

  await assert.rejects(storage.readJson('broken.json', { fallback: true }), {
    message: 'Invalid JSON in broken.json',
  });

  await fs.mkdir(path.join(dataDir, 'directory.json'));
  await assert.rejects(storage.readJson('directory.json', { fallback: true }), {
    message: 'Invalid storage file: directory.json',
  });
});

test('remove deletes files and ignores missing targets', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  await storage.writeJson('remove-me.json', { present: true });

  await storage.remove('remove-me.json');
  await storage.remove('remove-me.json');

  assert.equal(await storage.readJson('remove-me.json', null), null);
});

test('partial temp writes preserve the prior destination and clean the temp file', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  await healthyStorage.writeJson('state.json', { generation: 1 });
  const priorBytes = await fs.readFile(path.join(dataDir, 'state.json'));
  let tempWriteCalls = 0;

  const failingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (!path.basename(String(target)).startsWith('.state.json.')) return handle;
      return proxyHandle(handle, {
        write: async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
          tempWriteCalls += 1;
          if (tempWriteCalls === 1) {
            return handle.write(buffer, offset, Math.min(4, length), position);
          }
          const error = new Error('simulated partial write failure');
          error.code = 'EIO';
          throw error;
        },
      });
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });

  await assert.rejects(failingStorage.writeJson('state.json', { generation: 2 }), /simulated partial write failure/);

  assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), priorBytes);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'state.json'), []);
});

test('rename failures preserve the prior destination and clean the temp file', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  await healthyStorage.writeJson('state.json', { generation: 1 });
  const priorBytes = await fs.readFile(path.join(dataDir, 'state.json'));

  const failingFs = {
    ...fs,
    async rename(source, destination) {
      if (destination === path.join(dataDir, 'state.json')) {
        const error = new Error('simulated rename failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.rename(source, destination);
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });

  await assert.rejects(failingStorage.writeJson('state.json', { generation: 2 }), /simulated rename failure/);

  assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), priorBytes);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'state.json'), []);
});

test('temp sync failures preserve the prior destination and clean the temp file', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  await healthyStorage.writeJson('state.json', { generation: 1 });
  const priorBytes = await fs.readFile(path.join(dataDir, 'state.json'));

  const failingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (!path.basename(String(target)).startsWith('.state.json.')) return handle;
      return proxyHandle(handle, {
        sync: async () => {
          const error = new Error('simulated temp sync failure');
          error.code = 'EIO';
          throw error;
        },
      });
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });

  await assert.rejects(failingStorage.writeJson('state.json', { generation: 2 }), /simulated temp sync failure/);

  assert.deepEqual(await fs.readFile(path.join(dataDir, 'state.json')), priorBytes);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'state.json'), []);
});

test('attempts directory fsync with the native filesystem', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'data');
  const probeHandle = await fs.open(root, 'r');
  const handlePrototype = Object.getPrototypeOf(probeHandle);
  const nativeSync = handlePrototype.sync;
  await probeHandle.close();
  let directorySyncCalls = 0;

  handlePrototype.sync = async function sync(...args) {
    if ((await this.stat()).isDirectory()) {
      directorySyncCalls += 1;
      return;
    }
    return Reflect.apply(nativeSync, this, args);
  };

  try {
    const storage = await createStorage({ dataDir });
    await storage.writeJson('state.json', { generation: 1 });
  } finally {
    handlePrototype.sync = nativeSync;
  }

  assert.equal(directorySyncCalls, 2);
});

test('does not swallow arbitrary directory sync errors', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });

  const failingFs = {
    ...fs,
    async open(target, ...args) {
      if (target === dataDir && args[0] === 'r') {
        const error = new Error('simulated directory sync failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.open(target, ...args);
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });

  await assert.rejects(
    failingStorage.writeJson('state.json', { generation: 2 }),
    /simulated directory sync failure/,
  );
  assert.deepEqual(await healthyStorage.readJson('state.json', null), { generation: 2 });
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'state.json'), []);
});

test('propagates a genuine Windows EPERM from directory fsync', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  const failingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (target !== dataDir) return handle;
      return proxyHandle(handle, {
        sync: async () => {
          const error = new Error('simulated genuine directory EPERM');
          error.code = 'EPERM';
          error.syscall = 'fsync';
          throw error;
        },
      });
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });

  await assert.rejects(
    failingStorage.writeJson('state.json', { generation: 2 }),
    /simulated genuine directory EPERM/,
  );
  assert.deepEqual(await healthyStorage.readJson('state.json', null), { generation: 2 });
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'state.json'), []);
});

test('concurrent writes use distinct same-directory temp paths', async (t) => {
  const dataDir = await makeTempDir(t);
  await createStorage({ dataDir });
  const openedTemps = [];
  const observingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      if (path.basename(String(target)).startsWith('.parallel.json.')) openedTemps.push(String(target));
      if (target === dataDir) return proxyHandle(handle, { sync: async () => {} });
      return handle;
    },
  };
  const storage = await createStorage({ dataDir, fsApi: observingFs });

  await Promise.all([
    storage.writeJson('parallel.json', { writer: 1 }),
    storage.writeJson('parallel.json', { writer: 2 }),
  ]);

  assert.equal(openedTemps.length, 2);
  assert.equal(new Set(openedTemps).size, 2);
  assert.equal(openedTemps.every((tempPath) => path.dirname(tempPath) === dataDir), true);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'parallel.json'), []);
});

test('backup is exclusive, byte-identical, and idempotent', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const original = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x7f]);
  await fs.writeFile(path.join(dataDir, 'source.bin'), original, { mode: 0o600 });

  assert.equal(await storage.backup('source.bin', 'source.bin.bak'), true);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'source.bin.bak')), original);

  await fs.writeFile(path.join(dataDir, 'source.bin'), Buffer.from('replacement'));
  assert.equal(await storage.backup('source.bin', 'source.bin.bak'), false);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'source.bin.bak')), original);

  if (process.platform !== 'win32') {
    assert.equal(modeBits(await fs.stat(path.join(dataDir, 'source.bin.bak'))), 0o600);
  }
});

test('backup never exposes a partial final file and cleans a failed temp write', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  const source = Buffer.from('complete backup source');
  const backupPath = path.join(dataDir, 'source.bin.bak');
  await fs.writeFile(path.join(dataDir, 'source.bin'), source, { mode: 0o600 });
  const partialStarted = createDeferred();
  const releaseWrite = createDeferred();
  t.after(() => releaseWrite.resolve());
  let writeCalls = 0;
  const failingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      const isBackupWrite = target === backupPath || isTempPath(target, 'source.bin.bak');
      if (!isBackupWrite) return handle;
      return proxyHandle(handle, {
        write: async (buffer, offset = 0, length = buffer.length - offset, position = null) => {
          writeCalls += 1;
          if (writeCalls === 1) {
            const result = await handle.write(buffer, offset, Math.min(4, length), position);
            partialStarted.resolve();
            await releaseWrite.promise;
            return result;
          }
          const error = new Error('simulated backup temp write failure');
          error.code = 'EIO';
          throw error;
        },
      });
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });
  const backupPromise = failingStorage.backup('source.bin', 'source.bin.bak');

  await waitForSignal(partialStarted.promise, 'a partial backup write');
  let finalWasAbsent = false;
  try {
    await fs.stat(backupPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    finalWasAbsent = true;
  } finally {
    releaseWrite.resolve();
  }

  await assert.rejects(backupPromise, /simulated backup temp write failure/);
  assert.equal(finalWasAbsent, true);
  await assert.rejects(fs.stat(backupPath), { code: 'ENOENT' });
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'source.bin.bak'), []);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'source.bin')), source);
  assert.equal(await healthyStorage.backup('source.bin', 'source.bin.bak'), true);
  assert.deepEqual(await fs.readFile(backupPath), source);
});

test('a failing backup writer cannot strand a concurrent caller without a valid backup', async (t) => {
  const dataDir = await makeTempDir(t);
  const healthyStorage = await createStorage({ dataDir });
  const source = Buffer.from('concurrent backup source');
  const backupPath = path.join(dataDir, 'source.bin.bak');
  await fs.writeFile(path.join(dataDir, 'source.bin'), source, { mode: 0o600 });
  const syncStarted = createDeferred();
  const releaseSync = createDeferred();
  t.after(() => releaseSync.resolve());
  let intercepted = false;
  const failingFs = {
    ...fs,
    async open(target, ...args) {
      const handle = await fs.open(target, ...args);
      const isBackupWrite = target === backupPath || isTempPath(target, 'source.bin.bak');
      if (intercepted || !isBackupWrite) return handle;
      intercepted = true;
      return proxyHandle(handle, {
        sync: async () => {
          syncStarted.resolve();
          await releaseSync.promise;
          const error = new Error('simulated backup temp sync failure');
          error.code = 'EIO';
          throw error;
        },
      });
    },
  };
  const failingStorage = await createStorage({ dataDir, fsApi: failingFs });
  const failingBackup = failingStorage.backup('source.bin', 'source.bin.bak');

  await waitForSignal(syncStarted.promise, 'a backup temp sync');
  let concurrentResult;
  try {
    concurrentResult = await healthyStorage.backup('source.bin', 'source.bin.bak');
  } finally {
    releaseSync.resolve();
  }
  await assert.rejects(failingBackup, /simulated backup temp sync failure/);

  assert.equal(concurrentResult, true);
  assert.deepEqual(await fs.readFile(backupPath), source);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'source.bin.bak'), []);
});

test('concurrent backup callers publish exactly one complete backup', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const source = Buffer.alloc(64 * 1024, 0xa7);
  await fs.writeFile(path.join(dataDir, 'source.bin'), source, { mode: 0o600 });

  const results = await Promise.all([
    storage.backup('source.bin', 'source.bin.bak'),
    storage.backup('source.bin', 'source.bin.bak'),
    storage.backup('source.bin', 'source.bin.bak'),
  ]);

  assert.deepEqual(results.sort(), [false, false, true]);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'source.bin.bak')), source);
  assert.deepEqual(tempFiles(await fs.readdir(dataDir), 'source.bin.bak'), []);
});

test('rejects a file replaced between path inspection and handle verification', async (t) => {
  const root = await makeTempDir(t);
  const dataDir = path.join(root, 'data');
  const storage = await createStorage({ dataDir });
  const targetPath = path.join(dataDir, 'state.json');
  const parkedPath = path.join(dataDir, 'state.json.parked');
  const externalPath = path.join(root, 'replacement.json');
  const marker = 'REPLACEMENT_SECRET_MUST_NOT_BE_READ';
  await storage.writeJson('state.json', { safe: true });
  await fs.writeFile(externalPath, `${JSON.stringify({ marker })}\n`, { mode: 0o600 });
  const racingFs = createPathSwapFs({
    targetPath,
    parkedPath,
    externalPath,
    symlink: false,
  });
  const racingStorage = await createStorage({ dataDir, fsApi: racingFs });

  await assert.rejects(
    racingStorage.readJson('state.json', null),
    (error) => error.message === 'Unsafe symbolic link: state.json'
      && !error.message.includes(marker),
  );
});

test('rejects symlink swaps during key, managed, and backup reads', async (t) => {
  const root = await makeTempDir(t);
  if (!await fileSymlinksAvailable(root)) {
    t.skip('Windows symlink privilege is unavailable');
    return;
  }

  await t.test('secret key swap', async () => {
    const dataDir = path.join(root, 'key-race');
    const keyPath = path.join(dataDir, 'secret.key');
    const parkedPath = path.join(dataDir, 'secret.key.parked');
    const externalPath = path.join(root, 'external-race.key');
    await fs.mkdir(dataDir);
    await fs.writeFile(keyPath, Buffer.alloc(32, 0x11), { mode: 0o600 });
    await fs.writeFile(externalPath, Buffer.alloc(32, 0x77), { mode: 0o600 });
    const racingFs = createPathSwapFs({ targetPath: keyPath, parkedPath, externalPath });

    await assert.rejects(
      createStorage({ dataDir, fsApi: racingFs }),
      { message: 'Unsafe symbolic link: secret.key' },
    );
  });

  await t.test('managed JSON swap', async () => {
    const dataDir = path.join(root, 'read-race');
    const storage = await createStorage({ dataDir });
    const targetPath = path.join(dataDir, 'state.json');
    const parkedPath = path.join(dataDir, 'state.json.parked');
    const externalPath = path.join(root, 'external-race.json');
    const marker = 'RACE_SECRET_MUST_NOT_BE_READ';
    await storage.writeJson('state.json', { safe: true });
    await fs.writeFile(externalPath, `${JSON.stringify({ marker })}\n`, { mode: 0o600 });
    const racingFs = createPathSwapFs({ targetPath, parkedPath, externalPath });
    const racingStorage = await createStorage({ dataDir, fsApi: racingFs });

    await assert.rejects(
      racingStorage.readJson('state.json', null),
      (error) => error.message === 'Unsafe symbolic link: state.json'
        && !error.message.includes(marker),
    );
  });

  await t.test('backup source swap', async () => {
    const dataDir = path.join(root, 'backup-race');
    await createStorage({ dataDir });
    const targetPath = path.join(dataDir, 'source.bin');
    const parkedPath = path.join(dataDir, 'source.bin.parked');
    const externalPath = path.join(root, 'external-race.bin');
    const marker = 'RACE_BACKUP_SECRET';
    await fs.writeFile(targetPath, 'safe source', { mode: 0o600 });
    await fs.writeFile(externalPath, marker, { mode: 0o600 });
    const racingFs = createPathSwapFs({ targetPath, parkedPath, externalPath });
    const racingStorage = await createStorage({ dataDir, fsApi: racingFs });

    await assert.rejects(
      racingStorage.backup('source.bin', 'source.bin.bak'),
      (error) => error.message === 'Unsafe symbolic link: source.bin'
        && !error.message.includes(marker),
    );
    await assert.rejects(fs.stat(path.join(dataDir, 'source.bin.bak')), { code: 'ENOENT' });
  });
});

test('rejects symlink key and every managed operation target when symlinks are available', async (t) => {
  const root = await makeTempDir(t);
  const keyDir = path.join(root, 'key-data');
  await fs.mkdir(keyDir);
  const externalKey = path.join(root, 'external.key');
  await fs.writeFile(externalKey, Buffer.alloc(32, 0x11));
  if (!await makeFileSymlink(externalKey, path.join(keyDir, 'secret.key'))) {
    t.skip('Windows symlink privilege is unavailable');
    return;
  }

  await assert.rejects(createStorage({ dataDir: keyDir }), {
    message: 'Unsafe symbolic link: secret.key',
  });

  const dataDir = path.join(root, 'regular-data');
  const storage = await createStorage({ dataDir });
  const externalData = path.join(root, 'external-data');
  await fs.writeFile(externalData, '{}');
  for (const name of ['read.json', 'write.json', 'read.enc', 'write.enc', 'remove.json', 'source-link.bin', 'backup-link.bin']) {
    await makeFileSymlink(externalData, path.join(dataDir, name));
  }
  await fs.writeFile(path.join(dataDir, 'regular-source.bin'), 'source', { mode: 0o600 });

  await assert.rejects(storage.readJson('read.json', null), { message: 'Unsafe symbolic link: read.json' });
  await assert.rejects(storage.writeJson('write.json', {}), { message: 'Unsafe symbolic link: write.json' });
  await assert.rejects(storage.readEncrypted('read.enc'), { message: 'Unsafe symbolic link: read.enc' });
  await assert.rejects(storage.writeEncrypted('write.enc', { token: 'not-in-errors' }), {
    message: 'Unsafe symbolic link: write.enc',
  });
  await assert.rejects(storage.remove('remove.json'), { message: 'Unsafe symbolic link: remove.json' });
  await assert.rejects(storage.backup('source-link.bin', 'copy.bin'), {
    message: 'Unsafe symbolic link: source-link.bin',
  });
  await assert.rejects(storage.backup('regular-source.bin', 'backup-link.bin'), {
    message: 'Unsafe symbolic link: backup-link.bin',
  });
});

test('encrypts, reads, and restarts without storing plaintext', async (t) => {
  const dataDir = await makeTempDir(t);
  const firstStorage = await createStorage({ dataDir });
  const secret = {
    account: 'private-account@example.test',
    token: 'TOP_SECRET_SESSION_TOKEN',
    nested: { accessCode: '13572468' },
  };

  assert.equal(await firstStorage.readEncrypted('session.enc'), null);
  await firstStorage.writeEncrypted('session.enc', secret);

  const bytes = await fs.readFile(path.join(dataDir, 'session.enc'));
  const text = bytes.toString('utf8');
  assert.equal(text.includes(secret.account), false);
  assert.equal(text.includes(secret.token), false);
  assert.equal(text.includes(secret.nested.accessCode), false);

  const secondStorage = await createStorage({ dataDir });
  assert.deepEqual(await secondStorage.readEncrypted('session.enc'), secret);

  if (process.platform !== 'win32') {
    assert.equal(modeBits(await fs.stat(path.join(dataDir, 'session.enc'))), 0o600);
  }
});

test('uses a fresh 12-byte IV and different ciphertext for each encrypted write', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const value = { token: 'same-value-each-time' };

  await storage.writeEncrypted('session.enc', value);
  const first = JSON.parse(await fs.readFile(path.join(dataDir, 'session.enc'), 'utf8'));
  await storage.writeEncrypted('session.enc', value);
  const second = JSON.parse(await fs.readFile(path.join(dataDir, 'session.enc'), 'utf8'));

  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  assert.equal(Buffer.from(second.iv, 'base64').length, 12);
  assert.equal(Buffer.from(first.tag, 'base64').length, 16);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('rejects altered ciphertext, tag, and filename AAD with a stable authentication error', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  await storage.writeEncrypted('session.enc', { token: 'AUTH_ERROR_MUST_NOT_LEAK_THIS' });
  const envelopePath = path.join(dataDir, 'session.enc');
  const originalBytes = await fs.readFile(envelopePath);
  const original = JSON.parse(originalBytes.toString('utf8'));

  for (const field of ['ciphertext', 'tag']) {
    const altered = { ...original, [field]: mutateBase64(original[field]) };
    await fs.writeFile(envelopePath, `${JSON.stringify(altered)}\n`, { mode: 0o600 });
    await assert.rejects(
      storage.readEncrypted('session.enc'),
      (error) => error.message === 'Unable to authenticate encrypted file: session.enc'
        && !error.message.includes(original[field]),
    );
  }

  await fs.writeFile(path.join(dataDir, 'renamed.enc'), originalBytes, { mode: 0o600 });
  await assert.rejects(storage.readEncrypted('renamed.enc'), {
    message: 'Unable to authenticate encrypted file: renamed.enc',
  });
});

test('strictly validates encrypted envelope fields and base64 lengths', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const envelopePath = path.join(dataDir, 'session.enc');
  await storage.writeEncrypted('session.enc', { token: 'hidden' });
  const valid = JSON.parse(await fs.readFile(envelopePath, 'utf8'));

  const cases = [
    { ...valid, tag: undefined },
    { ...valid, extra: true },
    { ...valid, version: 2 },
    { ...valid, algorithm: 'aes-128-gcm' },
    { ...valid, iv: Buffer.alloc(11).toString('base64') },
    { ...valid, iv: `${valid.iv}=` },
    { ...valid, tag: Buffer.alloc(15).toString('base64') },
    { ...valid, tag: valid.tag.replace(/=+$/, '') },
    { ...valid, ciphertext: '' },
    { ...valid, ciphertext: '***not-base64***' },
  ];

  for (const envelope of cases) {
    await fs.writeFile(envelopePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await assert.rejects(storage.readEncrypted('session.enc'), {
      message: 'Invalid encrypted envelope: session.enc',
    });
  }

  await fs.writeFile(envelopePath, '{malformed', { mode: 0o600 });
  await assert.rejects(storage.readEncrypted('session.enc'), {
    message: 'Invalid encrypted envelope: session.enc',
  });
});

test('accepts envelope whitespace and key order but rejects every duplicate top-level member', async (t) => {
  const dataDir = await makeTempDir(t);
  const storage = await createStorage({ dataDir });
  const envelopePath = path.join(dataDir, 'session.enc');
  const secret = { token: 'DUPLICATE_MEMBER_SECRET' };
  await storage.writeEncrypted('session.enc', secret);
  const valid = JSON.parse(await fs.readFile(envelopePath, 'utf8'));
  const reversedEntries = Object.entries(valid).reverse();
  await fs.writeFile(
    envelopePath,
    `  {\n${reversedEntries.map(([key, value]) => `    ${JSON.stringify(key)} : ${JSON.stringify(value)}`).join(',\n')}\n  }  \n`,
    { mode: 0o600 },
  );
  assert.deepEqual(await storage.readEncrypted('session.enc'), secret);

  for (const field of ['version', 'algorithm', 'iv', 'tag', 'ciphertext']) {
    await t.test(`duplicate ${field}`, async () => {
      const members = Object.entries(valid).map(
        ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
      );
      const duplicateKey = field === 'version' ? '\\u0076ersion' : field;
      members.push(`"${duplicateKey}":${JSON.stringify(valid[field])}`);
      await fs.writeFile(envelopePath, `{ ${members.join(', ')} }\n`, { mode: 0o600 });

      await assert.rejects(
        storage.readEncrypted('session.enc'),
        (error) => error.message === 'Invalid encrypted envelope: session.enc'
          && !error.message.includes(secret.token)
          && !error.message.includes(String(valid[field])),
      );
    });
  }
});

test('rejects an encrypted file read with the wrong key', async (t) => {
  const root = await makeTempDir(t);
  const firstDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  const firstStorage = await createStorage({ dataDir: firstDir });
  const secondStorage = await createStorage({ dataDir: secondDir });
  await firstStorage.writeEncrypted('session.enc', { token: 'WRONG_KEY_SECRET' });
  await fs.copyFile(path.join(firstDir, 'session.enc'), path.join(secondDir, 'session.enc'), fsConstants.COPYFILE_EXCL);

  await assert.rejects(
    secondStorage.readEncrypted('session.enc'),
    (error) => error.message === 'Unable to authenticate encrypted file: session.enc'
      && !error.message.includes('WRONG_KEY_SECRET'),
  );
});
