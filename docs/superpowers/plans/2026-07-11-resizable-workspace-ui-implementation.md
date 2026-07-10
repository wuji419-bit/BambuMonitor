# Resizable Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship BambuMonitor 1.0.12 with reliable native window resizing and the approved tabbed workspace across full, compact, mini, camera, zoom, settings, and login surfaces.

**Architecture:** Electron owns native bounds, minimum sizes, and resize notifications; the renderer persists one size per mode and never auto-resizes in response to content. `PrinterWidget` remains the stateful controller for printer/camera/settings behavior while focused monitor components render the approved interfaces through one CSS system.

**Tech Stack:** Electron 40, React 19, Vite 7, Lucide React, Node test runner, CSS Grid/container-responsive layout.

---

## File Map

### Create

- `src/utils/windowModes.js`: canonical mode names, default/minimum sizes, validation, and storage serialization.
- `src/utils/windowModes.test.js`: pure mode-size tests.
- `electron/window-bounds.cjs`: native size clamping and BrowserWindow option helpers.
- `electron/window-bounds.test.cjs`: native bounds tests.
- `src/components/monitor/MonitorShell.jsx`: app bar, primary tabs, overflow menu, drag region, and resize affordance.
- `src/components/monitor/DeviceWorkspace.jsx`: summary and responsive full device grid.
- `src/components/monitor/DeviceCard.jsx`: full device card.
- `src/components/monitor/CompactMonitor.jsx`: compact printer list.
- `src/components/monitor/MiniMonitor.jsx`: active-printer mini surface.
- `src/components/monitor/CameraWorkspace.jsx`: responsive camera wall.
- `src/components/monitor/CameraZoom.jsx`: resizable zoom surface.
- `src/components/monitor/SettingsSheet.jsx`: responsive settings sheet/full screen.
- `src/components/monitor/monitor.css`: monitor tokens and every responsive layout.

### Modify

- `electron/main.cjs`: create an opaque resizable window, apply minimum sizes, and emit native resize events.
- `electron/preload.cjs`: expose mode sizing and resize subscriptions.
- `src/services/electron.js`: typed renderer wrappers for native window behavior.
- `src/components/PrinterWidget.jsx`: keep behavior/state, remove inline legacy layouts and `ResizeObserver`, compose new components.
- `src/App.jsx`: pass login mode sizing and use the redesigned login shell.
- `src/index.css`: align login tokens and responsive form layout with the monitor.
- `package.json`: add new tests and bump version to 1.0.12.
- `package-lock.json`: keep root version in sync.
- `README.md`: document native resizing and responsive modes.

---

### Task 1: Define Window Mode Contracts

**Files:**
- Create: `src/utils/windowModes.js`
- Create: `src/utils/windowModes.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for canonical sizes and validation**

```js
// src/utils/windowModes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWindowModeConfig,
  normalizeSavedWindowSize,
  readWindowSizeMap,
  updateWindowSizeMap,
} from './windowModes.js';

test('defines approved defaults and minimums for every desktop mode', () => {
  assert.deepEqual(getWindowModeConfig('full'), {
    defaultSize: { width: 720, height: 620 },
    minSize: { width: 320, height: 300 },
  });
  assert.deepEqual(getWindowModeConfig('compact').defaultSize, { width: 380, height: 500 });
  assert.deepEqual(getWindowModeConfig('mini').minSize, { width: 240, height: 78 });
  assert.deepEqual(getWindowModeConfig('zoom').defaultSize, { width: 960, height: 680 });
  assert.deepEqual(getWindowModeConfig('login').minSize, { width: 420, height: 460 });
});

test('rejects invalid saved sizes and clamps values below the mode minimum', () => {
  assert.equal(normalizeSavedWindowSize('full', { width: 'bad', height: 600 }), null);
  assert.deepEqual(
    normalizeSavedWindowSize('compact', { width: 120, height: 180 }),
    { width: 340, height: 260 },
  );
});

test('reads corrupted storage as an empty map and updates one mode only', () => {
  assert.deepEqual(readWindowSizeMap('{broken'), {});
  assert.deepEqual(
    updateWindowSizeMap({ full: { width: 700, height: 600 } }, 'mini', { width: 320, height: 92 }),
    { full: { width: 700, height: 600 }, mini: { width: 320, height: 92 } },
  );
});
```

- [ ] **Step 2: Add the test file to the package test command and verify RED**

Run:

```powershell
npm.cmd test
```

Expected: FAIL because `src/utils/windowModes.js` does not exist.

- [ ] **Step 3: Implement the pure mode contract**

```js
// src/utils/windowModes.js
export const WINDOW_SIZE_STORAGE_KEY = 'bambu_window_sizes_v1';

const MODE_CONFIG = Object.freeze({
  full: { defaultSize: { width: 720, height: 620 }, minSize: { width: 320, height: 300 } },
  compact: { defaultSize: { width: 380, height: 500 }, minSize: { width: 340, height: 260 } },
  mini: { defaultSize: { width: 300, height: 92 }, minSize: { width: 240, height: 78 } },
  zoom: { defaultSize: { width: 960, height: 680 }, minSize: { width: 480, height: 320 } },
  login: { defaultSize: { width: 860, height: 620 }, minSize: { width: 420, height: 460 } },
});

export function getWindowModeConfig(mode) {
  return MODE_CONFIG[mode] || MODE_CONFIG.full;
}

export function normalizeSavedWindowSize(mode, value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const { minSize } = getWindowModeConfig(mode);
  return {
    width: Math.max(minSize.width, Math.round(width)),
    height: Math.max(minSize.height, Math.round(height)),
  };
}

export function readWindowSizeMap(rawValue) {
  try {
    const value = JSON.parse(rawValue || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function updateWindowSizeMap(current, mode, size) {
  const normalized = normalizeSavedWindowSize(mode, size);
  return normalized ? { ...current, [mode]: normalized } : { ...current };
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm.cmd test`

Expected: all existing tests plus the new window mode tests pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/utils/windowModes.js src/utils/windowModes.test.js
git commit -m "feat: define persistent window modes"
```

---

### Task 2: Enable Native Resizing and Bounds Events

**Files:**
- Create: `electron/window-bounds.cjs`
- Create: `electron/window-bounds.test.cjs`
- Modify: `electron/main.cjs`
- Modify: `electron/preload.cjs`
- Modify: `src/services/electron.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing native bounds tests**

```js
// electron/window-bounds.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { clampWindowSize, getMainWindowOptions } = require('./window-bounds.cjs');

test('creates an opaque resizable frameless window', () => {
  const options = getMainWindowOptions({ width: 400, height: 580, x: 10, y: 20 });
  assert.equal(options.frame, false);
  assert.equal(options.transparent, false);
  assert.equal(options.resizable, true);
  assert.equal(options.maximizable, true);
  assert.equal(options.backgroundColor, '#0b1017');
});

test('clamps renderer sizes to mode minimum and display work area', () => {
  assert.deepEqual(clampWindowSize(
    { width: 2000, height: 100, minWidth: 320, minHeight: 300 },
    { width: 1920, height: 1080 },
  ), { width: 1896, height: 300, minWidth: 320, minHeight: 300 });
});
```

- [ ] **Step 2: Add the native test and verify RED**

Run: `npm.cmd test`

Expected: FAIL because `electron/window-bounds.cjs` does not exist.

- [ ] **Step 3: Implement native option and clamping helpers**

```js
// electron/window-bounds.cjs
function getMainWindowOptions(bounds) {
  return {
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#0b1017',
    hasShadow: true,
    alwaysOnTop: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    useContentSize: true,
  };
}

function clampWindowSize(bounds = {}, workArea = {}) {
  const minWidth = Math.max(96, Number(bounds.minWidth) || 320);
  const minHeight = Math.max(56, Number(bounds.minHeight) || 300);
  const maxWidth = Math.max(minWidth, Number(workArea.width) - 24);
  const maxHeight = Math.max(minHeight, Number(workArea.height) - 24);
  return {
    width: Math.min(maxWidth, Math.max(minWidth, Number(bounds.width) || minWidth)),
    height: Math.min(maxHeight, Math.max(minHeight, Number(bounds.height) || minHeight)),
    minWidth,
    minHeight,
  };
}

module.exports = { clampWindowSize, getMainWindowOptions };
```

- [ ] **Step 4: Apply helpers in Electron and emit debounced user bounds**

Modify `electron/main.cjs` to call `getMainWindowOptions({ width: 400, height: 580, x: Math.round(width / 2 - 200), y: Math.round(height / 2 - 290) })`, merge the returned values with `webPreferences`, call `win.setMinimumSize(minWidth, minHeight)` before `setContentSize`, and add:

```js
let resizeEventTimer = null;

mainWindow.on('resize', () => {
  clearTimeout(resizeEventTimer);
  resizeEventTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getContentSize();
    mainWindow.webContents.send('window-bounds-changed', { width, height });
  }, 120);
});
```

Expose the additional method and event in `electron/preload.cjs`:

```js
setModeSize: (bounds) => ipcRenderer.send('resize-me', bounds),
onWindowBoundsChanged: subscribe('window-bounds-changed'),
```

Add matching wrappers in `src/services/electron.js`:

```js
electronWindow.setModeSize = (bounds) => getElectronApi()?.window.setModeSize(bounds);
electronEvents.onWindowBoundsChanged = (callback) => (
  getElectronApi()?.events.onWindowBoundsChanged(callback) || noOp
);
```

- [ ] **Step 5: Run tests and package smoke build**

Run:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```powershell
git add electron/window-bounds.cjs electron/window-bounds.test.cjs electron/main.cjs electron/preload.cjs src/services/electron.js package.json
git commit -m "feat: enable native window resizing"
```

---

### Task 3: Build the Shared Monitor Shell and CSS System

**Files:**
- Create: `src/components/monitor/MonitorShell.jsx`
- Create: `src/components/monitor/monitor.css`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] **Step 1: Add a browser-visible shell contract**

Add stable attributes used by layout verification. The initial shell structure is:

```jsx
<main className={`monitor-shell monitor-shell--${mode}`} data-testid="monitor-shell">
  <header className="monitor-appbar" data-testid="monitor-drag-region">
    <div className="monitor-identity">
      <strong>BambuMonitor</strong>
      <span>{identityCopy}</span>
    </div>
    <div className="monitor-actions">
      <button type="button" aria-label="同步设备" onClick={onRefresh}><RefreshCw size={15} /></button>
      <button type="button" aria-label={isAlwaysOnTop ? '取消置顶' : '窗口置顶'} onClick={onToggleTop}>
        {isAlwaysOnTop ? <PinOff size={15} /> : <Pin size={15} />}
      </button>
      <button type="button" aria-label="更多操作" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={15} /></button>
    </div>
  </header>
  {mode === 'full' ? (
    <nav className="monitor-tabs" aria-label="监控视图">
      <button type="button" className={activeTab === 'devices' ? 'is-active' : ''} onClick={() => onTabChange('devices')}>设备</button>
      <button type="button" className={activeTab === 'cameras' ? 'is-active' : ''} onClick={() => onTabChange('cameras')}>摄像头</button>
      <span>{syncCopy}</span>
    </nav>
  ) : null}
  <section className="monitor-content">{children}</section>
  <span className="monitor-resize-grip" aria-hidden="true" />
</main>
```

Create a temporary test render in preview mode and verify the shell is missing before implementation by running `npm.cmd run dev -- --host 127.0.0.1` and checking `[data-testid="monitor-shell"]`.

- [ ] **Step 2: Implement `MonitorShell`**

The component accepts this exact interface and renders the app bar shown above plus an overflow menu containing concrete callbacks for compact, mini, lock, settings, reset size, and quit:

```jsx
export default function MonitorShell({
  mode,
  activeTab,
  identityCopy,
  syncCopy,
  isAlwaysOnTop,
  isLocked,
  onTabChange,
  onRefresh,
  onToggleTop,
  onOpenSettings,
  onChangeMode,
  onToggleLock,
  onResetSize,
  onQuit,
  children,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const choose = (callback) => {
    setMenuOpen(false);
    callback();
  };
  return (
    <main className={`monitor-shell monitor-shell--${mode}`} data-testid="monitor-shell">
      <header className="monitor-appbar" data-testid="monitor-drag-region">
        <div className="monitor-identity"><strong>BambuMonitor</strong><span>{identityCopy}</span></div>
        <div className="monitor-actions">
          <button type="button" aria-label="同步设备" onClick={onRefresh}><RefreshCw size={15} /></button>
          <button type="button" aria-label={isAlwaysOnTop ? '取消置顶' : '窗口置顶'} onClick={onToggleTop}>
            {isAlwaysOnTop ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button type="button" aria-label="更多操作" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={15} /></button>
        </div>
      </header>
      {mode === 'full' ? (
        <nav className="monitor-tabs" aria-label="监控视图">
          <button type="button" className={activeTab === 'devices' ? 'is-active' : ''} onClick={() => onTabChange('devices')}>设备</button>
          <button type="button" className={activeTab === 'cameras' ? 'is-active' : ''} onClick={() => onTabChange('cameras')}>摄像头</button>
          <span>{syncCopy}</span>
        </nav>
      ) : null}
      {menuOpen ? (
        <div className="monitor-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => choose(() => onChangeMode('compact'))}><Rows3 size={14} />紧凑模式</button>
          <button type="button" role="menuitem" onClick={() => choose(() => onChangeMode('mini'))}><Minimize2 size={14} />超迷你模式</button>
          <button type="button" role="menuitem" onClick={() => choose(onToggleLock)}><Lock size={14} />{isLocked ? '解除穿透' : '锁定穿透'}</button>
          <button type="button" role="menuitem" onClick={() => choose(onOpenSettings)}><Settings size={14} />设置</button>
          <button type="button" role="menuitem" onClick={() => choose(onResetSize)}><RotateCcw size={14} />重置窗口大小</button>
          <button type="button" role="menuitem" onClick={() => choose(onQuit)}><Power size={14} />退出</button>
        </div>
      ) : null}
      <section className="monitor-content">{children}</section>
      <span className="monitor-resize-grip" aria-hidden="true" />
    </main>
  );
}
```

Use Lucide icons `RefreshCw`, `Pin`, `PinOff`, `MoreHorizontal`, `Camera`, `Rows3`, `Minimize2`, `Lock`, `Settings`, `RotateCcw`, and `Power`. Only the identity/empty header area receives `WebkitAppRegion: 'drag'`; every action and menu receives `no-drag`.

- [ ] **Step 3: Implement shared CSS tokens and responsive shell rules**

```css
.monitor-shell {
  --surface-0: #0b1017;
  --surface-1: #111923;
  --surface-2: #141e29;
  --line: rgba(150, 174, 202, 0.18);
  --text: #edf5ff;
  --muted: #8192a8;
  --mint: #75e7b5;
  --blue: #74bfe9;
  --amber: #ffd17d;
  --danger: #ef7772;
  width: 100vw;
  height: 100vh;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text);
  background: var(--surface-0);
}

.monitor-appbar {
  flex: 0 0 auto;
  min-height: 52px;
  display: grid;
  grid-template-columns: minmax(120px, 1fr) auto;
  align-items: center;
  gap: 12px;
}
```

The CSS must contain no viewport-scaled font sizes, negative letter spacing, purple-dominant gradients, or border radii above 8 px.

- [ ] **Step 4: Compose the shell around the existing content and verify no behavior regression**

Keep existing full/compact/mini branches temporarily as `children`. Confirm refresh, pin, settings, lock, and mode switching still invoke the existing handlers.

- [ ] **Step 5: Run lint/build and commit**

Run: `npm.cmd run lint` and `npm.cmd run build`

```powershell
git add src/components/monitor/MonitorShell.jsx src/components/monitor/monitor.css src/components/PrinterWidget.jsx
git commit -m "feat: add tabbed monitor workspace shell"
```

---

### Task 4: Implement the Responsive Device Workspace

**Files:**
- Create: `src/components/monitor/DeviceCard.jsx`
- Create: `src/components/monitor/DeviceWorkspace.jsx`
- Modify: `src/components/monitor/monitor.css`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] **Step 1: Define the exact component props and preview assertions**

```jsx
<DeviceWorkspace
  printers={displayPrinters}
  summary={summary}
  cloudOverviewCount={cloudOverviewCount}
  renderAction={renderAction}
  presentation={{
    amsInfo,
    infoLine,
    progressPalette,
    safeProgress,
    statusStyle,
    statusText,
    temperatureText,
  }}
/>
```

At `?preview=dashboard`, the DOM must contain one `[data-printer-card]` per preview printer and exactly one `[data-testid="device-grid"]`.

- [ ] **Step 2: Implement `DeviceCard` with the approved hierarchy**

Render name/model/status, task name, progress/remaining time, progress bar, layer/temperature facts, and up to eight AMS chips. Use job status for progress color and connection state only for connection badges.

- [ ] **Step 3: Implement summary and responsive grid CSS**

```css
.device-grid { display: grid; grid-template-columns: 1fr; gap: 10px; overflow: auto; }
@media (min-width: 640px) { .device-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 920px) { .device-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 419px) { .summary-metric--secondary { display: none; } }
```

- [ ] **Step 4: Replace the old full dashboard branch**

Remove the manual horizontal/vertical toggle and its card flex layout. Preserve sorting, cloud guidance, device actions, progress, AMS, and reconnect presentation.

- [ ] **Step 5: Verify four full-workspace viewports**

Check 320 x 600, 380 x 600, 720 x 620, and 1024 x 720. Expected columns: 1, 1, 2, and 3. At every size, document `scrollWidth === clientWidth` and the device grid is vertically scrollable when needed.

- [ ] **Step 6: Commit**

```powershell
git add src/components/monitor/DeviceCard.jsx src/components/monitor/DeviceWorkspace.jsx src/components/monitor/monitor.css src/components/PrinterWidget.jsx
git commit -m "feat: redesign responsive device workspace"
```

---

### Task 5: Implement Compact and Mini Modes

**Files:**
- Create: `src/components/monitor/CompactMonitor.jsx`
- Create: `src/components/monitor/MiniMonitor.jsx`
- Modify: `src/components/monitor/monitor.css`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] **Step 1: Implement compact rows with local expansion**

`CompactMonitor` accepts `printers`, `summary`, `presentation`, and `renderAction`. It owns only `expandedPrinterId`; expanding a row reveals AMS chips without requesting a native resize.

```jsx
const [expandedPrinterId, setExpandedPrinterId] = useState('');
const togglePrinter = (id) => setExpandedPrinterId((current) => current === id ? '' : id);
```

- [ ] **Step 2: Implement the mini rotating slot**

`MiniMonitor` accepts `finishedPrinters`, `activePrinter`, `presentation`, `isAlwaysOnTop`, `onToggleTop`, and `onReturnFull`. Keep the existing 3-second rotation in `PrinterWidget`; the component only renders the selected printer.

- [ ] **Step 3: Replace both legacy branches and apply mode classes**

The compact root uses `monitor-shell--compact`; mini uses `monitor-shell--mini`. Mini has a dedicated drag handle and no full-surface drag region.

- [ ] **Step 4: Verify dimensions and scrolling**

- Compact at 340 x 420 and 420 x 640: no horizontal overflow, actions fit, list scrolls.
- Mini at 240 x 78 and 420 x 92: all controls remain inside bounds, longest device name truncates, progress bar remains stable.

- [ ] **Step 5: Commit**

```powershell
git add src/components/monitor/CompactMonitor.jsx src/components/monitor/MiniMonitor.jsx src/components/monitor/monitor.css src/components/PrinterWidget.jsx
git commit -m "feat: redesign compact and mini monitors"
```

---

### Task 6: Integrate Camera Workspace and Resizable Zoom

**Files:**
- Create: `src/components/monitor/CameraWorkspace.jsx`
- Create: `src/components/monitor/CameraZoom.jsx`
- Modify: `src/components/monitor/monitor.css`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] **Step 1: Move camera card rendering behind a stable interface**

```jsx
<CameraWorkspace
  printers={displayPrinters}
  streams={cameraStreams}
  imageStates={cameraImageStates}
  cameraConfig={cameraConfig}
  onRetry={retryCamera}
  onZoom={setCameraZoomKey}
  onImageStateChange={setCameraImageStates}
/>
```

Move `ChamberSnapshotCanvas` without changing its frame-refresh loop. Preserve `mapWithConcurrency(startableSources, 2, async (source) => restartCameraRef.current?.(source, { stopFirst: false }))`, `getCameraRetryDelay`, timer cleanup when the camera tab closes, and the existing `electronCamera.start`, `electronCamera.stop`, and `electronCamera.stopAll` payloads exactly.

- [ ] **Step 2: Implement responsive camera columns**

```css
.camera-grid { display: grid; grid-template-columns: 1fr; grid-auto-rows: max-content; gap: 10px; overflow: auto; }
@media (min-width: 520px) { .camera-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 780px) { .camera-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.camera-media { aspect-ratio: 16 / 10; overflow: hidden; }
```

- [ ] **Step 3: Implement `CameraZoom`**

Use a draggable 48 px title bar, non-drag close/fit buttons, and a media body with `object-fit: contain`. Entering zoom switches the native mode to `zoom`; leaving restores the saved full-workspace size.

- [ ] **Step 4: Verify camera viewports and retry states**

Check 320 x 600, 760 x 560, and 1024 x 720 for 1/2/3 columns. Simulate ready, pending, manual configuration, and error states in preview fixtures. Ensure every failed card exposes one unique `重试` button.

- [ ] **Step 5: Commit**

```powershell
git add src/components/monitor/CameraWorkspace.jsx src/components/monitor/CameraZoom.jsx src/components/monitor/monitor.css src/components/PrinterWidget.jsx
git commit -m "feat: unify camera workspace and zoom"
```

---

### Task 7: Redesign Settings and Connection Dialogs

**Files:**
- Create: `src/components/monitor/SettingsSheet.jsx`
- Modify: `src/components/monitor/monitor.css`
- Modify: `src/components/PrinterWidget.jsx`
- Modify: `src/App.jsx`

- [ ] **Step 1: Move the existing settings form into `SettingsSheet`**

Use the existing state setters and save handlers as props. Group controls into Window, Startup, Camera, Notifications/Integrations, and Account. Do not change stored setting keys or notification payloads. Add an `onSignOut` callback from `App` that disconnects MQTT, clears the encrypted saved session and account cache, clears printers, and returns to `ConnectionScreen`:

```js
const handleSignOut = async () => {
  await bambuClient.disconnect();
  await electronAuth.clearSavedSession();
  localStorage.removeItem('bambu_account');
  localStorage.removeItem('bambu_token');
  authSessionRef.current = null;
  setPrinters([]);
  setIsConnected(false);
};
```

- [ ] **Step 2: Implement responsive sheet behavior**

```css
.settings-backdrop { position: absolute; inset: 0; overflow: hidden; }
.settings-sheet { position: absolute; inset: 0; display: flex; flex-direction: column; }
@media (min-width: 680px) {
  .settings-sheet { left: auto; width: 360px; border-left: 1px solid var(--line); }
}
.settings-body { min-height: 0; overflow: auto; }
.settings-footer { position: sticky; bottom: 0; }
```

- [ ] **Step 3: Restyle IP and account dialogs without changing behavior**

Dialogs stay centered, max out at `min(360px, calc(100vw - 24px))`, and never set native window dimensions. Cloud-connected devices continue to treat local IP as optional.

- [ ] **Step 4: Verify settings scrolling**

At 420 x 640 settings fills the window; at 760 x 620 it is a right sheet. Scroll to the bottom and verify Save/Restore remain visible and usable.

- [ ] **Step 5: Commit**

```powershell
git add src/components/monitor/SettingsSheet.jsx src/components/monitor/monitor.css src/components/PrinterWidget.jsx src/App.jsx
git commit -m "feat: redesign responsive settings surfaces"
```

---

### Task 8: Redesign Login and Remove Content-Driven Resizing

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/index.css`
- Modify: `src/components/PrinterWidget.jsx`

- [ ] **Step 1: Replace login resize calls with mode sizing**

On login mount, request the saved/default `login` size. After successful connection, switch once to saved/default `full`. Remove hard-coded `450 x 200`, `460 x 610`, and `860 x 620` transition sizes.

- [ ] **Step 2: Implement approved responsive login layout**

Keep password/code behavior and encrypted session restoration. At 760 px and above show identity/form columns; below 760 px hide the identity panel and keep one form column. Use existing app icon and concise copy.

- [ ] **Step 3: Remove the widget `ResizeObserver`**

Delete `widgetRef`, `lastResizeRef`, content measurement, and all resize requests tied to printer count, camera source changes, settings, or dialog content. Add one mode effect:

```js
useEffect(() => {
  const sizes = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
  const config = getWindowModeConfig(nativeMode);
  const size = normalizeSavedWindowSize(nativeMode, sizes[nativeMode]) || config.defaultSize;
  electronWindow.setModeSize({ ...size, minWidth: config.minSize.width, minHeight: config.minSize.height });
}, [nativeMode]);
```

Subscribe to native bounds and persist only the active mode:

```js
useEffect(() => electronEvents.onWindowBoundsChanged((size) => {
  const current = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
  localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify(updateWindowSizeMap(current, nativeMode, size)));
}), [nativeMode]);
```

- [ ] **Step 4: Verify mode persistence in a real Electron session**

Resize full, compact, mini, and zoom to distinct sizes; switch between them and restart the app. Expected: each mode restores its own last size and printer/camera updates never alter it.

- [ ] **Step 5: Commit**

```powershell
git add src/App.jsx src/index.css src/components/PrinterWidget.jsx
git commit -m "feat: persist user-controlled workspace sizes"
```

---

### Task 9: Version, Documentation, Full Verification, and Installation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

- [ ] **Step 1: Bump version to 1.0.12 and update documentation**

Update both package version fields and document:

- Native edge/corner resizing.
- Full/compact/mini independent size memory.
- Device/camera tab workspace.
- Responsive 1/2/3-column behavior.
- Settings sheet behavior.

- [ ] **Step 2: Run the complete automated gate**

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
npm.cmd audit --audit-level=moderate --registry=https://registry.npmjs.org
git diff --check
```

Expected: all tests pass, lint/build exit 0, audit reports 0 vulnerabilities, and diff check reports no whitespace errors.

- [ ] **Step 3: Run browser visual verification**

Use the preview fixtures and capture each viewport listed in the design spec. For every screen assert:

```js
({
  documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  clippedControls: [...document.querySelectorAll('button')].filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.right > innerWidth || rect.bottom > innerHeight || rect.left < 0 || rect.top < 0;
  }).length,
})
```

Expected: `documentOverflowX === 0`; visible controls in the active surface are not clipped; intended inner lists provide scrolling.

- [ ] **Step 4: Build the Windows installer outside OneDrive**

```powershell
.\node_modules\.bin\electron-builder.cmd --win nsis --publish never --config.directories.output=C:\Users\Administrator\AppData\Local\Temp\BambuMonitor-release-1.0.12-codex
```

Expected: `BambuMonitor Setup 1.0.12.exe` and unpacked `BambuMonitor.exe` both report product version 1.0.12.

- [ ] **Step 5: Replace the installed application and verify native resize**

Stop the current BambuMonitor processes, run the installer with `/S`, launch from `%LOCALAPPDATA%\Programs\bambu_monitor\BambuMonitor.exe`, then use native UI automation to drag the left, right, top, bottom, top-left, top-right, bottom-left, and bottom-right resize regions. Verify process version 1.0.12 and changed native bounds after every drag. Switch through full, compact, mini, camera zoom, and back to full; restart the app and confirm each stored size restores. Finally open real camera cards, resize the window, open/close zoom, scroll settings to Save/Restore, and lock/unlock mouse passthrough through the tray.

- [ ] **Step 6: Commit and push after user-facing verification**

```powershell
git add package.json package-lock.json README.md
git commit -m "release: prepare BambuMonitor 1.0.12"
git push -u origin codex/reliability-ui-optimization
```

Do not create or publish a GitHub Release until the installed app passes native resize, mode restoration, camera rendering, and settings-scroll checks.
