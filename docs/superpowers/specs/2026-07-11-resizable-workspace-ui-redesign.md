# BambuMonitor Resizable Workspace UI Redesign

## Goal

Replace the current fixed-size dashboard with a coherent resizable desktop workspace. Every desktop surface must share one visual system, remain usable from a 320 px narrow window through a large multi-column window, and never let automatic sizing override a size chosen by the user.

The approved visual direction is the **tabbed workspace (option C)** shown in the visual companion. This release covers the login screen, full dashboard, compact dashboard, mini monitor, camera wall, camera zoom, settings, and connection dialogs.

## Root Causes Being Addressed

1. The Electron `BrowserWindow` is created with `resizable: false`, so native edge and corner resizing is disabled.
2. The window is transparent. Electron documents transparent windows as not reliably resizable, so the opaque application surface must become the native window background.
3. A renderer `ResizeObserver` repeatedly sends programmatic resize requests. This can fight a user-selected size as printer content changes.
4. The full header puts the title and seven actions on one row. At narrow widths, the action group consumes nearly all horizontal space and forces Chinese title text into a vertical column.
5. The root widget uses a preferred pixel width instead of filling the viewport, so manually enlarging the window would otherwise create unused space rather than a responsive layout.

## Window Behavior

### Native Window

- Create the main window with `resizable: true`, `maximizable: true`, `transparent: false`, and a fixed dark `backgroundColor`.
- Keep the frameless appearance and `fullscreenable: false`.
- Use a dedicated header drag region. Cards, tabs, lists, buttons, menus, settings, and resize edges remain non-drag regions.
- Native Windows/macOS edge and corner hit areas perform resizing. A small bottom-right grip visually communicates that resizing is available, but it does not replace native resizing.
- The application surface fills `100vw` and `100vh`; it never keeps a smaller fixed-width panel inside a larger window.

### Mode Sizes

Each view mode stores its most recent user size independently.

| Mode | First-open size | Minimum size | Notes |
| --- | --- | --- | --- |
| Full workspace | 720 x 620 | 320 x 300 | Device and camera tabs share this size |
| Compact | 380 x 500 | 340 x 260 | Device rows scroll vertically |
| Mini | 300 x 92 | 240 x 78 | May be stretched horizontally |
| Camera zoom | 960 x 680 | 480 x 320 | Image remains aspect-fit |
| Login | 860 x 620 | 420 x 460 | Collapses to one column below 760 px |

Programmatic sizing runs only when a mode is opened for the first time or when the user explicitly requests a reset. Printer updates, device synchronization, card expansion, and camera status changes must not resize the native window.

The main process emits user resize bounds to the renderer. The renderer persists width and height by mode, with bounds clamped to the active display work area before restoration.

## Shared Workspace Shell

The full dashboard and camera wall use the same shell:

1. **App bar:** product name and concise connection/sync state on the left.
2. **Primary actions:** refresh, always-on-top, and overflow menu on the right.
3. **Primary tabs:** `设备` and `摄像头`.
4. **Content region:** the selected responsive device or camera grid.
5. **Resize affordance:** subtle lower-right grip.

The overflow menu contains low-frequency actions: switch to compact mode, switch to mini mode, lock mouse passthrough, open settings, reset window size, and quit. The old manual horizontal/vertical layout toggle is removed because the content now responds to width automatically.

No title may wrap character-by-character. Action groups never force the title below 120 px of usable width. At narrow widths, secondary sync copy is truncated and actions remain a fixed three-button group.

## Device Workspace

### Summary

The summary shows total devices, online, printing, and attention. At narrow widths it reduces to the two operationally important metrics, online and printing; total and attention remain available in the overflow summary/menu.

### Responsive Grid

- Device cards use an auto-fit grid with a target minimum card width of 280 px.
- Viewports from 320-639 px use one column.
- Viewports from 640-919 px use two columns.
- Viewports at 920 px and wider use three columns; additional columns are allowed only when every card remains at least 280 px wide.
- The grid scrolls vertically when cards exceed available height.

### Device Card Hierarchy

Each full card presents, in order:

1. Printer name/model and status badge.
2. Current task name.
3. Progress and remaining time.
4. Stable progress bar.
5. Layer and temperature facts.
6. AMS/spool indicators when present.

Printing and drying cards receive a restrained active border. Idle/completed cards are visually quieter. Paused, offline, reconnecting, and error states remain distinct from job progress.

## Compact Mode

Compact mode is a focused vertical monitor, not a compressed copy of the full layout.

- A short app bar contains product identity, refresh, pin, and overflow actions.
- A four-value summary remains one row at the default width.
- Each printer is a single compact row with name/state, progress, remaining time, layer, and temperatures.
- Selecting a printer temporarily expands its row for AMS details without changing native window size.
- The printer list owns vertical scrolling.

## Mini Mode

Mini mode shows one active printer at a time.

- A dedicated left drag handle moves the window.
- The center shows printer name, progress/remaining time, one concise status line, and a progress bar.
- Pin and return-to-full actions remain visible on the right.
- Multiple active printers rotate on the existing interval; completed devices do not occupy the rotating slot.
- Mini mode can be stretched horizontally, but its information hierarchy does not reflow vertically.

## Camera Workspace

- Camera is a primary tab inside the shared workspace, not a separate visual shell.
- Camera cards use a responsive grid with a minimum width of 240 px and a fixed 16:10 media region.
- Viewports below 520 px use one camera column, 520-779 px use two, and 780 px or wider use three or more while preserving the 240 px minimum.
- Each card shows printer name and one of: `有画面`, `连接中`, `需配置`, or `无画面`.
- Image-ready cards expose a zoom action; failed cards expose a scoped retry action.
- Camera startup concurrency and bounded retry behavior from version 1.0.11 remain unchanged.

## Camera Zoom

- Zoom is a full-window view with a compact draggable title bar.
- The image uses `object-fit: contain` and never crops the printer view.
- Close and fit controls are explicit non-drag buttons.
- The zoom window/view remains natively resizable and stores a separate size.

## Settings

- Settings opens as a right-side sheet in windows at least 680 px wide.
- Below 680 px it becomes a full-window settings surface.
- Sections are Window, Startup, Camera, Notifications/Integrations, and Account.
- Save/restore actions stay visible in a sticky footer.
- Settings content scrolls independently; the underlying dashboard never scrolls with it.

## Login

- The login screen keeps password and verification-code modes.
- At 760 px and above it uses a restrained two-column identity/form layout.
- Below 760 px the identity panel collapses and the form becomes a single column.
- Login remains resizable, uses the same color tokens and radii as the monitor, and contains no marketing-style hero treatment.

## Status Language

The interface uses a functional, multi-tone palette:

- Mint: online, printing, drying, completed.
- Blue: cloud source, connecting, synchronization.
- Amber: paused, needs configuration, degraded data.
- Red: explicit error or offline state only.
- Neutral gray: idle, unknown, secondary metadata.

Cards use charcoal surfaces with restrained borders. Dominant gradients, oversized typography, nested cards, and decorative background shapes are excluded.

## Component Architecture

`PrinterWidget.jsx` is currently responsible for presentation, window sizing, camera lifecycle, dialogs, and settings. The redesign separates presentation while preserving the existing data and camera behavior:

- `MonitorShell`: app bar, tabs, overflow menu, drag region, and resize affordance.
- `DeviceWorkspace`: summary and responsive device grid.
- `DeviceCard`: full device presentation.
- `CompactMonitor`: compact list and expandable row.
- `MiniMonitor`: rotating active printer slot.
- `CameraWorkspace`: responsive camera grid and retry states.
- `CameraZoom`: zoom title bar and image surface.
- `SettingsSheet`: responsive sheet/full-screen settings.
- `windowModes`: pure mode size/default/clamping helpers.
- `monitor.css`: shared tokens, responsive grids, and mode-specific layout.

Printer data, notification dispatch, cloud/local MQTT behavior, device reconciliation, and camera start/retry services remain unchanged except where a stable component interface is needed.

## Data and Interaction Flow

1. `App` supplies printer data and device-refresh state to the workspace.
2. The shell owns selected tab and view mode.
3. View mode changes request a saved or default native size once.
4. Native user resize events update the saved size for the active mode.
5. CSS grid responds to viewport width without renderer-driven native resizing.
6. Camera and settings surfaces consume the same printer/configuration state as today.

## Error Handling

- Invalid saved window dimensions fall back to mode defaults.
- Restored bounds are clamped to the current display so a monitor change cannot leave the app off-screen.
- Camera failure remains scoped to one card and never blocks the camera grid.
- Device or cloud refresh failures keep the current device list visible.
- Overflow menu and settings always remain reachable at minimum supported widths.

## Testing and Acceptance Criteria

### Automated

- Pure tests for mode defaults, minimums, saved-size validation, and display clamping.
- Existing 58 unit tests remain green.
- ESLint and production Vite build pass.
- Electron packaging succeeds for Windows.

### Browser Layout Verification

Verify screenshots and overflow metrics at:

- Full device workspace: 320 x 600, 380 x 600, 720 x 620, 1024 x 720.
- Compact: 340 x 420 and 420 x 640.
- Mini: 240 x 78 and 420 x 92.
- Camera workspace: 320 x 600, 760 x 560, 1024 x 720.
- Camera zoom: 480 x 320 and 960 x 680.
- Settings: 420 x 640 and 760 x 620.
- Login: 420 x 620 and 860 x 620.

No viewport may have horizontal document overflow, clipped controls, vertical title text, collapsed cards, or inaccessible scrolling.

### Native Electron Verification

- Drag every edge and all four corners and confirm the native bounds change.
- Confirm user-selected full, compact, mini, and zoom sizes survive mode switches and app restart.
- Confirm title-bar dragging still moves the window and buttons remain clickable.
- Confirm mouse passthrough lock and tray unlock still work.
- Confirm camera cards and zoom continue rendering after manual resize.

## Release

The implementation will bump the application to version `1.0.12`, build a Windows installer, replace the currently running installation, and verify the installed/running file version. Source changes remain cross-platform; macOS packaging is not performed on Windows.

## Non-Goals

- Printer control commands.
- Automatic updater implementation.
- Changes to cloud MQTT protocol behavior.
- Changes to camera transport protocols.
- New notification providers.
