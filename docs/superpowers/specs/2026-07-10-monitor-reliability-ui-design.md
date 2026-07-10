# BambuMonitor Reliability And UI Optimization Design

## Goal

Make the desktop monitor trustworthy with five or more printers: transient network reconnects must not erase the current print state, newly bound devices must appear without restarting the app, failed cameras must recover without reopening the wall, and sensitive account data must not be logged or stored as plain renderer data.

## Scope

This release covers five connected improvements:

1. Separate print-job status from MQTT connection health.
2. Add manual and periodic cloud device synchronization.
3. Add bounded camera startup and per-camera retry.
4. Protect the saved Bambu session and remove sensitive API response logging.
5. Improve dashboard hierarchy for reconnecting, stale, cloud-only, and attention states.

Automatic application updates, installer signing, a complete settings-page redesign, and printer control commands remain out of scope for this release.

## State Model

Printer state keeps the existing `status` field for job compatibility and adds `connectionState` with `connecting`, `online`, `reconnecting`, `offline`, or `error`. MQTT lifecycle events update only `connectionState`; telemetry updates `status`, `lastTelemetryAt`, and the live print fields.

During a transient reconnect, the last known progress, task state, temperature, AMS data, and remaining time remain visible. The card displays a secondary reconnect badge. Summary counts use centralized selectors so `connecting` is never counted as online and an active print remains counted while its transport reconnects.

## Device Synchronization

The authenticated session remains available to `App` through an in-memory ref backed by Electron session storage. A synchronization function reads the bound-device list, merges it with existing telemetry by cloud ID or serial number, connects newly discovered devices, removes devices no longer bound, and performs LAN discovery in the background.

Synchronization runs on demand and periodically while the dashboard is open. The UI shows a refresh icon, busy state, last successful synchronization time, and a non-blocking error message. Overlapping refreshes are suppressed.

## Camera Recovery

Camera startup uses a reusable concurrency-limited runner so only two cameras initialize at once. A failed camera exposes a retry control that stops its old source, starts it again, and updates only that card. Automatic retry uses a small bounded schedule and never loops forever. Closing the camera wall cancels pending UI work and stops camera resources.

## Security

Production session persistence uses Electron `safeStorage` when available and migrates the existing JSON session on the next successful read/write. The renderer no longer keeps the access token in `localStorage`. Main-process logs report request outcomes without serializing login responses, access tokens, device access codes, or full device payloads.

The release also refreshes vulnerable transitive dependencies when compatible updates are available.

## UI

The dashboard retains the current visual language. Changes are limited to clearer information hierarchy:

- summary counts come from one tested selector;
- reconnecting and offline connection health appear independently from print state;
- cloud-only guidance is shown only when applicable;
- devices are ordered by attention, active work, then idle/completed state;
- the header gains a device-sync action and last-sync feedback;
- camera error cards gain an explicit retry action.

## Error Handling

Cloud refresh failures leave the current device list intact. Camera retry failures remain scoped to one printer. Session decryption failure clears only the unreadable saved session and returns the user to login. No background failure should replace usable telemetry with an empty dashboard.

## Testing

Pure utilities cover connection presentation, device inventory reconciliation, camera concurrency/retry decisions, and encrypted session envelopes. Existing MQTT, camera, login, print-status, and drag-region tests remain green. Final verification includes the complete unit suite, lint, build, dependency audit, and browser screenshots at compact, full, settings, and camera-wall sizes.
