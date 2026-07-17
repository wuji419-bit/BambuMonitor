# BambuMonitor NAS Docker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-container BambuMonitor NAS edition that restores a Bambu account session, monitors all bound printers, shares one MQTT task and camera upstream per printer, and serves the existing responsive UI to authenticated browsers.

**Architecture:** Protocol code is extracted from Electron into small shared Node modules, while the desktop app keeps its existing IPC adapter. A Node HTTP/WebSocket service owns encrypted persistence, Bambu authentication, device runtimes, camera sources, and static React delivery; the browser uses a Web adapter with the same presentation components as Electron. The production image runs that service and FFmpeg under `tini` with Linux host networking and `/app/data` persistence.

**Tech Stack:** Node.js 22, React 19, Vite 7, Electron 40, MQTT.js 5, `ws` 8, Node `http`/`crypto`/`dgram`, FFmpeg, Docker Buildx, GitHub Actions, Node test runner, Playwright.

---

## File Map

### Create

- `core/bambu-cloud.cjs`: Bambu China cloud login, verification-code, username, and device-list client with injected `fetch`.
- `core/bambu-cloud.test.cjs`: cloud request/response and secret-redaction tests.
- `core/lan-discovery.cjs`: Bambu SSDP packet parsing and bounded UDP scan lifecycle.
- `core/lan-discovery.test.cjs`: discovery parsing, deduplication, and socket cleanup tests.
- `core/mqtt-connection-manager.cjs`: one MQTT task per serial number, reconnect grace, subscription, and shutdown.
- `core/mqtt-connection-manager.test.cjs`: single-source, reconnect, replacement, and cleanup tests.
- `src/utils/printerTelemetry.js`: pure telemetry-to-printer-state reducer shared by Electron renderer and NAS runtime.
- `src/utils/printerTelemetry.test.js`: progress, temperature, AMS, drying, task name, and remaining-time tests.
- `server/storage.js`: atomic JSON files, key creation, AES-256-GCM envelopes, permissions, and corruption handling.
- `server/storage.test.js`: restart, tamper, partial-write, and migration tests.
- `server/config-store.js`: versioned `config.json` and `device-cache.json` contracts.
- `server/config-store.test.js`: defaults, migrations, safe updates, and cached-IP tests.
- `server/session-store.js`: persistent Bambu token plus 30-day browser sessions and CSRF derivation.
- `server/session-store.test.js`: create, restore, renew, expire, revoke, and logout tests.
- `server/http-security.js`: cookie handling, same-origin/CSRF checks, JSON limits, rate limiting, and redaction.
- `server/http-security.test.js`: forged origin, CSRF, oversized body, proxy, and secret-redaction tests.
- `server/logger.js`: structured single-line logging with component/device context and default IP/secret redaction.
- `server/logger.test.js`: output shape, stable anonymous device IDs, IP policy, and secret-redaction tests.
- `server/device-runtime.js`: cloud inventory, LAN merge, MQTT ownership, normalized state, cache, and events.
- `server/device-runtime.test.js`: complete inventory, one MQTT task, IP retention, refresh, token expiry, and shutdown tests.
- `server/camera-source-manager.js`: one chamber-image/RTSPS source per printer, latest-frame cache, fan-out, idle release, and FFmpeg backoff.
- `server/camera-source-manager.test.js`: one upstream across clients, frame fan-out, idle release, bounded restart, and shutdown tests.
- `server/http-app.js`: REST routes, WebSocket upgrade, static SPA delivery, health/readiness, and graceful close.
- `server/http-app.test.js`: authentication boundaries, route contracts, cookies, WebSocket snapshots, and camera authorization tests.
- `server/index.js`: environment parsing, runtime composition, signal handling, and service startup.
- `server/healthcheck.js`: container health probe for `/healthz`.
- `src/services/web.js`: authenticated fetch, CSRF state, WebSocket reconnect, camera URLs, and server settings adapter.
- `src/services/web.test.js`: request headers, session restoration, WebSocket generation, and logout tests.
- `src/services/runtime.js`: Electron/Web capability selection behind one renderer contract.
- `Dockerfile`: multi-stage frontend/server image with FFmpeg, `tini`, non-root user, and health check.
- `.dockerignore`: exclude releases, worktrees, media, Git data, caches, and local secrets.
- `compose.yaml`: supported Linux NAS host-network deployment.
- `scripts/docker-smoke.mjs`: health, readiness, auth rejection, persistence, and shutdown smoke checks.
- `.github/workflows/docker-publish.yml`: amd64/arm64 build, GHCR tags, provenance, and smoke gate.
- `docs/NAS_DOCKER.md`: Chinese deployment, reverse-proxy, upgrade, backup, network, and troubleshooting guide.

### Modify

- `electron/main.cjs`: use shared cloud, discovery, and MQTT modules without changing IPC names.
- `electron/camera-stream.cjs`: reuse the common JPEG parser contract where required by the NAS source manager.
- `src/services/bambu.js`: apply the pure telemetry reducer and support normalized Web updates.
- `src/services/electron.js`: satisfy the unified runtime contract and expose desktop capabilities.
- `src/services/camera.js`: load/save server camera settings in Web mode while preserving desktop local storage.
- `src/services/notifications.js`: send Web-mode notifications through the authenticated NAS API.
- `src/App.jsx`: use runtime auth/session/device APIs instead of hard-coding Electron-only login.
- `src/components/PrinterWidget.jsx`: use runtime cameras/settings, subscribe to NAS state, and hide native-window commands on Web.
- `src/components/monitor/MonitorShell.jsx`: render Web-safe navigation/actions from capabilities.
- `src/components/monitor/SettingsSheet.jsx`: show server settings and omit startup/window controls in NAS mode.
- `src/components/monitor/CameraWorkspace.jsx`: use same-origin frame URLs and wall sampling.
- `src/components/monitor/CameraZoom.jsx`: use the higher-rate same-origin MJPEG URL for Web zoom.
- `src/utils/cameraZoom.js`: distinguish wall snapshot and zoom stream URLs.
- `src/utils/cameraZoom.test.js`: cover Electron chamber streams and NAS dual URLs.
- `vite.config.js`: proxy NAS API/WebSocket during development and keep production asset paths stable.
- `package.json`: direct `ws` dependency, NAS scripts, tests, files, and version 1.1.0.
- `package-lock.json`: dependency and version lock updates.
- `README.md`: NAS overview, GHCR/Compose quick start, LAN-only printer access boundary, and documentation link.

---

### Task 1: Extract the Bambu Cloud and LAN Discovery Core

**Files:**
- Create: `core/bambu-cloud.cjs`
- Create: `core/bambu-cloud.test.cjs`
- Create: `core/lan-discovery.cjs`
- Create: `core/lan-discovery.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing cloud-client tests**

```js
// core/bambu-cloud.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBambuCloudClient } = require('./bambu-cloud.cjs');

test('password login returns only the access token and never logs credentials', async () => {
  const calls = [];
  const logs = [];
  const client = createBambuCloudClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, json: async () => ({ accessToken: 'token-1' }) };
    },
    logger: { info: (entry) => logs.push(entry), warn() {}, error() {} },
  });
  assert.deepEqual(await client.loginPassword({ account: 'user@example.com', password: 'secret' }), {
    success: true,
    accessToken: 'token-1',
  });
  assert.match(calls[0].url, /user\/login$/);
  assert.equal(JSON.parse(calls[0].options.body).password, 'secret');
  assert.doesNotMatch(JSON.stringify(logs), /secret|token-1|user@example\.com/);
});

test('device list normalizes the cloud inventory', async () => {
  const responses = [
    { status: 200, ok: true, json: async () => ({ devices: [{ dev_id: '01P', name: 'P1SC', dev_model_name: 'C12', dev_access_code: '12345678', online: true }] }) },
    { status: 200, ok: true, json: async () => ({ uid: '42' }) },
  ];
  const client = createBambuCloudClient({ fetchImpl: async () => responses.shift() });
  const result = await client.listDevices('access-token');
  assert.equal(result.username, 'u_42');
  assert.deepEqual(result.devices[0], {
    id: '01P', name: 'P1SC', model: 'C12', modelCode: 'C12', accessCode: '12345678', online: true,
    printStatus: undefined, nozzle: undefined,
  });
});
```

- [ ] **Step 2: Write failing discovery-parser tests**

```js
// core/lan-discovery.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBambuDiscoveryMessage } = require('./lan-discovery.cjs');

test('parses Bambu headers and ignores our M-SEARCH request', () => {
  const packet = Buffer.from([
    'HTTP/1.1 200 OK',
    'USN: uuid:01P00ABC::urn:bambulab-com:device:3dprinter:1',
    'DevModel.bambu.com: C12',
    'DevName.bambu.com: Workshop P1S',
    '', '',
  ].join('\r\n'));
  assert.deepEqual(parseBambuDiscoveryMessage(packet, { address: '192.168.1.50' }), {
    ip: '192.168.1.50', name: 'Workshop P1S', model: 'P1S', serial: '01P00ABC',
  });
  assert.equal(parseBambuDiscoveryMessage(Buffer.from('M-SEARCH * HTTP/1.1'), { address: '192.168.1.2' }), null);
});
```

- [ ] **Step 3: Add both tests to `npm test` and verify RED**

Run: `node --test core/bambu-cloud.test.cjs core/lan-discovery.test.cjs`

Expected: FAIL because both implementation modules are missing.

- [ ] **Step 4: Implement the shared contracts**

`core/bambu-cloud.cjs` must export this exact public surface:

```js
module.exports = {
  BAMBU_API,
  createBambuCloudClient,
  getBambuHeaders,
  translateBambuError,
};
```

`createBambuCloudClient({ fetchImpl = global.fetch, logger })` returns `loginPassword`, `requestVerifyCode`, `loginCode`, `listDevices`, and `getCloudUsername`. Every method returns the current Electron result shape; it throws `BambuCloudError` with `status` and `tokenInvalid` when bind/preference returns 401 or 403. Logging is limited to operation, HTTP status, and device count.

`core/lan-discovery.cjs` must export:

```js
module.exports = {
  BAMBU_SEARCH_PACKET,
  GENERIC_SEARCH_PACKET,
  parseBambuDiscoveryMessage,
  scanBambuPrinters,
};
```

`scanBambuPrinters({ dgramImpl, durationMs = 6000, logger, signal })` owns its sockets locally, sends four rounds to ports 1900/2021/1990, deduplicates by serial then IP, and closes both sockets on completion, abort, or error.

- [ ] **Step 5: Replace inline Electron implementations**

At the top of `electron/main.cjs`, require one client and the scanner:

```js
const { createBambuCloudClient } = require('../core/bambu-cloud.cjs');
const { scanBambuPrinters } = require('../core/lan-discovery.cjs');
const bambuCloud = createBambuCloudClient();
```

Keep all existing IPC channel names. Each handler delegates to `bambuCloud` or `scanBambuPrinters`; remove the inline API constants, translation table, UDP globals, and raw credential-adjacent logging.

- [ ] **Step 6: Verify desktop compatibility**

Run:

```powershell
npm.cmd test
npm.cmd run lint
```

Expected: all current tests plus new core tests pass, and lint exits 0.

- [ ] **Step 7: Commit**

```powershell
git add core/bambu-cloud.cjs core/bambu-cloud.test.cjs core/lan-discovery.cjs core/lan-discovery.test.cjs electron/main.cjs package.json
git commit -m "refactor: share Bambu cloud and discovery core"
```

---

### Task 2: Extract One-Per-Printer MQTT and Telemetry State

**Files:**
- Create: `core/mqtt-connection-manager.cjs`
- Create: `core/mqtt-connection-manager.test.cjs`
- Create: `src/utils/printerTelemetry.js`
- Create: `src/utils/printerTelemetry.test.js`
- Modify: `electron/main.cjs`
- Modify: `src/services/bambu.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing MQTT ownership tests**

```js
// core/mqtt-connection-manager.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMqttConnectionManager } = require('./mqtt-connection-manager.cjs');

test('reuses one connection for the same serial and fingerprint', async () => {
  const clients = [];
  const connectImpl = () => {
    const client = new EventEmitter();
    client.subscribe = (_topic, callback) => callback();
    client.publish = () => {};
    client.end = () => { client.ended = true; };
    clients.push(client);
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
  const manager = createMqttConnectionManager({ connectImpl, connectTimeoutMs: 100 });
  const payload = { mode: 'cloud', serialNumber: '01P', authToken: 't', username: 'u_1' };
  await manager.connect(payload);
  await manager.connect(payload);
  assert.equal(clients.length, 1);
  assert.equal(manager.size, 1);
});

test('shutdown closes every MQTT client', async () => {
  const clients = [];
  const manager = createMqttConnectionManager({
    connectImpl: () => {
      const client = new EventEmitter();
      client.subscribe = (_topic, callback) => callback(); client.publish = () => {};
      client.end = () => { client.ended = true; }; clients.push(client);
      queueMicrotask(() => client.emit('connect')); return client;
    },
    connectTimeoutMs: 100,
  });
  await manager.connect({ mode: 'local', serialNumber: 'A', ip: '192.168.1.2', accessCode: '12345678' });
  await manager.shutdown();
  assert.equal(clients[0].ended, true);
  assert.equal(manager.size, 0);
});
```

- [ ] **Step 2: Write failing pure telemetry tests**

```js
// src/utils/printerTelemetry.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPrinterTelemetry } from './printerTelemetry.js';

test('normalizes printing telemetry without mutating the previous state', () => {
  const previous = { dev_id: '01P', status: 'connected', temperature: {}, progress: 0 };
  const next = applyPrinterTelemetry(previous, { print: {
    gcode_state: 'RUNNING', mc_percent: 37, mc_remaining_time: 90,
    nozzle_temper: 220.4, bed_temper: 55.2, layer_num: 20, total_layer_num: 100,
  } }, { now: 1000 });
  assert.notEqual(next, previous);
  assert.equal(previous.progress, 0);
  assert.equal(next.progress, 37);
  assert.equal(next.timeLeft, '1h 30m');
  assert.equal(next.layer, '20/100');
  assert.deepEqual(next.temperature, { nozzle: 220, bed: 55, chamber: 0 });
});

test('maps filament drying to the drying presentation state', () => {
  const next = applyPrinterTelemetry({ temperature: {} }, { print: {
    gcode_state: 'RUNNING', subtask_name: 'filament_drying.gcode', mc_percent: 20,
  } });
  assert.equal(next.status, 'drying');
  assert.equal(next.jobStatus, 'drying');
});
```

- [ ] **Step 3: Verify RED**

Run: `node --test core/mqtt-connection-manager.test.cjs src/utils/printerTelemetry.test.js`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement MQTT manager and pure reducer**

`createMqttConnectionManager` accepts injected MQTT `connectImpl`, options builder, timers, and event callback. Its public API is:

```js
const manager = createMqttConnectionManager(options);
await manager.connect(payload);       // { success: true, serialNumber, reused }
await manager.disconnect(serialNumber);
await manager.shutdown();
manager.has(serialNumber);
manager.size;
```

It emits `connected`, `message`, `reconnecting`, and `disconnected`; uses the existing 45-second disconnect grace; and never includes token, access code, password, or credential-bearing URL in an event or log entry.

`applyPrinterTelemetry(previous, payload, { now = Date.now() } = {})` returns a new normalized printer object. Move progress, status, remaining time, layer, temperatures, fan, speed, task name, and AMS parsing from `BambuClient.handleMessage` into this function. Export `refreshPrinterRemainingTime(printer, now)` for the 15-second countdown.

- [ ] **Step 5: Wire both desktop paths to the shared core**

Create one manager in `electron/main.cjs` and make the existing `mqtt-connect`, `mqtt-disconnect`, and `mqtt-disconnect-all` IPC handlers delegate to it. Forward manager events to the same renderer channels.

Replace `BambuClient.handleMessage` with:

```js
handleMessage(serialNumber, payload) {
  const current = this.printers.get(serialNumber);
  if (!current) return;
  this.printers.set(serialNumber, applyPrinterTelemetry(current, payload));
  this.emitUpdate(serialNumber);
}
```

Update the countdown timer to use `refreshPrinterRemainingTime`.

- [ ] **Step 6: Run the regression gate and commit**

Run: `npm.cmd test` and `npm.cmd run lint`

```powershell
git add core/mqtt-connection-manager.cjs core/mqtt-connection-manager.test.cjs src/utils/printerTelemetry.js src/utils/printerTelemetry.test.js electron/main.cjs src/services/bambu.js package.json
git commit -m "refactor: share MQTT and telemetry runtime"
```

---

### Task 3: Implement Encrypted NAS Persistence

**Files:**
- Create: `server/storage.js`
- Create: `server/storage.test.js`
- Create: `server/config-store.js`
- Create: `server/config-store.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing storage tests**

```js
// server/storage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage } from './storage.js';

test('encrypts and restores JSON without plaintext secrets', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bm-storage-'));
  const storage = await createStorage({ dataDir });
  await storage.writeEncrypted('session.enc', { accessToken: 'token-secret', account: 'user@example.com' });
  const disk = await readFile(path.join(dataDir, 'session.enc'), 'utf8');
  assert.doesNotMatch(disk, /token-secret|user@example\.com/);
  assert.deepEqual(await storage.readEncrypted('session.enc'), { accessToken: 'token-secret', account: 'user@example.com' });
});

test('rejects a tampered GCM envelope and preserves the corrupt file for diagnosis', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bm-storage-'));
  const storage = await createStorage({ dataDir });
  await storage.writeEncrypted('session.enc', { accessToken: 't' });
  await writeFile(path.join(dataDir, 'session.enc'), '{"version":1,"iv":"bad"}');
  await assert.rejects(storage.readEncrypted('session.enc'), /无法验证|invalid/i);
});
```

- [ ] **Step 2: Write failing config migration tests**

```js
// server/config-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStorage } from './storage.js';
import { createConfigStore } from './config-store.js';

test('creates versioned defaults and persists a validated printer address', async () => {
  const storage = await createStorage({ dataDir: await mkdtemp(path.join(tmpdir(), 'bm-config-')) });
  const store = await createConfigStore({ storage });
  assert.deepEqual(store.get().camera, { autoOpen: false, customUrls: {} });
  await store.updateDevice('01P', { ip: '192.168.1.50' });
  assert.equal(store.getDeviceCache().devices['01P'].ip, '192.168.1.50');
  await assert.rejects(store.updateDevice('01P', { ip: 'https://bad.example' }), /有效/);
});
```

- [ ] **Step 3: Verify RED**

Run: `node --test server/storage.test.js server/config-store.test.js`

- [ ] **Step 4: Implement atomic, encrypted files**

`createStorage({ dataDir })` must create `/app/data` with mode `0700`, create a 32-byte `secret.key` with mode `0600`, and expose:

```js
{
  dataDir,
  getSecretKey(),
  readJson(name, fallback),
  writeJson(name, value),
  readEncrypted(name),
  writeEncrypted(name, value),
  remove(name),
}
```

Writes use a same-directory temporary file, `FileHandle.sync()`, close, and atomic rename. Encrypted files use `{ version: 1, algorithm: 'aes-256-gcm', iv, tag, ciphertext }` with 12-byte IVs and authenticated version metadata.

`createConfigStore` owns these schemas:

```js
const DEFAULT_CONFIG = {
  version: 1,
  camera: { autoOpen: false, customUrls: {} },
  notifications: { enabled: false, targets: [] },
  debug: false,
};
const DEFAULT_DEVICE_CACHE = { version: 1, devices: {} };
```

It validates IP/host values with the existing printer-address contract, strips unknown fields, and writes before replacing in-memory state.
When a lower supported schema version is loaded, copy the original bytes to `<name>.bak-v<oldVersion>` before running an idempotent migration and atomically writing the new version. A future/unknown schema version fails readiness without overwriting the file. Add tests proving a version-0 fixture creates one byte-identical backup and reaches version 1 on two consecutive starts.

- [ ] **Step 5: Verify restart and corruption behavior**

Run: `node --test server/storage.test.js server/config-store.test.js`

Expected: all tests pass; no test fixture contains a plaintext token after disk reads.

- [ ] **Step 6: Commit**

```powershell
git add server/storage.js server/storage.test.js server/config-store.js server/config-store.test.js package.json
git commit -m "feat: add encrypted NAS persistence"
```

---

### Task 4: Implement Browser Sessions and HTTP Security

**Files:**
- Create: `server/session-store.js`
- Create: `server/session-store.test.js`
- Create: `server/http-security.js`
- Create: `server/http-security.test.js`
- Create: `server/logger.js`
- Create: `server/logger.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing persistent-session tests**

```js
// server/session-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from './session-store.js';

test('restores a browser session and rolls it forward inside the renewal window', async () => {
  let saved = null;
  let now = Date.UTC(2026, 6, 18);
  const storage = {
    getSecretKey: () => Buffer.alloc(32, 9),
    readEncrypted: async () => saved,
    writeEncrypted: async (_name, value) => { saved = structuredClone(value); },
    remove: async () => { saved = null; },
  };
  const first = await createSessionStore({ storage, now: () => now, randomBytes: (size) => Buffer.alloc(size, 7) });
  const created = await first.create({ account: 'user@example.com', accessToken: 'token', username: 'u_42' });
  const second = await createSessionStore({ storage, now: () => now });
  assert.equal((await second.authenticate(created.sessionId)).account, 'user@example.com');
  now += 29 * 24 * 60 * 60 * 1000;
  const renewed = await second.authenticate(created.sessionId, { renew: true });
  assert.ok(renewed.expiresAt > now);
});

test('logout removes the Bambu token and invalidates every browser session', async () => {
  let saved = null;
  const storage = { getSecretKey: () => Buffer.alloc(32, 9), readEncrypted: async () => saved, writeEncrypted: async (_n, v) => { saved = v; }, remove: async () => { saved = null; } };
  const store = await createSessionStore({ storage });
  const created = await store.create({ account: 'a', accessToken: 'secret' });
  await store.clear();
  assert.equal(await store.authenticate(created.sessionId), null);
  assert.equal(saved, null);
});
```

- [ ] **Step 2: Write failing request-security tests**

```js
// server/http-security.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationRequest, buildSessionCookie, redactSecrets } from './http-security.js';

test('requires matching origin and CSRF for authenticated mutations', () => {
  const request = { headers: { host: 'nas.local:3080', origin: 'https://evil.example', 'x-csrf-token': 'good' } };
  assert.throws(() => assertMutationRequest(request, { csrfToken: 'good' }), /来源/);
  request.headers.origin = 'http://nas.local:3080';
  request.headers['x-csrf-token'] = 'bad';
  assert.throws(() => assertMutationRequest(request, { csrfToken: 'good' }), /CSRF/);
});

test('sets secure cookies only for trusted HTTPS requests', () => {
  assert.match(buildSessionCookie('sid', { secure: true, maxAgeSeconds: 60 }), /HttpOnly; SameSite=Lax; Secure/);
  assert.doesNotMatch(buildSessionCookie('sid', { secure: false, maxAgeSeconds: 60 }), /Secure/);
});

test('redacts nested credentials and credential-bearing URLs', () => {
  const value = redactSecrets({ password: 'p', accessToken: 't', url: 'rtsps://bblp:code@192.168.1.2/streaming/live/1' });
  assert.deepEqual(value, { password: '[REDACTED]', accessToken: '[REDACTED]', url: 'rtsps://[REDACTED]@192.168.1.2/streaming/live/1' });
});
```

Add a logger contract test:

```js
// server/logger.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './logger.js';

test('writes structured lines without raw device IDs, IPs, or credentials', () => {
  const lines = [];
  const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)), debug: false, deviceSalt: 'test-salt' });
  logger.info('camera', 'source_started', {
    serialNumber: '01P00ABC', ip: '192.168.1.92', accessCode: '12345678', url: 'rtsps://bblp:12345678@192.168.1.92/live',
  });
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].component, 'camera');
  assert.match(lines[0].device, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(lines[0]), /01P00ABC|192\.168\.1\.92|12345678/);
});
```

- [ ] **Step 3: Verify RED**

Run: `node --test server/session-store.test.js server/http-security.test.js`

- [ ] **Step 4: Implement the exact session contract**

The encrypted `session.enc` shape is:

```js
{
  version: 1,
  bambu: { account, accessToken, username, savedAt },
  sessions: [{ idHash, createdAt, lastSeenAt, expiresAt }],
}
```

Session IDs are 32 random bytes encoded base64url; only SHA-256 hashes are persisted. CSRF tokens are derived as `HMAC-SHA256(secretKey, "csrf:" + sessionId)` and returned by `/api/session`. Expiry is 30 days with renewal at most once per 24 hours to avoid frequent disk writes. Store at most 20 sessions and remove expired records before every persistence operation.

- [ ] **Step 5: Implement security helpers**

`server/http-security.js` exports `readJsonBody(req, { maxBytes: 65536 })`, `parseCookies`, `buildSessionCookie`, `clearSessionCookie`, `requestIsSecure(req, { trustProxy })`, `assertMutationRequest`, `createSlidingWindowLimiter`, and `redactSecrets`. Proxy headers affect security only when `TRUST_PROXY=1`.

`createLogger({ write, debug, deviceSalt })` emits one JSON object per line with `time`, `level`, `component`, `event`, optional 12-character HMAC device identifier, and redacted details. It omits IP fields unless debug mode is enabled and always redacts password, code, token, access code, cookie, authorization header, and URL userinfo.

- [ ] **Step 6: Verify and commit**

Run: `node --test server/session-store.test.js server/http-security.test.js server/logger.test.js`

```powershell
git add server/session-store.js server/session-store.test.js server/http-security.js server/http-security.test.js server/logger.js server/logger.test.js package.json
git commit -m "feat: secure NAS browser sessions"
```

---

### Task 5: Build the NAS Device Runtime and WebSocket State Feed

**Files:**
- Create: `server/device-runtime.js`
- Create: `server/device-runtime.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing device-runtime tests**

```js
// server/device-runtime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRuntime } from './device-runtime.js';

function fakeConfigStore() {
  const cache = { version: 1, devices: {} };
  return {
    getDeviceCache: () => structuredClone(cache),
    updateDevice: async (serialNumber, patch) => {
      cache.devices[serialNumber] = { ...(cache.devices[serialNumber] || {}), ...patch };
      return structuredClone(cache.devices[serialNumber]);
    },
  };
}

function fakeMqtt() {
  return {
    connect: async () => ({ success: true }),
    disconnect: async () => {},
    shutdown: async () => {},
  };
}

test('shows every cloud device before LAN discovery and creates one MQTT task each', async () => {
  const connects = [];
  const runtime = createDeviceRuntime({
    cloud: { listDevices: async () => ({ username: 'u_1', devices: [
      { id: 'A', name: 'A1mini', model: 'N1', accessCode: 'a' },
      { id: 'B', name: 'H2D', model: 'O1D', accessCode: 'b' },
    ] }) },
    mqtt: { connect: async (payload) => { connects.push(payload); }, disconnect: async () => {}, shutdown: async () => {} },
    discovery: async () => [],
    configStore: fakeConfigStore(),
  });
  await runtime.start({ accessToken: 'token' });
  assert.deepEqual(runtime.snapshot().devices.map((d) => d.dev_id), ['A', 'B']);
  assert.equal(connects.length, 2);
  await runtime.refresh();
  assert.equal(connects.length, 2);
});

test('merges discovered IP by serial and retains the last verified address when scanning fails', async () => {
  let scan = 0;
  const runtime = createDeviceRuntime({
    cloud: { listDevices: async () => ({ username: 'u_1', devices: [{ id: 'A', name: 'A1', model: 'N2S', accessCode: 'a' }] }) },
    mqtt: fakeMqtt(),
    discovery: async () => { scan += 1; if (scan === 1) return [{ serial: 'A', ip: '192.168.1.12' }]; throw new Error('offline'); },
    configStore: fakeConfigStore(),
  });
  await runtime.start({ accessToken: 'token' });
  await runtime.scanLan();
  await runtime.scanLan();
  assert.equal(runtime.snapshot().devices[0].ip, '192.168.1.12');
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test server/device-runtime.test.js`

- [ ] **Step 3: Implement runtime lifecycle**

`createDeviceRuntime` returns:

```js
{
  start({ accessToken, username }),
  refresh(),
  scanLan(),
  updateDevice(serialNumber, patch),
  snapshot(),
  getDevice(serialNumber),
  subscribe(listener),
  shutdown(),
}
```

Cloud inventory is canonical for device count. LAN results only enrich IP/name/model. The runtime records one connection fingerprint per serial and calls MQTT connect again only when mode, token, username, IP, or access code changes. MQTT messages pass through `applyPrinterTelemetry`; each update emits `{ type: 'device.updated', device }`. Initial subscribers receive `{ type: 'devices.snapshot', devices, syncedAt }`.

Cloud list 401/403 emits `session.invalid`; ordinary cloud errors preserve the prior snapshot and set `cloudState: 'reconnecting'`. Scan errors preserve cached IPs. `shutdown()` aborts scans, closes MQTT, clears timers, and removes listeners.

- [ ] **Step 4: Test duplicate-browser independence**

Add a test with two runtime subscribers, emit one MQTT message, and assert both receive the update while the fake MQTT connect count remains one.

- [ ] **Step 5: Verify and commit**

Run: `node --test server/device-runtime.test.js`

```powershell
git add server/device-runtime.js server/device-runtime.test.js package.json
git commit -m "feat: add singleton NAS device runtime"
```

---

### Task 6: Build the Shared Camera Source Manager

**Files:**
- Create: `server/camera-source-manager.js`
- Create: `server/camera-source-manager.test.js`
- Modify: `electron/camera-stream.cjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing single-upstream tests**

```js
// server/camera-source-manager.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCameraSourceManager } from './camera-source-manager.js';

test('shares one RTSPS child across frame and stream clients', async () => {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; }; children.push(child); return child;
  };
  const manager = createCameraSourceManager({ spawnImpl, idleMs: 30_000 });
  manager.configure({ id: 'H2D', mode: 'rtsps', ip: '192.168.1.92', accessCode: '12345678' });
  const first = manager.acquire('H2D');
  const second = manager.acquire('H2D');
  assert.equal(children.length, 1);
  first.release(); second.release();
  await manager.shutdown();
  assert.equal(children[0].killed, true);
});

test('uses capped exponential restart backoff', () => {
  const manager = createCameraSourceManager({ random: () => 0 });
  assert.deepEqual([0, 1, 2, 3, 8].map((attempt) => manager.retryDelay(attempt)), [1000, 2000, 4000, 8000, 30000]);
});
```

- [ ] **Step 2: Add chamber-source and idle-release tests**

Inject a fake `ChamberImageStream` that counts `start` and `stop`. Acquire twice, emit one JPEG frame, release both handles, advance the injected timer by 30 seconds, and assert one start, both listeners receive the frame, and one stop.

- [ ] **Step 3: Verify RED**

Run: `node --test server/camera-source-manager.test.js`

- [ ] **Step 4: Implement source ownership and frame parsing**

`createCameraSourceManager` returns:

```js
{
  configure(device),
  acquire(serialNumber),
  getLatestFrame(serialNumber),
  subscribe(serialNumber, listener),
  retryDelay(attempt),
  inspect(),
  shutdown(),
}
```

Each source entry owns one chamber socket or one FFmpeg child, a latest JPEG buffer, viewer/reference counts, retry attempt, retry timer, and idle timer. RTSPS uses:

```text
ffmpeg -hide_banner -loglevel warning -rtsp_transport tcp -i <redacted-at-log-time-url> -an -vf fps=4,scale=960:-1 -q:v 6 -f image2pipe -vcodec mjpeg pipe:1
```

Parse JPEG SOI/EOI boundaries with the same bounded-buffer behavior as `createChamberFrameParser`. Never pass FFmpeg stderr through unredacted. Reset backoff after the first valid frame. `SIGTERM`/`shutdown()` cancels timers, stops chamber streams, terminates children, waits up to five seconds, then force-kills remaining children.

When a per-device custom URL exists, `configure` selects `external-http` before the model default. Accept only `http:` and `https:` URLs, keep any URL userinfo server-side, set an eight-second connect/read timeout, parse snapshot `image/jpeg` responses or multipart MJPEG frames into the same latest-frame cache, and apply the same idle/retry lifecycle. Add tests that the browser-facing inspection omits the URL, an invalid scheme is rejected, and a credential-bearing URL is redacted from errors.

- [ ] **Step 5: Verify one source under concurrent clients**

Run the full camera test file with 20 acquire/release clients and assert `inspect()[0].upstreamStarts === 1`.

- [ ] **Step 6: Commit**

```powershell
git add server/camera-source-manager.js server/camera-source-manager.test.js electron/camera-stream.cjs package.json
git commit -m "feat: share one camera source per printer"
```

---

### Task 7: Build the Authenticated HTTP, REST, WebSocket, and Camera Server

**Files:**
- Create: `server/http-app.js`
- Create: `server/http-app.test.js`
- Create: `server/index.js`
- Create: `server/healthcheck.js`
- Modify: `package.json`
- Modify: `vite.config.js`

- [ ] **Step 1: Install the direct WebSocket dependency**

Run: `npm.cmd install ws@^8.21.0`

Expected: `ws` appears under root dependencies and the lockfile remains valid.

- [ ] **Step 2: Write failing public/auth boundary tests**

```js
// server/http-app.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHttpApp } from './http-app.js';

function fakeDependencies() {
  const state = { active: false, subscriptions: 0, cameraActive: false, cameraStarts: 0 };
  return {
    state,
    cloud: {
      loginPassword: async () => ({ success: true, accessToken: 'token-1' }),
      requestVerifyCode: async () => ({ success: true }),
      loginCode: async () => ({ success: true, accessToken: 'token-1' }),
      listDevices: async () => ({ username: 'u_1', devices: [] }),
    },
    sessionStore: {
      create: async () => { state.active = true; return { sessionId: 'session-1', csrfToken: 'csrf-1', expiresAt: Date.now() + 60_000 }; },
      authenticate: async (sessionId) => state.active && sessionId === 'session-1'
        ? { account: 'user@example.com', csrfToken: 'csrf-1' }
        : null,
      getBambuSession: () => state.active ? { accessToken: 'token-1', username: 'u_1' } : null,
      clear: async () => { state.active = false; },
    },
    deviceRuntime: {
      start: async () => {}, refresh: async () => {}, updateDevice: async () => {},
      snapshot: () => ({ type: 'devices.snapshot', devices: [], syncedAt: 1 }),
      subscribe: () => { state.subscriptions += 1; return () => { state.subscriptions -= 1; }; },
    },
    cameraManager: {
      acquire: () => {
        if (!state.cameraActive) { state.cameraActive = true; state.cameraStarts += 1; }
        return { release() {} };
      },
      getLatestFrame: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      subscribe: (_id, listener) => { listener(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return () => {}; },
    },
    configStore: { get: () => ({ version: 1 }), update: async (value) => value },
    logger: { info() {}, warn() {}, error() {} },
    distDir: null,
    trustProxy: false,
  };
}

test('exposes health but rejects devices and cameras without a session', async (t) => {
  const app = createHttpApp(fakeDependencies());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/devices`)).status, 401);
  assert.equal((await fetch(`${base}/api/cameras/01P/frame`)).status, 401);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
});
```

- [ ] **Step 3: Write failing login, CSRF, WebSocket, and camera tests**

Use `fakeDependencies()` above. Add this login/CSRF assertion:

```js
test('creates an HttpOnly session and rejects a mutation without CSRF', async (t) => {
  const app = createHttpApp(fakeDependencies());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'user@example.com', password: 'secret' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await login.json()).data.csrfToken, 'csrf-1');
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/devices/refresh`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
  })).status, 403);
});
```

Then connect two `ws` clients to `/api/ws` with `Cookie: bm_session=session-1` and `Origin: base`; assert both first messages equal `devices.snapshot` and `state.subscriptions` returns to zero after both close. Request one frame and one stream with the same cookie; close the stream after its first multipart JPEG and assert the manager reports one configured upstream entry rather than one child per response.

- [ ] **Step 4: Implement exact route contracts**

Implement these endpoints:

```text
POST   /api/auth/login
POST   /api/auth/code/request
POST   /api/auth/code/verify
POST   /api/auth/logout
GET    /api/session
GET    /api/devices
POST   /api/devices/refresh
PATCH  /api/devices/:id
GET    /api/settings
PUT    /api/settings
POST   /api/notifications/test
GET    /api/cameras/:id/frame
GET    /api/cameras/:id/stream
GET    /api/ws
GET    /healthz
GET    /readyz
```

Every API response uses `{ ok, data }` or `{ ok: false, error: { code, message } }`. Login handlers accept only `account/password` or `account/code`, rate-limit by remote address plus normalized account, create the browser session, start the device runtime, and discard request variables before returning. `/api/session` returns `{ authenticated, accountMasked, csrfToken }` and never returns the Bambu token.

`/api/cameras/:id/frame` acquires the source, waits at most four seconds for a JPEG, sends `image/jpeg`, then releases. `/stream` sends `multipart/x-mixed-replace; boundary=bambuframe`, subscribes to the shared source, and releases on request/response close. Both use `Cache-Control: no-store` and same-origin session checks.

Allow at most four active MJPEG responses per camera and twenty across the service; additional streams return 429 without acquiring the source. Frame polling is limited to four requests per second per session/camera. Add HTTP tests that hold the allowed streams open, verify the next request is rejected, close one stream, and verify a replacement succeeds without increasing the upstream count.

WebSocket upgrade authenticates the cookie, verifies Origin, caps five sockets per session, sends the full snapshot first, and then forwards runtime events. Ping every 30 seconds and terminate clients that miss two pongs.

- [ ] **Step 5: Serve the built React SPA safely**

Serve immutable hashed assets from `dist/assets`, `no-cache` for `index.html`, and the SPA fallback only for non-API GET requests. Resolve paths against the fixed `dist` root and reject any decoded path that escapes it. Development Vite proxies `/api` and `/healthz` to port 3080 and proxies `/api/ws` with WebSocket enabled.

- [ ] **Step 6: Compose startup and graceful shutdown**

`server/index.js` parses `PORT` (default 3080), `DATA_DIR` (default `/app/data`), `TRUST_PROXY` (default false), and `TZ`. It creates storage, config, session, cloud, MQTT, device, camera, and HTTP instances in that order. If `session.enc` is valid, start device sync without requiring a new browser login. On `SIGTERM`/`SIGINT`, stop accepting HTTP, close WebSockets, camera sources, device/MQTT runtime, and exit only after all close promises settle or a 10-second hard deadline expires.

If `session.enc` cannot be authenticated, rename it to `session.enc.corrupt-<timestamp>`, log only the envelope error code, and start at the sole Bambu login page. If `secret.key` or the data directory cannot be created/read, keep `/healthz` alive, return 503 from `/readyz`, and do not accept login until storage is writable.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
node --test server/http-app.test.js
npm.cmd test
npm.cmd run lint
```

```powershell
git add server/http-app.js server/http-app.test.js server/index.js server/healthcheck.js package.json package-lock.json vite.config.js
git commit -m "feat: serve authenticated NAS monitor API"
```

---

### Task 8: Add the Web Runtime Adapter Without Regressing Electron

**Files:**
- Create: `src/services/web.js`
- Create: `src/services/web.test.js`
- Create: `src/services/runtime.js`
- Modify: `src/services/electron.js`
- Modify: `src/services/bambu.js`
- Modify: `src/App.jsx`
- Modify: `package.json`

- [ ] **Step 1: Write failing Web adapter tests**

```js
// src/services/web.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebRuntime } from './web.js';

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(value),
  };
}

test('restores session and attaches CSRF to mutations', async () => {
  const calls = [];
  const runtime = createWebRuntime({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/session') return jsonResponse({ ok: true, data: { authenticated: true, csrfToken: 'csrf-1' } });
      return jsonResponse({ ok: true, data: { devices: [] } });
    },
  });
  assert.equal((await runtime.auth.getSavedSession()).session.serverSession, true);
  await runtime.devices.refresh();
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[1].options.credentials, 'same-origin');
});

test('returns same-origin dual camera URLs without printer credentials', async () => {
  const runtime = createWebRuntime({ fetchImpl: async () => jsonResponse({ ok: true, data: {} }) });
  const result = await runtime.camera.start({ serialNumber: '01P', accessCode: 'secret', ip: '192.168.1.2' });
  assert.deepEqual(result, {
    success: true,
    mode: 'nas-gateway',
    snapshotUrl: '/api/cameras/01P/frame',
    url: '/api/cameras/01P/stream',
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|192\.168\.1\.2/);
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test src/services/web.test.js`

- [ ] **Step 3: Implement the renderer runtime contract**

Both adapters expose:

```js
{
  kind: 'electron' | 'web',
  capabilities: { nativeWindow, startup, mousePassthrough, localScan, serverSettings },
  auth: { cloudLogin, requestVerifyCode, cloudLoginCode, getDeviceList, getSavedSession, saveSession, clearSavedSession },
  devices: { refresh, update, scanPrinters },
  camera: { start, stop, stopAll },
  settings: { get, save },
  notifications: { send },
  events: { onDeviceSnapshot, onDeviceUpdate, onSessionInvalid, close },
}
```

Electron methods wrap the existing preload API and preserve all current result shapes. Web methods use `fetch` with `credentials: 'same-origin'`; after any successful login or session lookup they cache the CSRF token in memory only. WebSocket reconnect uses delays 1/2/4/8/15 seconds, one socket per page, a generation counter that rejects late events from closed sockets, and an immediate `/api/devices` snapshot fallback.

- [ ] **Step 4: Refactor `App.jsx` around the runtime**

Replace Electron-only login guards with `runtime.auth`. Web login accepts password and verification code. Session restoration calls `runtime.auth.getSavedSession`; Web restoration never reads or writes a token in local storage. Keep only the non-secret account label in `localStorage`.

For Electron, retain existing `bambuClient` connection behavior. For Web, initialize printers from `getDeviceList`, then apply `onDeviceSnapshot` and `onDeviceUpdate` events directly. Web device refresh calls the server once; opening a second page never creates renderer MQTT work.

On `onSessionInvalid`, clear printers, close runtime events, show `登录状态已过期，请重新登录`, and return to the sole Bambu login screen.

- [ ] **Step 5: Run Electron and Web unit gates**

Run: `npm.cmd test` and `npm.cmd run lint`

Expected: the existing Electron tests remain green and Web adapter tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/services/web.js src/services/web.test.js src/services/runtime.js src/services/electron.js src/services/bambu.js src/App.jsx package.json
git commit -m "feat: connect React UI to NAS runtime"
```

---

### Task 9: Adapt Settings, Cameras, and Controls for Browser Use

**Files:**
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/components/monitor/MonitorShell.jsx`
- Modify: `src/components/monitor/SettingsSheet.jsx`
- Modify: `src/components/monitor/CameraWorkspace.jsx`
- Modify: `src/components/monitor/CameraZoom.jsx`
- Modify: `src/services/camera.js`
- Modify: `src/services/notifications.js`
- Modify: `src/utils/cameraZoom.js`
- Modify: `src/utils/cameraZoom.test.js`
- Modify: `src/components/monitor/monitor.css`

- [ ] **Step 1: Write failing dual-camera URL tests**

```js
test('uses NAS snapshot on the wall and MJPEG in zoom', () => {
  const stream = { success: true, mode: 'nas-gateway', snapshotUrl: '/frame', url: '/stream' };
  const wall = buildCameraZoomState({ key: 'A', printer: { name: 'A1' }, stream, imageState: { status: 'ready' }, purpose: 'wall' });
  const zoom = buildCameraZoomState({ key: 'A', printer: { name: 'A1' }, stream, imageState: { status: 'ready' }, purpose: 'zoom' });
  assert.equal(wall.imageUrl, '/frame');
  assert.equal(wall.isSnapshotStream, true);
  assert.equal(zoom.imageUrl, '/stream');
  assert.equal(zoom.isSnapshotStream, false);
});
```

- [ ] **Step 2: Route camera lifecycle through the selected runtime**

Replace direct `electronCamera` usage with `runtime.camera`. In Web mode `camera.start` is deterministic and does not send printer IP/access code over the network. Wall cards poll `/frame` every 700 ms while visible; zoom switches to `/stream`. Closing the camera tab aborts frame fetches and clears browser retry timers but does not call a printer endpoint; the server’s 30-second idle timer owns upstream release.

- [ ] **Step 3: Persist Web settings on the NAS**

On Web monitor mount, load `/api/settings` and merge it into draft state. Save through one `PUT /api/settings` transaction. Keep Electron `localStorage` behavior unchanged. Server settings include camera auto-open/custom URLs and notification targets; custom URLs are fetched by the NAS camera gateway or explicitly rejected if they point to disallowed schemes, never embedded with credentials in the browser.

- [ ] **Step 4: Hide desktop-only actions from every Web surface**

Use `runtime.capabilities` to omit pin, mouse passthrough, native lock, opacity, startup, compact native-size reset, minimize, quit, and native window-mode commands. Keep device/camera tabs, refresh, settings, sign out, camera zoom, fit/fill, and responsive layout. Do not render disabled desktop controls or explanatory feature text.

- [ ] **Step 5: Verify browser layouts**

Run the NAS server and inspect authenticated fixtures at 390 x 844, 768 x 1024, 1280 x 720, and 1920 x 1080. Assert no document-level horizontal overflow, all device counts match the server snapshot, settings scroll reaches Save/Sign out, camera cards use one/two/three columns, and zoom fills the viewport without native titlebar gaps.

- [ ] **Step 6: Run tests/build and commit**

Run:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

```powershell
git add src/components/PrinterWidget.jsx src/components/monitor/MonitorShell.jsx src/components/monitor/SettingsSheet.jsx src/components/monitor/CameraWorkspace.jsx src/components/monitor/CameraZoom.jsx src/components/monitor/monitor.css src/services/camera.js src/services/notifications.js src/utils/cameraZoom.js src/utils/cameraZoom.test.js
git commit -m "feat: adapt monitor workspace for NAS browsers"
```

---

### Task 10: Package the Single-Container NAS Edition

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.yaml`
- Create: `scripts/docker-smoke.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add NAS scripts and version 1.1.0**

Set both package version fields to `1.1.0` and add:

```json
{
  "server": "node server/index.js",
  "server:dev": "concurrently -k \"vite --host 0.0.0.0\" \"node --watch server/index.js\"",
  "test:nas": "node --test core/bambu-cloud.test.cjs core/lan-discovery.test.cjs core/mqtt-connection-manager.test.cjs server/storage.test.js server/config-store.test.js server/session-store.test.js server/http-security.test.js server/logger.test.js server/device-runtime.test.js server/camera-source-manager.test.js server/http-app.test.js src/services/web.test.js src/utils/printerTelemetry.test.js",
  "docker:smoke": "node scripts/docker-smoke.mjs"
}
```

Keep the existing desktop build scripts and Electron builder configuration intact.

- [ ] **Step 2: Create the multi-stage image**

Use `node:22-bookworm-slim` for build and runtime. The build stage runs `npm ci` and `npm run build`. The runtime stage installs only `ffmpeg`, `tini`, and CA certificates; runs `npm ci --omit=dev`; copies `dist`, `server`, `core`, required `src/utils` modules, package metadata, and `electron/camera-stream.cjs`; creates `/app/data`; and changes ownership to the built-in `node` user.

Required runtime directives:

```dockerfile
ENV NODE_ENV=production PORT=3080 DATA_DIR=/app/data
EXPOSE 3080
VOLUME ["/app/data"]
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "server/healthcheck.js"]
```

- [ ] **Step 3: Create the supported Compose file**

```yaml
services:
  bambu-monitor:
    image: ghcr.io/wuji419-bit/bambu-monitor:latest
    container_name: bambu-monitor
    network_mode: host
    restart: unless-stopped
    environment:
      PORT: 3080
      DATA_DIR: /app/data
      TZ: Asia/Shanghai
      TRUST_PROXY: "0"
    volumes:
      - ./data:/app/data
```

Do not publish printer MQTT/camera ports and do not bundle Cloudflare, Caddy, Nginx, or a database.

- [ ] **Step 4: Add local image smoke verification**

`scripts/docker-smoke.mjs` waits up to 60 seconds for `/healthz`, requires `/readyz` 200, and requires unauthenticated `/api/devices` plus `/api/cameras/test/frame` to return 401. It runs `sha256sum /app/data/secret.key` through `docker exec`, restarts the same container, verifies the key hash is unchanged, asserts PID 1 is `tini`, sends `docker stop --time 10`, and fails if container logs show the hard shutdown deadline or an unhandled rejection.

- [ ] **Step 5: Build and inspect the amd64 image**

Run:

```powershell
docker build --platform linux/amd64 -t bambu-monitor:nas-test .
docker run --rm --name bambu-monitor-smoke -d --network host -e PORT=3080 -v bambu-monitor-smoke-data:/app/data bambu-monitor:nas-test
npm.cmd run docker:smoke
```

Expected: image builds, health/readiness pass, private APIs reject anonymous access, volume survives restart, and shutdown leaves no FFmpeg process.

- [ ] **Step 6: Commit**

```powershell
git add Dockerfile .dockerignore compose.yaml scripts/docker-smoke.mjs package.json package-lock.json
git commit -m "feat: package BambuMonitor NAS container"
```

---

### Task 11: Add Multi-Architecture GHCR Publishing and NAS Documentation

**Files:**
- Create: `.github/workflows/docker-publish.yml`
- Create: `docs/NAS_DOCKER.md`
- Modify: `README.md`

- [ ] **Step 1: Create the GitHub Actions workflow**

Trigger on `workflow_dispatch` and tags `v*`. Grant `contents: read`, `packages: write`, and `id-token: write`. Use checkout, QEMU, Buildx, GHCR login, Docker metadata, and build-push-action. Generate these tags from `v1.1.0`:

```text
ghcr.io/wuji419-bit/bambu-monitor:1.1.0
ghcr.io/wuji419-bit/bambu-monitor:1.1
ghcr.io/wuji419-bit/bambu-monitor:latest
```

Build `linux/amd64,linux/arm64`, enable registry cache, SBOM, and provenance. Before push, build/load amd64 and run the smoke script. The publish job runs only after unit, lint, Vite build, and amd64 smoke jobs pass.

- [ ] **Step 2: Write the Chinese NAS guide**

Document exact commands for creating a directory, running `mkdir -p data` and `chown -R 1000:1000 data` (or setting equivalent NAS shared-folder ownership for container UID 1000), saving `compose.yaml`, `docker compose up -d`, opening `http://NAS-IP:3080`, viewing logs, upgrading with pull/recreate, backing up `./data`, and fully resetting by removing the data directory while stopped. Explain that `/readyz` returns 503 with a storage-permission code when the bind mount is not writable. Also explain:

- Linux NAS and host networking are the supported first release.
- Bambu cloud status does not require device IP.
- Cameras/local status require NAS-to-printer LAN reachability.
- External browsers connect to NAS only; printer ports are never public.
- HTTPS/domain/reverse proxy are user-managed external facilities.
- `TRUST_PROXY=1` is enabled only behind a trusted reverse proxy that sets `X-Forwarded-Proto`.
- Lost/corrupt `secret.key` intentionally invalidates `session.enc` and requires Bambu login again.
- amd64 and arm64 are published; macOS Docker Desktop is not the supported NAS production path.

- [ ] **Step 3: Update the main README**

Add a first-screen NAS section with the one-container Compose command, GHCR address, supported architectures, link to `docs/NAS_DOCKER.md`, and the existing GitHub/QQ information. State clearly that AGPLv3 applies to the NAS server and modified network deployments must provide corresponding source.

- [ ] **Step 4: Validate workflow and docs**

Run:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
git diff --check
```

Run `docker compose -f compose.yaml config --quiet`. Expected: exit 0, no YAML errors, and the rendered service uses host networking with only `/app/data` mounted. Push the branch without a release tag first and verify the workflow’s test/build jobs parse and start successfully before creating `v1.1.0`.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/docker-publish.yml docs/NAS_DOCKER.md README.md
git commit -m "docs: publish NAS Docker deployment"
```

---

### Task 12: Complete End-to-End and Real-Printer Verification

**Files:**
- No planned file changes. Any proven defect returns to its owning task, receives a failing regression test, and is committed before this release gate is repeated from Step 1.

- [ ] **Step 1: Run the complete automated gate**

```powershell
npm.cmd test
npm.cmd run test:nas
npm.cmd run lint
npm.cmd run build
npm.cmd audit --audit-level=moderate --registry=https://registry.npmjs.org
git diff --check
```

Expected: every command exits 0 and audit reports no moderate-or-higher production vulnerability.

- [ ] **Step 2: Run Docker lifecycle verification**

Build amd64, start with a fresh volume, log in through the browser, restart the container, and verify the same browser restores the session and device list. Confirm `/healthz` reveals only `{ status: 'ok' }`; `/readyz` does not depend on printer availability; anonymous API, frame, stream, and WebSocket requests return 401.

- [ ] **Step 3: Verify the current five printers**

With the NAS on the printer LAN, confirm all five cloud devices appear before IP discovery. Verify current IPs are merged without duplicate cards, each printer updates status, H2D drying reports `烘干中`, and cloud-only devices do not show a mandatory IP prompt.

- [ ] **Step 4: Run the camera concurrency soak**

Open the camera wall in two desktop browsers and one phone, then zoom H2D in two clients. Use the internal debug inspection available only on localhost/container exec to assert one upstream per serial and one H2D FFmpeg child. Run for two hours while repeatedly refreshing, zooming, closing clients, and temporarily blocking one camera. Expected: unaffected cameras continue, restart delays remain capped, no process count growth occurs, and all camera sources release within 30 seconds after the last viewer closes.

- [ ] **Step 5: Re-run desktop regression checks**

Run the Electron preview and installed Windows application. Verify automatic encrypted login, all five device cards, native resizing, full/compact/mini modes, camera wall, camera zoom, settings scrolling, window pin/lock, and strict single-instance behavior. The NAS work must not expose Web-only controls or change desktop window behavior.

- [ ] **Step 6: Verify responsive Web UI with Playwright screenshots**

Capture login, device dashboard, camera wall, zoom, and settings at 390 x 844, 768 x 1024, and 1440 x 900. Assert:

```js
document.documentElement.scrollWidth === document.documentElement.clientWidth
```

Also assert the primary content area scrolls vertically when device cards exceed viewport height, no control lies outside the viewport, camera pixels are nonblank, and no browser receives an IP/access-code/RTSPS credential in HTML, JSON, WebSocket, or image URLs.

- [ ] **Step 7: Tag and push only after all gates pass**

```powershell
git status --short
git tag -a v1.1.0 -m "BambuMonitor 1.1.0 NAS Docker"
git push -u origin codex/resizable-workspace-ui
git push origin v1.1.0
```

Confirm the GitHub Actions manifest contains both `linux/amd64` and `linux/arm64`, then pull `ghcr.io/wuji419-bit/bambu-monitor:1.1.0` into a clean Compose directory and repeat health/login/device/camera smoke checks before announcing the release.
