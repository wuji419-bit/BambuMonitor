const { validatePublicAccount } = require('../core/account-records.cjs');
const { projectPublicDeviceValue } = require('../core/device-aggregation.cjs');

const ACCOUNT_CHANGED_CHANNEL = 'accounts-changed';
const ACCOUNT_IPC_CHANNELS = Object.freeze({
  list: 'accounts-list',
  loginPassword: 'accounts-login-password',
  requestCode: 'accounts-code-request',
  loginCode: 'accounts-login-code',
  updateRemark: 'accounts-update-remark',
  reauthenticate: 'accounts-reauthenticate',
  remove: 'accounts-remove',
  refresh: 'accounts-refresh',
});
const PUBLIC_ACCOUNT_STATUSES = new Set(['idle', 'refreshing', 'connected', 'invalid', 'error']);

function text(value) {
  return String(value ?? '').trim();
}

function projectPublicAccount(value) {
  try {
    return validatePublicAccount({
      accountId: value?.accountId,
      accountMasked: value?.accountMasked,
      remark: value?.remark,
      label: value?.label,
      savedAt: value?.savedAt,
      updatedAt: value?.updatedAt,
    });
  } catch {
    return null;
  }
}

function projectAccountState(value) {
  const accountId = text(value?.accountId);
  const status = text(value?.status);
  if (!accountId || !PUBLIC_ACCOUNT_STATUSES.has(status)) return null;
  return { accountId, status };
}

function projectSnapshot(value = {}) {
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.map(projectPublicAccount).filter(Boolean)
    : [];
  const accountIds = new Set(accounts.map(({ accountId }) => accountId));
  const accountLabels = new Set(accounts.map(({ label }) => label));
  return {
    accounts,
    accountStates: Array.isArray(value.accountStates)
      ? value.accountStates
        .map(projectAccountState)
        .filter((state) => state && accountIds.has(state.accountId))
      : [],
    devices: Array.isArray(value.devices)
      ? value.devices.map((device) => {
        const projected = projectPublicDeviceValue(device);
        const safeIds = projected.accountIds.filter((accountId) => accountIds.has(accountId));
        const safeLabels = projected.accountLabels.filter((label) => accountLabels.has(label));
        const name = text(projected.name) || text(projected.dev_id);
        return {
          ...projected,
          accountIds: safeIds,
          accountLabels: safeLabels,
          displayName: accounts.length > 1 && safeLabels.length
            ? `${name}（${safeLabels.join(' / ')}）`
            : name,
        };
      })
      : [],
  };
}

function projectOperationResult(value = {}) {
  const result = { success: value.success === true };
  for (const field of ['needVerifyCode', 'needTfa', 'codeExpired']) {
    if (value[field] === true) result[field] = true;
  }
  for (const field of ['message', 'error']) {
    const projected = text(value[field]);
    if (projected) result[field] = projected.slice(0, 500);
  }
  const account = projectPublicAccount(value.account);
  if (account) result.account = account;
  const removed = projectPublicAccount(value.removed);
  if (removed) result.removed = removed;
  if (value.snapshot) result.snapshot = projectSnapshot(value.snapshot);
  return result;
}

function readConnectionFingerprints(runtime) {
  if (typeof runtime?.getConnectionFingerprints !== 'function') return {};
  const value = runtime.getConnectionFingerprints();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fingerprints = {};
  for (const [serialNumber, fingerprint] of Object.entries(value)) {
    const serial = text(serialNumber);
    const normalizedFingerprint = text(fingerprint);
    if (serial && normalizedFingerprint) fingerprints[serial] = normalizedFingerprint;
  }
  return fingerprints;
}

function createConnectionPlan(before, after) {
  const changed = [];
  const removed = [];
  for (const serialNumber of Object.keys(before)) {
    if (!Object.hasOwn(after, serialNumber)) removed.push(serialNumber);
    else if (before[serialNumber] !== after[serialNumber]) changed.push(serialNumber);
  }
  return {
    disconnectSerials: [...new Set([...removed, ...changed])].sort(),
    reconnectSerials: changed.sort(),
  };
}

function registerAccountIpc({
  ipcMain,
  getRuntime,
  emit = () => {},
  reconcileConnections = async () => {},
  logger,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('Account IPC requires ipcMain');
  }
  if (typeof getRuntime !== 'function') {
    throw new TypeError('Account IPC requires a runtime provider');
  }
  if (typeof reconcileConnections !== 'function') {
    throw new TypeError('Account IPC requires a connection reconciler');
  }

  let operationQueue = Promise.resolve();

  function handle(channel, operation) {
    ipcMain.handle(channel, (_event, payload = {}) => {
      const execute = async () => {
        try {
          const runtime = getRuntime();
          const before = readConnectionFingerprints(runtime);
          const value = await operation(runtime, payload);
          const result = projectOperationResult(value);
          if (result.success && result.snapshot) {
            const plan = createConnectionPlan(before, readConnectionFingerprints(runtime));
            if (plan.disconnectSerials.length > 0) {
              try {
                await reconcileConnections(plan);
              } catch (error) {
                logger?.warn?.({
                  operation: 'desktop-account-connection-reconcile-failed',
                  errorName: text(error?.name) || 'Error',
                });
              }
            }
            emit(ACCOUNT_CHANGED_CHANNEL, result.snapshot);
          }
          return result;
        } catch (error) {
          logger?.warn?.({
            operation: 'desktop-account-ipc-failed',
            channel,
            errorName: text(error?.name) || 'Error',
          });
          return { success: false, error: 'Desktop account operation failed' };
        }
      };
      const result = operationQueue.then(execute, execute);
      operationQueue = result.catch(() => {});
      return result;
    });
  }

  handle(ACCOUNT_IPC_CHANNELS.list, (runtime) => ({
    success: true,
    snapshot: runtime.listAccounts(),
  }));
  handle(ACCOUNT_IPC_CHANNELS.loginPassword, (runtime, payload) => runtime.loginPassword(payload));
  handle(ACCOUNT_IPC_CHANNELS.requestCode, (runtime, payload) => runtime.requestVerifyCode(payload));
  handle(ACCOUNT_IPC_CHANNELS.loginCode, (runtime, payload) => runtime.loginCode(payload));
  handle(ACCOUNT_IPC_CHANNELS.updateRemark, (runtime, payload) => (
    runtime.updateRemark(payload?.accountId, payload?.remark)
  ));
  handle(ACCOUNT_IPC_CHANNELS.reauthenticate, (runtime, payload) => runtime.reauthenticate(payload));
  handle(ACCOUNT_IPC_CHANNELS.remove, (runtime, payload) => runtime.removeAccount(payload?.accountId));
  handle(ACCOUNT_IPC_CHANNELS.refresh, async (runtime, payload) => ({
    success: true,
    snapshot: await runtime.refreshAccounts(payload),
  }));
}

function hasLegacyMqttConnectionData(payload = {}) {
  return ['ip', 'accessCode', 'authToken', 'username'].some((field) => text(payload[field]));
}

function readRuntime(runtimeOrProvider) {
  return typeof runtimeOrProvider === 'function' ? runtimeOrProvider() : runtimeOrProvider;
}

function resolveManagedMqttPayload(runtimeOrProvider, payload = {}) {
  if (!text(payload.serialNumber) || hasLegacyMqttConnectionData(payload)) return { ...payload };
  const runtime = readRuntime(runtimeOrProvider);
  const resolved = runtime?.resolveMqttPayload?.({ serialNumber: payload.serialNumber });
  if (!resolved) throw new Error('No saved connection source for this printer');
  return resolved;
}

function resolveManagedCameraPayload(runtimeOrProvider, payload = {}) {
  if (!text(payload.serialNumber) || (text(payload.ip) && text(payload.accessCode))) return { ...payload };
  const runtime = readRuntime(runtimeOrProvider);
  const request = {
    serialNumber: payload.serialNumber,
    ...(text(payload.ip) ? { ip: text(payload.ip) } : {}),
  };
  const resolved = runtime?.resolveCameraPayload?.(request);
  if (!resolved) throw new Error('No saved camera source for this printer');
  return resolved;
}

module.exports = {
  ACCOUNT_CHANGED_CHANNEL,
  ACCOUNT_IPC_CHANNELS,
  projectOperationResult,
  projectSnapshot,
  registerAccountIpc,
  resolveManagedCameraPayload,
  resolveManagedMqttPayload,
};
