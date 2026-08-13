const { createHash } = require('node:crypto');
const {
  aggregateDeviceRecords,
  normalizeSerial,
  toPublicAggregatedDevice,
} = require('../core/device-aggregation.cjs');

const DEFAULT_REFRESH_CONCURRENCY = 3;

function clone(value) {
  return structuredClone(value);
}

function text(value) {
  return String(value ?? '').trim();
}

function isInvalidAccountError(error) {
  return error?.tokenInvalid === true || error?.status === 401 || error?.status === 403;
}

async function runBounded(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

function createAccountRuntime({
  accountStore,
  cloud,
  scan,
  refreshConcurrency = DEFAULT_REFRESH_CONCURRENCY,
} = {}) {
  if (!accountStore || typeof accountStore.listAccounts !== 'function'
    || typeof accountStore.getPrivateAccounts !== 'function') {
    throw new TypeError('Account runtime requires an account store');
  }
  if (!cloud || typeof cloud.listDevices !== 'function') {
    throw new TypeError('Account runtime requires a cloud client');
  }
  if (typeof scan !== 'function') {
    throw new TypeError('Account runtime requires a LAN scanner');
  }

  const inventories = new Map();
  const accountStates = new Map();
  const localPrinters = new Map();
  let records = new Map();
  let mutationQueue = Promise.resolve();

  function enqueueMutation(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  }

  function synchronizeAccountStates() {
    const accountIds = new Set(accountStore.listAccounts().map(({ accountId }) => accountId));
    for (const accountId of accountStates.keys()) {
      if (!accountIds.has(accountId)) accountStates.delete(accountId);
    }
    for (const accountId of accountIds) {
      if (!accountStates.has(accountId)) {
        accountStates.set(accountId, { accountId, status: 'idle' });
      }
    }
  }

  function rebuildRecords() {
    const currentAccounts = new Map(
      accountStore.getPrivateAccounts().map((account) => [account.accountId, account]),
    );
    const aggregateInputs = [];
    for (const [accountId, inventory] of inventories) {
      const account = currentAccounts.get(accountId);
      if (!account) continue;
      aggregateInputs.push({ account, devices: inventory.devices });
    }

    const nextRecords = new Map();
    for (const record of aggregateDeviceRecords(aggregateInputs)) {
      const local = localPrinters.get(record.serialNumber);
      if (local?.ip) {
        record.device.ip = local.ip;
        record.device.hasLocalAddress = true;
      } else {
        record.device.hasLocalAddress = false;
      }
      nextRecords.set(record.serialNumber, record);
    }
    records = nextRecords;
  }

  function publicAccountStates() {
    synchronizeAccountStates();
    return accountStore.listAccounts().map(({ accountId }) => ({
      ...(accountStates.get(accountId) || { accountId, status: 'idle' }),
    }));
  }

  function snapshot() {
    return clone({
      accounts: accountStore.listAccounts(),
      accountStates: publicAccountStates(),
      devices: [...records.values()].map(toPublicAggregatedDevice),
    });
  }

  async function refreshAccount(account) {
    accountStates.set(account.accountId, { accountId: account.accountId, status: 'refreshing' });
    try {
      const result = await cloud.listDevices(account.accessToken);
      if (!result?.success || !Array.isArray(result.devices)) {
        throw new Error('Unable to refresh Bambu account');
      }

      if (text(result.username) && text(result.username) !== text(account.username)) {
        accountStore.reauthenticateAccount(account.accountId, { username: text(result.username) });
      }
      inventories.set(account.accountId, { devices: clone(result.devices) });
      accountStates.set(account.accountId, { accountId: account.accountId, status: 'connected' });
    } catch (error) {
      accountStates.set(account.accountId, {
        accountId: account.accountId,
        status: isInvalidAccountError(error) ? 'invalid' : 'error',
      });
    }
  }

  async function refreshLanPrinters() {
    try {
      const printers = await scan();
      if (!Array.isArray(printers)) return;
      localPrinters.clear();
      for (const printer of printers) {
        const serialNumber = normalizeSerial(printer?.serial ?? printer?.serialNumber);
        const ip = text(printer?.ip);
        if (serialNumber && ip) localPrinters.set(serialNumber, { ip });
      }
    } catch {
      // A LAN scan failure must not discard cloud inventory or saved accounts.
    }
  }

  async function performRefreshAccounts({ accountId } = {}) {
    const normalizedAccountId = text(accountId);
    const storedAccounts = accountStore.getPrivateAccounts();
    const accounts = normalizedAccountId
      ? storedAccounts.filter((account) => account.accountId === normalizedAccountId)
      : storedAccounts;
    if (normalizedAccountId && accounts.length === 0) {
      throw new Error('Bambu account not found');
    }
    synchronizeAccountStates();
    await runBounded(accounts, refreshConcurrency, refreshAccount);
    await refreshLanPrinters();
    rebuildRecords();
    return snapshot();
  }

  function refreshAccounts(options = {}) {
    return enqueueMutation(() => performRefreshAccounts(options));
  }

  function publicLoginFailure(result) {
    return {
      success: false,
      ...(result?.needVerifyCode === true ? { needVerifyCode: true } : {}),
      ...(result?.needTfa === true ? { needTfa: true } : {}),
      ...(result?.codeExpired === true ? { codeExpired: true } : {}),
      ...(text(result?.message) ? { message: text(result.message) } : {}),
      ...(text(result?.error) ? { error: text(result.error) } : {}),
    };
  }

  async function completeLogin({ account, remark, hasRemark, loginResult }) {
    if (!loginResult?.success || !text(loginResult.accessToken)) {
      return publicLoginFailure(loginResult);
    }
    const publicAccount = accountStore.addAccount({
      account: text(account),
      accessToken: text(loginResult.accessToken),
      username: '',
      ...(hasRemark ? { remark } : {}),
    });
    const nextSnapshot = await performRefreshAccounts();
    return {
      success: true,
      account: nextSnapshot.accounts.find(({ accountId }) => accountId === publicAccount.accountId),
      snapshot: nextSnapshot,
    };
  }

  async function performPasswordLogin(payload = {}) {
    const account = text(payload.account);
    const loginResult = await cloud.loginPassword({
      account,
      password: payload.password,
    });
    return completeLogin({
      account,
      remark: payload.remark,
      hasRemark: Object.hasOwn(payload, 'remark'),
      loginResult,
    });
  }

  function loginPassword(payload = {}) {
    return enqueueMutation(() => performPasswordLogin(payload));
  }

  async function requestVerifyCode(payload = {}) {
    if (typeof cloud.requestVerifyCode !== 'function') {
      return { success: false, error: 'Verification code login is unavailable' };
    }
    const savedAccount = text(payload.accountId)
      ? accountStore.getPrivateAccount(text(payload.accountId))
      : null;
    const suppliedAccount = text(payload.account);
    if (savedAccount?.account && suppliedAccount && suppliedAccount !== savedAccount.account) {
      return { success: false, error: 'Credentials belong to a different Bambu account' };
    }
    const account = suppliedAccount || text(savedAccount?.account);
    if (!account) return { success: false, error: 'Bambu account is required' };
    const result = await cloud.requestVerifyCode({ account });
    return {
      success: result?.success === true,
      ...(text(result?.message) ? { message: text(result.message) } : {}),
      ...(text(result?.error) ? { error: text(result.error) } : {}),
    };
  }

  async function performCodeLogin(payload = {}) {
    if (typeof cloud.loginCode !== 'function') {
      return { success: false, error: 'Verification code login is unavailable' };
    }
    const account = text(payload.account);
    const loginResult = await cloud.loginCode({ account, code: payload.code });
    return completeLogin({
      account,
      remark: payload.remark,
      hasRemark: Object.hasOwn(payload, 'remark'),
      loginResult,
    });
  }

  function loginCode(payload = {}) {
    return enqueueMutation(() => performCodeLogin(payload));
  }

  async function performReauthentication(payload = {}) {
    const accountId = text(payload.accountId);
    const current = accountStore.getPrivateAccount(accountId);
    if (!current) return { success: false, error: 'Bambu account not found' };

    const suppliedAccount = text(payload.account);
    if (current.account && suppliedAccount && suppliedAccount !== current.account) {
      return { success: false, error: 'Credentials belong to a different Bambu account' };
    }
    const account = suppliedAccount || text(current.account);
    if (!account) return { success: false, error: 'Bambu account is required' };

    let loginResult;
    if (payload.method === 'code') {
      if (typeof cloud.loginCode !== 'function') {
        return { success: false, error: 'Verification code login is unavailable' };
      }
      loginResult = await cloud.loginCode({ account, code: payload.code });
    } else {
      if (typeof cloud.loginPassword !== 'function') {
        return { success: false, error: 'Password login is unavailable' };
      }
      loginResult = await cloud.loginPassword({ account, password: payload.password });
    }
    if (!loginResult?.success || !text(loginResult.accessToken)) {
      return publicLoginFailure(loginResult);
    }

    const publicAccount = accountStore.reauthenticateAccount(accountId, {
      account,
      accessToken: text(loginResult.accessToken),
      username: '',
    });
    const nextSnapshot = await performRefreshAccounts();
    return {
      success: true,
      account: nextSnapshot.accounts.find(({ accountId: id }) => id === publicAccount.accountId),
      snapshot: nextSnapshot,
    };
  }

  function reauthenticate(payload = {}) {
    return enqueueMutation(() => performReauthentication(payload));
  }

  function listAccounts() {
    return snapshot();
  }

  async function performRemarkUpdate(accountId, remark) {
    const account = accountStore.updateRemark(text(accountId), remark);
    if (!account) return { success: false, error: 'Bambu account not found' };
    rebuildRecords();
    return { success: true, account, snapshot: snapshot() };
  }


  function updateRemark(accountId, remark) {
    return enqueueMutation(() => performRemarkUpdate(accountId, remark));
  }

  async function performAccountRemoval(accountId) {
    const normalizedAccountId = text(accountId);
    const removed = accountStore.removeAccount(normalizedAccountId);
    if (!removed) return { success: false, error: 'Bambu account not found' };
    inventories.delete(normalizedAccountId);
    accountStates.delete(normalizedAccountId);
    rebuildRecords();
    return { success: true, removed, snapshot: snapshot() };
  }

  function removeAccount(accountId) {
    return enqueueMutation(() => performAccountRemoval(accountId));
  }

  function getRecord(serialNumber) {
    return records.get(normalizeSerial(serialNumber));
  }

  function selectSource(record) {
    if (!record) return null;
    const localSource = record.sources.find(({ device }) => text(device?.accessCode));
    const ip = text(record.device.ip);
    if (ip && localSource) {
      return {
        mode: 'local',
        ip,
        accessCode: text(localSource.device.accessCode),
        source: localSource,
      };
    }

    return record.sources.find(({ account }) => (
      accountStates.get(account.accountId)?.status !== 'invalid'
      && text(account.accessToken)
      && text(account.username)
    )) || null;
  }

  function resolveMqttPayload({ serialNumber } = {}) {
    const record = getRecord(serialNumber);
    const selected = selectSource(record);
    if (!record || !selected) return null;
    if (selected.mode === 'local') {
      return {
        serialNumber: record.serialNumber,
        mode: 'local',
        ip: selected.ip,
        accessCode: selected.accessCode,
      };
    }
    return {
      serialNumber: record.serialNumber,
      mode: 'cloud',
      region: 'China',
      authToken: selected.account.accessToken,
      username: selected.account.username,
    };
  }

  function resolveCameraPayload({ serialNumber } = {}) {
    const record = getRecord(serialNumber);
    const selected = selectSource(record);
    if (!record || !selected || selected.mode !== 'local') return null;
    const payload = {
      serialNumber: record.serialNumber,
      dev_id: record.serialNumber,
      name: text(record.device.name) || record.serialNumber,
      ip: selected.ip,
      accessCode: selected.accessCode,
    };
    for (const field of ['model', 'modelCode', 'cameraMode']) {
      const value = text(record.device[field]);
      if (value) payload[field] = value;
    }
    return payload;
  }

  function getConnectionFingerprints() {
    const fingerprints = {};
    for (const serialNumber of [...records.keys()].sort()) {
      const payload = resolveMqttPayload({ serialNumber });
      if (!payload) continue;
      const privateMaterial = payload.mode === 'local'
        ? [payload.mode, payload.serialNumber, payload.ip, payload.accessCode]
        : [payload.mode, payload.serialNumber, payload.region, payload.authToken, payload.username];
      fingerprints[serialNumber] = createHash('sha256')
        .update(JSON.stringify(privateMaterial))
        .digest('hex');
    }
    return fingerprints;
  }

  synchronizeAccountStates();

  return {
    getConnectionFingerprints,
    listAccounts,
    loginCode,
    loginPassword,
    reauthenticate,
    refreshAccounts,
    removeAccount,
    requestVerifyCode,
    resolveCameraPayload,
    resolveMqttPayload,
    snapshot,
    updateRemark,
  };
}

module.exports = {
  DEFAULT_REFRESH_CONCURRENCY,
  createAccountRuntime,
};
