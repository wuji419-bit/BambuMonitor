# Mini Responsive Device Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every non-button area of the Electron mini window draggable and reveal more of all printers in one row as the window widens, with three-second page rotation for overflow.

**Architecture:** A pure `miniLayout` utility owns capacity, page slicing, wraparound, and clamping so width behavior is deterministic and testable. `MiniMonitor` measures its flexible device strip with `ResizeObserver`, renders the utility's current page, and reports page count upward; `PrinterWidget` owns the existing three-second timer and advances pages. Native drag styles are derived through the existing drag-region utility, while the fixed action area explicitly remains `no-drag`.

**Tech Stack:** React 19, Electron native app regions, Vite, CSS Grid, Node test runner, ESLint

---

## File Structure

- Create `src/utils/miniLayout.js`: pure mini capacity, page normalization, and page slicing.
- Create `src/utils/miniLayout.test.js`: deterministic tests for narrow/wide layouts and carousel boundaries.
- Modify `src/utils/windowDragRegions.js`: expose a context-aware mini surface drag style.
- Modify `src/utils/windowDragRegions.test.js`: verify Electron, locked, and browser drag rules.
- Modify `src/components/monitor/MiniMonitor.jsx`: measure available width and render all-device page cells.
- Modify `src/components/monitor/monitor.css`: responsive one-row device strip and whole-surface drag behavior.
- Modify `src/components/PrinterWidget.jsx`: pass all sorted printers and rotate page indexes.
- Modify `package.json`: register the new pure utility test.

### Task 1: Pure Mini Page Layout

**Files:**
- Create: `src/utils/miniLayout.js`
- Create: `src/utils/miniLayout.test.js`
- Modify: `package.json:19`

- [ ] **Step 1: Write the failing layout tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMiniPage, MINI_DEVICE_MIN_WIDTH } from './miniLayout.js';

const devices = ['A', 'B', 'C', 'D', 'E'];

test('falls back to one readable mini device when width is unavailable', () => {
  assert.deepEqual(createMiniPage(devices, 0, 0), {
    capacity: 1,
    pageCount: 5,
    pageIndex: 0,
    devices: ['A'],
  });
});

test('reveals more devices as the mini strip widens', () => {
  assert.equal(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 0).capacity, 2);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 3, 0).devices, ['A', 'B', 'C']);
});

test('rotates complete pages and wraps overflow indexes', () => {
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 1).devices, ['C', 'D']);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 2).devices, ['E']);
  assert.deepEqual(createMiniPage(devices, MINI_DEVICE_MIN_WIDTH * 2, 3).devices, ['A', 'B']);
});

test('keeps an empty device list on a stable first page', () => {
  assert.deepEqual(createMiniPage([], MINI_DEVICE_MIN_WIDTH * 4, 8), {
    capacity: 1,
    pageCount: 1,
    pageIndex: 0,
    devices: [],
  });
});
```

Add `src/utils/miniLayout.test.js` to the `test` script immediately before `src/utils/windowDragRegions.test.js`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/utils/miniLayout.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/utils/miniLayout.js`.

- [ ] **Step 3: Implement the minimal pure layout utility**

```js
export const MINI_DEVICE_MIN_WIDTH = 190;

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function createMiniPage(inputDevices, availableWidth, requestedPage = 0) {
  const allDevices = Array.isArray(inputDevices) ? inputDevices : [];
  const width = Number(availableWidth);
  const rawCapacity = Number.isFinite(width) && width > 0
    ? Math.floor(width / MINI_DEVICE_MIN_WIDTH)
    : 1;
  const capacity = Math.max(1, Math.min(allDevices.length || 1, positiveInteger(rawCapacity, 1)));
  const pageCount = Math.max(1, Math.ceil(allDevices.length / capacity));
  const requested = Math.trunc(Number(requestedPage)) || 0;
  const pageIndex = ((requested % pageCount) + pageCount) % pageCount;
  const start = pageIndex * capacity;

  return {
    capacity,
    pageCount,
    pageIndex,
    devices: allDevices.slice(start, start + capacity),
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test src/utils/miniLayout.test.js`

Expected: 4 tests pass.

- [ ] **Step 5: Commit the pure layout unit**

```powershell
git add package.json src/utils/miniLayout.js src/utils/miniLayout.test.js
git commit -m "feat: add responsive mini page layout"
```

### Task 2: Context-Aware Native Drag Surface

**Files:**
- Modify: `src/utils/windowDragRegions.js`
- Modify: `src/utils/windowDragRegions.test.js`

- [ ] **Step 1: Write failing mini drag-context tests**

Extend the import and add this test:

```js
import {
  dragRegionStyle,
  miniSurfaceDragStyle,
  noDragRegionStyle,
} from './windowDragRegions.js';

test('makes the mini surface draggable only in unlocked Electron windows', () => {
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: false, isNativeWindow: true }), {
    WebkitAppRegion: 'drag',
    cursor: 'move',
  });
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: true, isNativeWindow: true }), {
    WebkitAppRegion: 'no-drag',
    cursor: 'default',
  });
  assert.deepEqual(miniSurfaceDragStyle({ isLocked: false, isNativeWindow: false }), {
    WebkitAppRegion: 'no-drag',
    cursor: 'default',
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test src/utils/windowDragRegions.test.js`

Expected: FAIL because `miniSurfaceDragStyle` is not exported.

- [ ] **Step 3: Implement the contextual style helper**

```js
export function miniSurfaceDragStyle({ isLocked = false, isNativeWindow = true } = {}) {
  return dragRegionStyle(isLocked || !isNativeWindow);
}
```

- [ ] **Step 4: Run focused drag tests and verify GREEN**

Run: `node --test src/utils/windowDragRegions.test.js`

Expected: 3 tests pass.

- [ ] **Step 5: Commit the drag helper**

```powershell
git add src/utils/windowDragRegions.js src/utils/windowDragRegions.test.js
git commit -m "fix: define mini window drag surface"
```

### Task 3: Render Responsive All-Device Pages

**Files:**
- Modify: `src/components/monitor/MiniMonitor.jsx`
- Modify: `src/components/PrinterWidget.jsx:501, 545-551, 729-740, 1361-1363`
- Modify: `src/components/monitor/monitor.css:667-681`

- [ ] **Step 1: Use the tested page model in `MiniMonitor`**

Replace the single-printer component with a measured strip. Import `useEffect`, `useMemo`, `useRef`, and `useState`; import `createMiniPage`, `miniSurfaceDragStyle`, and `noDragRegionStyle`. The public props become:

```jsx
export default function MiniMonitor({
  printers,
  pageIndex,
  onPageCountChange,
  presentation,
  isAlwaysOnTop,
  isLocked,
  isNativeWindow,
  onToggleTop,
  onReturnFull,
})
```

Measure the flexible strip without adding window IPC traffic:

```jsx
const stripRef = useRef(null);
const [stripWidth, setStripWidth] = useState(0);

useEffect(() => {
  const node = stripRef.current;
  if (!node) return undefined;
  const update = (width) => setStripWidth((current) => (
    Math.abs(current - width) >= 1 ? width : current
  ));
  update(node.getBoundingClientRect().width);
  if (typeof ResizeObserver !== 'function') return undefined;
  const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
  observer.observe(node);
  return () => observer.disconnect();
}, []);

const page = useMemo(
  () => createMiniPage(printers, stripWidth, pageIndex),
  [pageIndex, printers, stripWidth],
);

useEffect(() => {
  onPageCountChange(page.pageCount);
}, [onPageCountChange, page.pageCount]);
```

Render `.mini-monitor` with `style={miniSurfaceDragStyle({ isLocked, isNativeWindow })}`. Render `page.devices` inside `.mini-device-strip`, one `.mini-device` per printer, reusing the existing progress/status calculations for each printer. Use a stable key in this order: `serialNumber`, `dev_id`, `id`, then `name`. Render the existing empty copy when `page.devices` is empty. Apply `style={noDragRegionStyle()}` to `.mini-actions` so both buttons stay clickable.

- [ ] **Step 2: Replace individual active-printer rotation with page rotation**

In `PrinterWidget.jsx`, rename `miniActiveIndex` to `miniPageIndex` and add:

```jsx
const [miniPageCount, setMiniPageCount] = useState(1);
```

Delete `activeMiniPrinters` and `rotatingMiniPrinter`. Replace the timer effect with:

```jsx
useEffect(() => {
  setMiniPageIndex((current) => current % Math.max(1, miniPageCount));
  if (!isMini || miniPageCount <= 1) return undefined;
  const timer = setInterval(() => {
    setMiniPageIndex((current) => (current + 1) % miniPageCount);
  }, MINI_ROTATE_MS);
  return () => clearInterval(timer);
}, [isMini, miniPageCount]);
```

Pass the complete sorted list and drag context:

```jsx
<MiniMonitor
  printers={displayPrinters}
  pageIndex={miniPageIndex}
  onPageCountChange={setMiniPageCount}
  presentation={{ infoLine: displayInfoLine, progressPalette, safeProgress, statusText }}
  isAlwaysOnTop={isAlwaysOnTop}
  isLocked={isLocked}
  isNativeWindow={Boolean(capabilities.nativeWindow)}
  onToggleTop={toggleAlwaysOnTop}
  onReturnFull={() => changeViewMode('full')}
/>
```

- [ ] **Step 3: Convert mini CSS to a responsive draggable strip**

Replace the old three-column handle layout with:

```css
.mini-monitor { display: grid; grid-template-columns: minmax(0, 1fr) 58px; align-items: stretch; gap: 5px; width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 5px; overflow: hidden; }
.mini-device-strip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); align-items: stretch; min-width: 0; overflow: hidden; }
.mini-device { display: grid; grid-template-rows: 18px 14px 5px; align-content: center; gap: 2px; min-width: 0; padding: 0 8px; overflow: hidden; border-right: 1px solid var(--line); }
.mini-device:last-child { border-right: 0; }
.mini-empty { display: flex; align-items: center; min-width: 0; padding: 0 8px; color: var(--muted); font-size: 10px; }
.mini-actions { align-self: center; }
```

Keep the existing `.mini-primary`, `.mini-status`, `.mini-progress`, and button rules. Remove `.mini-drag-handle` rules. Ensure `.mini-actions` and its buttons retain `-webkit-app-region: no-drag`.

- [ ] **Step 4: Run focused tests, lint, and build**

Run:

```powershell
node --test src/utils/miniLayout.test.js src/utils/windowDragRegions.test.js
npm run lint
npm run build
```

Expected: all focused tests pass; ESLint reports no errors; Vite production build succeeds.

- [ ] **Step 5: Commit responsive mini rendering**

```powershell
git add src/components/monitor/MiniMonitor.jsx src/components/PrinterWidget.jsx src/components/monitor/monitor.css
git commit -m "feat: show responsive device pages in mini mode"
```

### Task 4: Full Regression And Desktop Interaction Verification

**Files:**
- Verify only; no planned production file changes.

- [ ] **Step 1: Run the full automated suite**

Run:

```powershell
npm test
npm run lint
npm run build
git diff --check HEAD~3..HEAD
```

Expected: all tests pass, lint and build succeed, and `git diff --check` prints no output.

- [ ] **Step 2: Verify mini mode in Electron**

Run: `npm run electron:dev`

Verify these observable behaviors:

1. At the default 300-pixel mini width, one device is readable and both action buttons are visible.
2. Dragging from the device name, status, progress bar, padding, or empty state moves the window smoothly.
3. Clicking either action button performs its action and does not start a drag.
4. Widening the window reveals two and then three devices in one row without shrinking text below the designed cell width.
5. With more devices than fit, pages rotate every three seconds and every device appears.
6. Idle and offline devices appear, not only active print jobs.
7. Locking mouse passthrough disables dragging; unlocking restores it.
8. Narrowing the window while a later page is visible does not show an empty page.

- [ ] **Step 3: Inspect repository state**

Run: `git status --short --branch`

Expected: only the user's pre-existing deleted video files remain outside the committed feature work:

```text
 D docs/media/video/bambu-monitor-bilibili-en.mp4
 D docs/media/video/bambu-monitor-bilibili-zh.mp4
```
