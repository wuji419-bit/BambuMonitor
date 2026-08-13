# BambuMonitor Multi-Account Device Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one BambuMonitor window securely keep multiple Bambu accounts, aggregate all printers by serial number, and show an optional account remark after every printer name on desktop and Docker/NAS.

**Architecture:** Add shared account identity and display helpers, then replace both single-account stores with versioned multi-account repositories that migrate old data. The NAS runtime and Electron main process remain the only owners of private credentials; renderer APIs receive public account records and aggregated devices, while one MQTT connection and one camera source are selected per printer serial.

**Tech Stack:** React 19, Electron 40, Node.js ESM/CommonJS, Node test runner, Vite, MQTT, WebSocket, encrypted local storage, Playwright for visual verification.

---

## File Map

- Create `core/account-records.cjs`: normalize remarks, mask accounts, build stable private/public account records, and merge public labels without exposing credentials.
- Create `core/device-aggregation.cjs`: aggregate cloud inventories by printer serial and choose one source account deterministically.
- Create `electron/account-store.cjs`: protected desktop account repository, atomic persistence, and migration from `bambu-auth-session.json`.
- Create `electron/account-runtime.cjs`: query all desktop accounts, cache private printer sources, and resolve account credentials for one MQTT/camera source per serial.
- Modify `electron/main.cjs` and `electron/preload.cjs`: expose constrained account IPC and resolve private credentials in the main process.
- Modify `server/session-store.js`: migrate encrypted v1 `{ bambu }` storage to v2 `{ accounts }`, while keeping browser sessions independent from Bambu accounts.
- Modify `server/device-runtime.js`: accept multiple accounts, aggregate by serial, isolate account failures, and keep a single MQTT connection per serial.
- Modify `server/http-app.js` and `server/index.js`: add authenticated account routes/events and start the runtime with every stored account.
- Create `src/utils/accountPresentation.js`: use `displayName` consistently without mutating the original printer name.
- Create `src/components/monitor/AccountLoginDialog.jsx`: reusable password/code login plus optional post-login remark step.
- Create `src/components/monitor/AccountCenter.jsx`: list, add, rename, reauthenticate, and remove accounts.
- Modify renderer services, `src/App.jsx`, monitor components, notifications, and CSS to consume the public multi-account contracts.
- Modify `package.json`, NAS documentation, and focused tests so every new module is part of standard verification.

### Task 1: Shared Account Identity And Device Aggregation

**Files:**
- Create: `core/account-records.cjs`
- Create: `core/account-records.test.cjs`
- Create: `core/device-aggregation.cjs`
- Create: `core/device-aggregation.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing account identity tests**

```js
test('normalizes optional remarks and masks phone and email accounts', () => {
  assert.equal(normalizeRemark('  公司账号  '), '公司账号');
  assert.equal(normalizeRemark('   '), '');
  assert.equal(normalizeRemark('甲'.repeat(45)), '甲'.repeat(40));
  assert.equal(maskAccount('13812345678'), '138****5678');
  assert.equal(maskAccount('maker@example.com'), 'm***@example.com');
});

test('public records prefer remark and never expose credentials', () => {
  const record = createAccountRecord({
    account: '13812345678', accessToken: 'secret', username: 'maker', remark: '公司',
  }, { accountId: 'acc-1', timestamp: 100 });
  assert.deepEqual(toPublicAccount(record), {
    accountId: 'acc-1', accountMasked: '138****5678', remark: '公司',
    label: '公司', savedAt: 100, updatedAt: 100,
  });
  assert.equal(JSON.stringify(toPublicAccount(record)).includes('secret'), false);
});
```

- [ ] **Step 2: Run the account identity tests and verify RED**

Run: `node --test core/account-records.test.cjs`

Expected: FAIL because `core/account-records.cjs` does not exist.

- [ ] **Step 3: Implement the account identity helpers**

```js
const MAX_REMARK_LENGTH = 40;

function normalizeRemark(value) {
  return String(value || '').trim().slice(0, MAX_REMARK_LENGTH);
}

function maskAccount(value) {
  const account = String(value || '').trim();
  if (/^\d{7,}$/.test(account)) return `${account.slice(0, 3)}****${account.slice(-4)}`;
  const at = account.indexOf('@');
  if (at > 0) return `${account[0]}***${account.slice(at)}`;
  return account.length > 4 ? `${account.slice(0, 2)}***${account.slice(-2)}` : '***';
}

function accountLabel(record) {
  return normalizeRemark(record?.remark) || String(record?.accountMasked || maskAccount(record?.account));
}
```

Export `normalizeRemark`, `maskAccount`, `accountLabel`, `createAccountRecord`, `updateAccountRecord`, `toPublicAccount`, and strict validators. Preserve an existing remark when duplicate raw account credentials are refreshed without an explicit `remark` property.

- [ ] **Step 4: Run the account identity tests and verify GREEN**

Run: `node --test core/account-records.test.cjs`

Expected: PASS.

- [ ] **Step 5: Write failing aggregation tests**

```js
test('merges duplicate serials and keeps account labels in insertion order', () => {
  const devices = aggregateDeviceInventories([
    { account: { accountId: 'a', label: '公司' }, devices: [{ id: 'SERIAL', name: 'A2L01' }] },
    { account: { accountId: 'b', label: '工作室' }, devices: [{ id: 'SERIAL', name: 'A2L01' }] },
  ]);
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].accountIds, ['a', 'b']);
  assert.deepEqual(devices[0].accountLabels, ['公司', '工作室']);
  assert.equal(devices[0].displayName, 'A2L01（公司 / 工作室）');
});

test('source removal retains a printer owned by another account', () => {
  const devices = aggregateDeviceInventories([
    { account: { accountId: 'b', label: '工作室' }, devices: [{ id: 'SERIAL', name: 'A2L01' }] },
  ]);
  assert.deepEqual(devices.map(({ dev_id }) => dev_id), ['SERIAL']);
});
```

- [ ] **Step 6: Run aggregation tests and verify RED**

Run: `node --test core/device-aggregation.test.cjs`

Expected: FAIL because `aggregateDeviceInventories` is missing.

- [ ] **Step 7: Implement deterministic aggregation**

```js
function aggregateDeviceInventories(inventories) {
  const records = new Map();
  for (const inventory of inventories) {
    for (const raw of inventory.devices || []) {
      const serial = normalizeSerial(raw.id ?? raw.dev_id);
      if (!serial) continue;
      const record = records.get(serial) || createAggregate(serial, raw);
      addSource(record, inventory.account, raw);
      records.set(serial, record);
    }
  }
  return [...records.values()].map(toPublicDevice);
}
```

Keep private source credentials in a non-public `sources` collection. Public output may contain only random `accountIds`, safe `accountLabels`, `displayName`, and existing device telemetry fields.

- [ ] **Step 8: Run shared tests and commit**

Run: `node --test core/account-records.test.cjs core/device-aggregation.test.cjs`

Expected: PASS.

```bash
git add core/account-records.cjs core/account-records.test.cjs core/device-aggregation.cjs core/device-aggregation.test.cjs package.json
git commit -m "feat: add multi-account aggregation primitives"
```

### Task 2: Desktop Protected Account Repository

**Files:**
- Create: `electron/account-store.cjs`
- Create: `electron/account-store.test.cjs`
- Modify: `electron/auth-session.cjs`
- Modify: `electron/auth-session.test.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing repository and migration tests**

```js
test('migrates one protected legacy session without requiring login', () => {
  writeAuthSession(dir, { account: 'old@example.com', accessToken: 'token-old', savedAt: 10 }, protection);
  const store = createAccountStore({ userDataPath: dir, protection, randomId: () => 'acc-old', now: () => 20 });
  assert.deepEqual(store.listAccounts().map(({ accountId, remark }) => ({ accountId, remark })), [
    { accountId: 'acc-old', remark: '' },
  ]);
  assert.equal(store.getPrivateAccount('acc-old').accessToken, 'token-old');
  assert.equal(fs.existsSync(getAuthSessionPath(dir)), false);
});

test('refreshing duplicate credentials preserves the existing remark', () => {
  const store = createAccountStore(dependencies);
  const first = store.addAccount({ account: 'user@example.com', accessToken: 'one', remark: '公司' });
  const second = store.addAccount({ account: 'user@example.com', accessToken: 'two' });
  assert.equal(second.accountId, first.accountId);
  assert.equal(second.remark, '公司');
  assert.equal(store.getPrivateAccount(first.accountId).accessToken, 'two');
});
```

- [ ] **Step 2: Run repository tests and verify RED**

Run: `node --test electron/account-store.test.cjs`

Expected: FAIL because `electron/account-store.cjs` does not exist.

- [ ] **Step 3: Implement versioned protected storage and atomic migration**

```js
function persistRepository(pathname, repository, protection) {
  const temporary = `${pathname}.tmp`;
  const envelope = protectRepository(repository, protection);
  fs.writeFileSync(temporary, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, pathname);
  return readRepository(pathname, protection);
}
```

Expose synchronous `listAccounts`, `addAccount`, `updateRemark`, `reauthenticateAccount`, `removeAccount`, and `getPrivateAccount`. Migrate only when the new repository is absent; verify the written repository by reading it back before deleting the old file. On any migration error, retain the old file and return a recoverable error without overwriting credentials.

- [ ] **Step 4: Run repository and legacy tests and verify GREEN**

Run: `node --test electron/account-store.test.cjs electron/auth-session.test.cjs`

Expected: PASS.

- [ ] **Step 5: Commit the desktop repository**

```bash
git add electron/account-store.cjs electron/account-store.test.cjs electron/auth-session.cjs electron/auth-session.test.cjs package.json
git commit -m "feat: persist multiple desktop accounts securely"
```

### Task 3: NAS Account Repository And V1 Migration

**Files:**
- Modify: `server/session-store.js`
- Modify: `server/session-store.test.js`

- [ ] **Step 1: Replace single-account expectations with failing v2 migration tests**

```js
test('migrates encrypted v1 bambu state to v2 accounts and preserves browser sessions', async () => {
  const storage = memoryStorage({ version: 1, bambu: { ...BAMBU, savedAt: 50 }, sessions: [SESSION] });
  const store = await createAt(storage, { value: 100 }, { randomBytes: deterministicBytes });
  const accounts = store.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].remark, '');
  assert.notEqual(await store.authenticate(rawSessionId), null);
  assert.equal(storage.value.version, 2);
  assert.equal(Object.hasOwn(storage.value, 'bambu'), false);
});

test('adding a second Bambu account keeps existing browser sessions valid', async () => {
  const store = await createAt(memoryStorage(), { value: 100 });
  const browser = await store.create(BAMBU);
  await store.addAccount({ account: 'second@example.test', accessToken: 'second', username: 'Second', remark: '' });
  assert.notEqual(await store.authenticate(browser.sessionId), null);
  assert.equal(store.listAccounts().length, 2);
});
```

- [ ] **Step 2: Run the store tests and verify RED**

Run: `node --test server/session-store.test.js`

Expected: FAIL because the persisted state still has the exact v1 `{ bambu }` shape.

- [ ] **Step 3: Implement v2 accounts while retaining browser session semantics**

```js
const CURRENT_VERSION = 2;

function migrateState(value, accountId) {
  if (value?.version !== 1) return validateV2State(value);
  return {
    version: 2,
    accounts: [createAccountRecord(value.bambu, { accountId, timestamp: value.bambu.savedAt })],
    sessions: value.sessions.map(validateSession),
  };
}
```

Keep `create(input)` as the initial account plus local browser-session operation for upgrade compatibility. Add `listAccounts`, `getPrivateAccounts`, `addAccount`, `updateRemark`, `reauthenticateAccount`, and `removeAccount`. Adding or updating a Bambu account must not invalidate browser sessions; removing the final account removes the encrypted state and causes authentication to fail.

- [ ] **Step 4: Verify mutation failure reconciliation and secret protection**

Add tests proving failed writes leave memory unchanged, post-commit errors reconcile with disk, account/token values remain encrypted, duplicate raw accounts update in place, and removal persists before returning.

Run: `node --test server/session-store.test.js server/storage.test.js`

Expected: PASS.

- [ ] **Step 5: Commit the NAS repository migration**

```bash
git add server/session-store.js server/session-store.test.js
git commit -m "feat: migrate NAS sessions to multiple accounts"
```

### Task 4: Multi-Account Device Runtime

**Files:**
- Modify: `server/device-runtime.js`
- Modify: `server/device-runtime.test.js`
- Modify: `server/public-device.js`
- Create: `server/public-device.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write failing runtime aggregation and isolation tests**

```js
test('starts all accounts and creates one connection for a duplicate serial', async () => {
  await runtime.start({ accounts: [ACCOUNT_A, ACCOUNT_B] });
  assert.deepEqual(runtime.snapshot().devices.map(({ dev_id }) => dev_id), ['SERIAL']);
  assert.deepEqual(runtime.snapshot().devices[0].accountLabels, ['公司', '工作室']);
  assert.equal(mqtt.connect.calls.filter(([payload]) => payload.serialNumber === 'SERIAL').length, 1);
});

test('one invalid account does not emit session invalid or stop another account', async () => {
  cloud.listDevicesFor.mockAccountFailure('a', { status: 401, tokenInvalid: true });
  await runtime.refresh();
  assert.equal(events.some(({ type }) => type === 'session.invalid'), false);
  assert.equal(events.some(({ type, accountId }) => type === 'account.invalid' && accountId === 'a'), true);
  assert.equal(runtime.snapshot().devices.some(({ accountIds }) => accountIds.includes('b')), true);
});
```

- [ ] **Step 2: Run focused runtime tests and verify RED**

Run: `node --test server/device-runtime.test.js`

Expected: FAIL because `start` accepts one credential set and duplicate inventories are not aggregated.

- [ ] **Step 3: Replace global credentials with account source state**

```js
const accounts = new Map();
const inventories = new Map();

async function refreshAccount(account, signal) {
  try {
    const result = await cloud.listDevices(account.accessToken);
    inventories.set(account.accountId, { account: publicAccount(account), devices: result.devices || [] });
    emit({ type: 'account.updated', account: runtimeAccount(account, 'connected') });
  } catch (error) {
    const state = isInvalidToken(error) ? 'invalid' : 'error';
    emit({ type: state === 'invalid' ? 'account.invalid' : 'account.updated', accountId: account.accountId });
  }
}
```

Use bounded concurrency for account refreshes, aggregate all successful/last-known inventories by serial, then perform one LAN scan. Select local credentials first; otherwise use the first valid source account. A remark-only update recalculates labels and emits snapshots without changing the MQTT connection fingerprint.

- [ ] **Step 4: Add incremental add/remove/failover tests and implementation**

Test `addAccount`, `updateAccount`, and `removeAccount` directly. Removing one duplicate source must retain the record and connection; removing its active cloud source must reconnect once with the next source; removing the final source must disconnect MQTT and release its camera source. Keep the existing `start({ accessToken, username })` adapter only for migration-facing tests, internally converting it to one synthetic account.

- [ ] **Step 5: Verify public projection contains no secrets**

Create `server/public-device.test.js`, add it to the standard test scripts, and run:

Run: `node --test server/device-runtime.test.js server/public-device.test.js server/camera-source-manager.test.js`

Expected: PASS and serialized snapshots contain no raw account, token, access code, or local IP fields beyond the existing safe address indicators.

- [ ] **Step 6: Commit the multi-account runtime**

```bash
git add server/device-runtime.js server/device-runtime.test.js server/public-device.js server/public-device.test.js server/index.js package.json
git commit -m "feat: aggregate printers across account runtimes"
```

### Task 5: NAS HTTP And Desktop IPC Account Contracts

**Files:**
- Create: `electron/account-runtime.cjs`
- Create: `electron/account-runtime.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `server/http-app.js`
- Modify: `server/http-app.test.js`
- Modify: `server/index.test.js`

- [ ] **Step 1: Write failing authenticated account route tests**

```js
test('authenticated browser can add, rename, and remove a second account', async () => {
  const login = await initialLogin();
  const added = await post('/api/accounts/login', SECOND_LOGIN, login.csrf);
  assert.equal(added.status, 200);
  const renamed = await patch(`/api/accounts/${added.data.account.accountId}`, { remark: '工作室' }, login.csrf);
  assert.equal(renamed.data.account.label, '工作室');
  const removed = await del(`/api/accounts/${added.data.account.accountId}`, login.csrf);
  assert.equal(removed.data.authenticated, true);
});

test('account mutations reject missing CSRF and never return private credentials', async () => {
  assert.equal((await post('/api/accounts/login', SECOND_LOGIN)).status, 403);
  assert.equal(JSON.stringify((await get('/api/accounts')).data).includes('accessToken'), false);
});
```

- [ ] **Step 2: Run HTTP tests and verify RED**

Run: `node --test server/http-app.test.js server/index.test.js`

Expected: FAIL with account routes not found.

- [ ] **Step 3: Implement NAS account routes and account-scoped events**

Add:

```text
GET    /api/accounts
POST   /api/accounts/login
POST   /api/accounts/code/request
POST   /api/accounts/code/verify
PATCH  /api/accounts/:accountId
DELETE /api/accounts/:accountId
POST   /api/accounts/:accountId/refresh
```

All routes except initial `/api/auth/*` require a valid browser session, same-origin mutation checks, and CSRF. Persist account changes before changing runtime state. Deleting the final account clears the browser cookie and closes session sockets; deleting any other account leaves the browser session alive.

- [ ] **Step 4: Write failing desktop IPC/runtime tests**

```js
test('desktop refresh returns one safe device and resolves its source privately', async () => {
  const result = await runtime.refreshAccounts();
  assert.equal(result.devices.length, 1);
  assert.equal(JSON.stringify(result).includes('token-a'), false);
  assert.equal(runtime.resolveMqttPayload({ serialNumber: 'SERIAL' }).authToken, 'token-a');
});
```

- [ ] **Step 5: Implement constrained desktop account IPC**

Expose renderer-safe methods `list`, `add`, `updateRemark`, `reauthenticate`, `remove`, and `refreshDevices`. Keep private credentials inside `electron/account-store.cjs` and `electron/account-runtime.cjs`. Extend main-process MQTT and camera handlers to accept a serial/account source reference and resolve token/access code privately before calling existing managers.

- [ ] **Step 6: Run IPC, HTTP, security, and main process tests**

Run: `node --test electron/account-runtime.test.cjs electron/account-store.test.cjs server/http-app.test.js server/http-security.test.js server/index.test.js`

Expected: PASS.

- [ ] **Step 7: Commit transport contracts**

```bash
git add electron/account-runtime.cjs electron/account-runtime.test.cjs electron/main.cjs electron/preload.cjs server/http-app.js server/http-app.test.js server/index.test.js
git commit -m "feat: expose secure multi-account runtime APIs"
```

### Task 6: Renderer Runtime Services And Account State

**Files:**
- Modify: `src/services/electron.js`
- Modify: `src/services/web.js`
- Modify: `src/services/web.test.js`
- Modify: `src/services/runtime.js`
- Modify: `src/services/runtime.test.js`
- Modify: `src/App.jsx`

- [ ] **Step 1: Write failing renderer contract tests**

```js
test('web runtime keeps its browser session when one Bambu account becomes invalid', () => {
  socket.message({ type: 'account.invalid', accountId: 'acc-a' });
  assert.equal(sessionInvalidCalls, 0);
  assert.deepEqual(accountInvalidEvents, [{ type: 'account.invalid', accountId: 'acc-a' }]);
});

test('account service lists and mutates accounts with CSRF', async () => {
  await runtime.accounts.updateRemark('acc-a', '公司');
  assert.equal(fetch.calls.at(-1).path, '/api/accounts/acc-a');
  assert.equal(fetch.calls.at(-1).options.method, 'PATCH');
});
```

- [ ] **Step 2: Run service tests and verify RED**

Run: `node --test src/services/web.test.js src/services/runtime.test.js`

Expected: FAIL because neither runtime exposes `accounts` or account-scoped events.

- [ ] **Step 3: Add the shared renderer account contract**

```js
accounts: {
  list(),
  add(credentials),
  updateRemark(accountId, remark),
  reauthenticate(accountId, credentials),
  remove(accountId),
  refresh(accountId),
},
events: {
  onAccountsSnapshot(callback),
  onAccountUpdated(callback),
  onAccountInvalid(callback),
  onAccountRemoved(callback),
}
```

Teach the web event parser about account events without converting them into `session.invalid`. Teach Electron adapters to call the constrained preload methods.

- [ ] **Step 4: Refactor App authentication state to account collection state**

Replace `authSessionRef` as the source of truth with public `accounts` state plus renderer-runtime device refresh. Initial login adds the first account; later account login adds another account. A failed or invalid account updates only that account. Removing the final account returns to `ConnectionScreen`; removing another account keeps the dashboard mounted.

- [ ] **Step 5: Run renderer service and App utility tests**

Run: `node --test src/services/web.test.js src/services/runtime.test.js src/utils/sessionGeneration.test.js src/utils/deviceInventory.test.js`

Expected: PASS.

- [ ] **Step 6: Commit renderer account state**

```bash
git add src/services/electron.js src/services/web.js src/services/web.test.js src/services/runtime.js src/services/runtime.test.js src/App.jsx
git commit -m "feat: manage account collections in the renderer"
```

### Task 7: Optional Remark Login And Account Center UI

**Files:**
- Create: `src/components/monitor/AccountLoginDialog.jsx`
- Create: `src/components/monitor/AccountLoginDialog.test.js`
- Create: `src/components/monitor/AccountCenter.jsx`
- Create: `src/components/monitor/AccountCenter.test.js`
- Modify: `src/components/monitor/SettingsSheet.jsx`
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/components/monitor/monitor.css`
- Modify: `package.json`

- [ ] **Step 1: Write failing pure UI state tests**

```js
test('remark step can be skipped after successful credentials', () => {
  const state = reduceAccountLogin(initialAccountLoginState(), { type: 'credentialsAccepted', credentials: LOGIN });
  assert.equal(state.step, 'remark');
  assert.deepEqual(reduceAccountLogin(state, { type: 'skipRemark' }).submission, { ...LOGIN, remark: '' });
});

test('account rows prefer remark and expose edit reauth remove actions', () => {
  const row = buildAccountRow({ accountId: 'a', remark: '公司', accountMasked: '138****5678', connectionState: 'connected', deviceCount: 3 });
  assert.equal(row.title, '公司');
  assert.equal(row.subtitle, '138****5678');
  assert.deepEqual(row.actions, ['edit', 'reauthenticate', 'remove']);
});
```

- [ ] **Step 2: Run UI state tests and verify RED**

Run: `node --test src/components/monitor/AccountLoginDialog.test.js src/components/monitor/AccountCenter.test.js`

Expected: FAIL because the components and reducers do not exist.

- [ ] **Step 3: Implement the reusable login dialog**

Reuse the current password/verification-code behavior and add a distinct successful-credentials remark step. The remark field is labelled `账号备注（可选）`, capped at 40 characters, and provides both `跳过` and `完成添加` commands. Reauthentication bypasses the remark step unless the user explicitly edits the existing remark.

- [ ] **Step 4: Implement the settings account center**

Replace the single `退出账号` row with account rows showing label, masked account, state, and device count. Use icon buttons with accessible labels for edit, reauthenticate, and remove; use a clear `添加账号` command. Removal requires confirmation that only devices unique to that account will disappear.

- [ ] **Step 5: Add responsive account styles**

Keep the settings sheet compact and scrollable in full, compact, and narrow NAS layouts. Use existing color, spacing, radius, and typography tokens. Ensure account actions wrap below identity text under 420px without horizontal overflow.

- [ ] **Step 6: Run UI and CSS tests and commit**

Run: `node --test src/components/monitor/AccountLoginDialog.test.js src/components/monitor/AccountCenter.test.js src/components/monitor/monitorCss.test.js`

Expected: PASS.

```bash
git add src/components/monitor/AccountLoginDialog.jsx src/components/monitor/AccountLoginDialog.test.js src/components/monitor/AccountCenter.jsx src/components/monitor/AccountCenter.test.js src/components/monitor/SettingsSheet.jsx src/components/PrinterWidget.jsx src/components/monitor/monitor.css package.json
git commit -m "feat: add account center and optional remarks"
```

### Task 8: Account-Aware Printer Presentation Everywhere

**Files:**
- Create: `src/utils/accountPresentation.js`
- Create: `src/utils/accountPresentation.test.js`
- Modify: `src/components/monitor/DeviceCard.jsx`
- Modify: `src/components/monitor/CompactMonitor.jsx`
- Modify: `src/components/monitor/CameraWorkspace.jsx`
- Modify: `src/components/monitor/CameraZoom.jsx`
- Modify: `src/components/monitor/SettingsSheet.jsx`
- Modify: `src/components/MobileDashboard.jsx`
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/services/notifications.js`
- Modify: `src/services/notifications.test.js`
- Modify: `src/utils/cameraPresentation.js`
- Modify: `src/utils/cameraPresentation.test.js`

- [ ] **Step 1: Write failing display-name tests**

```js
test('uses server displayName and never changes the original printer name', () => {
  const printer = { name: 'A2L01', displayName: 'A2L01（公司）' };
  assert.equal(getPrinterDisplayName(printer), 'A2L01（公司）');
  assert.equal(printer.name, 'A2L01');
});

test('builds a fallback from safe account labels', () => {
  assert.equal(getPrinterDisplayName({ name: 'A2L01', accountLabels: ['公司', '工作室'] }), 'A2L01（公司 / 工作室）');
});
```

- [ ] **Step 2: Run display tests and verify RED**

Run: `node --test src/utils/accountPresentation.test.js`

Expected: FAIL because `getPrinterDisplayName` is missing.

- [ ] **Step 3: Implement and propagate one display helper**

```js
export function getPrinterDisplayName(printer = {}) {
  if (String(printer.displayName || '').trim()) return String(printer.displayName).trim();
  const name = String(printer.name || '未命名打印机').trim();
  const labels = [...new Set((printer.accountLabels || []).map((value) => String(value).trim()).filter(Boolean))];
  return labels.length ? `${name}（${labels.join(' / ')}）` : name;
}
```

Use it for device cards, compact rows, mobile cards, camera wall, camera zoom titles, settings camera labels, notification messages/payloads, retry labels, tooltips, and accessibility labels. Keep identity matching utilities on raw `printer.name` so a remark edit cannot alter device identity.

- [ ] **Step 4: Run presentation and notification tests**

Run: `node --test src/utils/accountPresentation.test.js src/utils/cameraPresentation.test.js src/services/notifications.test.js src/utils/printerSync.test.js`

Expected: PASS.

- [ ] **Step 5: Commit presentation propagation**

```bash
git add src/utils/accountPresentation.js src/utils/accountPresentation.test.js src/components/monitor/DeviceCard.jsx src/components/monitor/CompactMonitor.jsx src/components/monitor/CameraWorkspace.jsx src/components/monitor/CameraZoom.jsx src/components/monitor/SettingsSheet.jsx src/components/MobileDashboard.jsx src/components/PrinterWidget.jsx src/services/notifications.js src/services/notifications.test.js src/utils/cameraPresentation.js src/utils/cameraPresentation.test.js
git commit -m "feat: show account labels across monitor views"
```

### Task 9: Full Regression, Visual QA, Documentation, And Packaging

**Files:**
- Modify: `docs/NAS_DOCKER.md`
- Modify: `README.md`
- Modify: `docs/screenshots/settings.png`
- Add: `docs/screenshots/accounts.png`
- Modify: focused tests discovered during regression only when a failing behavior is reproduced first

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all existing and new tests PASS with no uncaught warnings.

- [ ] **Step 2: Run static and production checks**

Run: `npm run lint && npm run build && npm run test:nas && npm run docker:smoke`

Expected: every command exits 0.

- [ ] **Step 3: Start the production preview and perform visual QA**

Run: `npm run preview -- --host 127.0.0.1 --port 4173`

Use Playwright at desktop 1440x900, narrow desktop 520x820, and mobile NAS 390x844. Capture account center, add-account password mode, verification-code mode, optional remark step, duplicate-device labels, camera wall, and camera zoom. Verify no overlap, no clipped text, settings scrolling, keyboard focus, and unchanged draggable title regions.

- [ ] **Step 4: Verify secret and duplicate-connection invariants**

Search built assets, public API fixtures, test logs, and screenshot text for raw test accounts, access tokens, and access codes. Run a two-account duplicate-serial integration fixture and assert one device card, one MQTT connection, and one camera source.

- [ ] **Step 5: Update user documentation and screenshots**

Document how to add accounts, skip/edit remarks, understand merged duplicate devices, recover an invalid account, and upgrade existing desktop/NAS installs without logging in again. State that account credentials remain local and protected, and that deleting the final account signs out BambuMonitor.

- [ ] **Step 6: Build distributable artifacts**

Run on Windows: `npm run electron:build -- --win nsis`

Run on macOS CI/release runner: `npm run electron:build -- --mac dmg`

Expected: signed status follows the existing project policy; Windows installer, macOS DMG, and Docker image/package smoke checks complete without missing `account-store` or shared core files.

- [ ] **Step 7: Commit final verification assets**

```bash
git add README.md docs/NAS_DOCKER.md docs/screenshots/settings.png docs/screenshots/accounts.png
git commit -m "docs: explain multi-account monitoring"
```

## Self-Review Result

- Spec coverage: account storage, migration, optional remarks, duplicate serial merging, one connection/source, failure isolation, API/IPC security, all monitor views, Docker/NAS, desktop, accessibility, and packaging each map to a task.
- Placeholder scan: no deferred implementation markers are present; every behavioral step includes a concrete API, command, and expected result.
- Type consistency: `accountId`, `accountMasked`, `remark`, `label`, `accountIds`, `accountLabels`, and `displayName` use the same names from storage through runtime, API/IPC, renderer services, and UI.
