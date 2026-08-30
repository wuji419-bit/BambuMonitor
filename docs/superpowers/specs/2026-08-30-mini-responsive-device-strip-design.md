# BambuMonitor Mini Responsive Device Strip Design

## Goal

Make the desktop mini window easy to drag and let horizontal resizing reveal more devices in one row. The mini view must include every device, including active, idle, and offline printers, while preserving readable content at narrow widths.

## Current Problem

The mini window only marks its 22-pixel grip as a native Electron drag region. The printer name, status, and progress area remain `no-drag`, so most of the window cannot start a drag. The mini view also selects one active printer and rotates printers individually every three seconds, regardless of available width.

## Interaction Design

- In Electron, every non-interactive part of the mini window is a native drag region.
- The always-on-top and return-to-full buttons remain clickable `no-drag` regions.
- Locked mouse-passthrough mode disables all window dragging.
- Browser/NAS rendering does not expose native drag regions.
- The mini view displays all printers using the existing deterministic display order.
- A narrow mini window shows one device. As the user widens the window, additional devices appear in the same row.
- Each device receives a stable readable width of approximately 180 to 200 pixels. The action area remains fixed and visible.
- When not all devices fit, the view divides them into width-sized pages and advances to the next page every three seconds.
- A resize that changes page capacity immediately recalculates the page and clamps the active page to a valid value.
- Device additions, removals, and reordering cannot leave the carousel on an empty page.

## Component Design

### Mini layout calculation

Add a focused utility that converts available device-strip width and device count into a page capacity and page slices. It will enforce a capacity of at least one and keep width calculations independent from React and the DOM.

### MiniMonitor

`MiniMonitor` receives the complete sorted printer list rather than a single rotating printer. It observes the available strip width, calculates the visible page, and renders one compact device cell per visible printer. Empty state remains available when there are no printers.

The outer mini surface owns the drag region. Device cells are non-interactive and remain draggable. Only the fixed action controls override the region with `no-drag`.

### PrinterWidget

`PrinterWidget` continues to own the carousel timer. The timer advances by page rather than by individual active printer. It resets or clamps the page when device count or visible capacity changes. Existing sorted `displayPrinters` is the sole data source, so active, idle, and offline devices share the same ordering as the other views.

## Data Flow

1. `PrinterWidget` sorts all printers using the existing display helper.
2. `MiniMonitor` measures the width available between the fixed window controls and its outer padding.
3. The pure layout utility returns the number of devices that fit and the current page slice.
4. `PrinterWidget` advances the page every three seconds only when more than one page exists.
5. Resizing or device-list changes recalculate capacity and keep the page index valid.

## Error And Edge Handling

- Zero or invalid measured width falls back to one visible device.
- Zero devices renders the existing empty-state language and leaves the non-button surface draggable.
- One page does not run a carousel timer.
- A device count reduction clamps the active page before rendering.
- Rapid bounds events only update local layout state; they do not invoke Electron window movement APIs or write additional persistent state.

## Testing

Follow test-driven development:

- Pure utility tests cover one-device fallback, wider capacities, page slicing, wraparound, and page clamping after device removal.
- Component-facing tests verify that mini mode receives all sorted printers instead of the previous active-only selection.
- Drag-region tests verify that the mini surface is draggable, action buttons remain `no-drag`, and locked/web states disable native dragging.
- Run the focused tests first and observe the new tests fail before production changes.
- Run the complete `npm test`, lint command, and `git diff --check` after implementation.

## Non-Goals

- No changes to compact or full mode layout.
- No manual horizontal scrolling.
- No device filtering controls in mini mode.
- No changes to account aggregation, MQTT ownership, camera lifecycle, or printer ordering.
- No source migration from the historical worktree as part of this change.
