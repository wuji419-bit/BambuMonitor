# BambuMonitor Reliability And UI Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve accurate print state during reconnects, keep the device inventory current, recover camera failures, protect sessions, and make multi-printer status easier to scan.

**Architecture:** Add small pure utilities for printer presentation, inventory reconciliation, and bounded asynchronous work. Keep Electron IPC as the system boundary, with `App` coordinating session-backed synchronization and `PrinterWidget` consuming tested presentation data.

**Tech Stack:** Electron 40, React 19, Vite 7, Node test runner, MQTT 5.

---

### Task 1: Connection And Job State Separation

**Files:**
- Create: `src/utils/printerPresentation.js`
- Create: `src/utils/printerPresentation.test.js`
- Modify: `src/utils/mqttConnectionState.js`
- Modify: `src/utils/mqttConnectionState.test.js`
- Modify: `src/services/bambu.js`

- [ ] Write failing tests proving reconnect preserves `printing`, sets `connectionState: reconnecting`, and summary counts do not report reconnecting devices as online.
- [ ] Run `node --test src/utils/mqttConnectionState.test.js src/utils/printerPresentation.test.js` and confirm the new assertions fail for missing behavior.
- [ ] Implement `getPrinterJobStatus`, `getPrinterConnectionState`, `getPrinterSummary`, and presentation priority helpers.
- [ ] Update MQTT lifecycle helpers and telemetry handling to maintain `connectionState` and `lastTelemetryAt` without discarding job telemetry.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: Device Inventory Synchronization

**Files:**
- Create: `src/utils/deviceInventory.js`
- Create: `src/utils/deviceInventory.test.js`
- Modify: `src/App.jsx`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] Write failing tests for merging newly bound devices, preserving existing telemetry, and removing devices absent from the authoritative cloud list.
- [ ] Run `node --test src/utils/deviceInventory.test.js` and confirm the missing utility fails.
- [ ] Implement inventory reconciliation keyed by cloud ID and normalized serial.
- [ ] Keep the authenticated session in `App`, add guarded manual/periodic synchronization, and reconnect only devices that are new or not reusable.
- [ ] Add a refresh icon, busy state, last-sync label, and non-blocking refresh error to the dashboard header.
- [ ] Re-run focused and existing printer synchronization tests.

### Task 3: Camera Startup And Retry

**Files:**
- Create: `src/utils/asyncPool.js`
- Create: `src/utils/asyncPool.test.js`
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/services/electron.js`

- [ ] Write a failing test proving at most two asynchronous camera starts run concurrently and all results retain source order.
- [ ] Run `node --test src/utils/asyncPool.test.js` and confirm failure.
- [ ] Implement a small `mapWithConcurrency` utility.
- [ ] Replace unbounded camera startup with the pool and add a per-camera restart action using existing stop/start IPC.
- [ ] Add bounded automatic retries and cancel retry timers when the wall closes.
- [ ] Re-run camera utility tests and manually verify loading, error, retry, and zoom states.

### Task 4: Protected Session And Safe Logs

**Files:**
- Modify: `electron/auth-session.cjs`
- Modify: `electron/auth-session.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `src/App.jsx`

- [ ] Write failing tests for encrypted session envelopes, legacy plaintext migration, and unreadable encrypted data.
- [ ] Run `node --test electron/auth-session.test.cjs` and confirm the new cases fail.
- [ ] Add optional protect/unprotect adapters to session persistence and wire them to Electron `safeStorage`.
- [ ] Remove renderer token persistence and read saved sessions through IPC when refresh or manual reconnect requires credentials.
- [ ] Replace full login/device response logging with outcome-only messages.
- [ ] Re-run authentication and MQTT option tests.

### Task 5: Dashboard UI Hierarchy

**Files:**
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/App.jsx`

- [ ] Add component-independent tests for sorting and summary labels in `src/utils/printerPresentation.test.js` and verify they fail.
- [ ] Use presentation helpers for summary counts and attention-first ordering.
- [ ] Fix the cloud notice guard and show connection health separately from print progress.
- [ ] Keep current colors and dimensions while reducing equal-weight status text.
- [ ] Verify full, compact, mini, settings, and camera layouts in the in-app browser.

### Task 6: Dependency, Version, And Documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [ ] Refresh compatible transitive dependencies and verify the reported `ws` and `ip-address` advisories are cleared.
- [ ] Bump the application patch version to `1.0.11`.
- [ ] Update README wording to distinguish cloud MQTT status from LAN/VPN-only camera access.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, and `npm audit --omit=dev --registry=https://registry.npmjs.org`.
- [ ] Inspect `git diff --check` and `git status --short`; do not push or create a release unless requested.
