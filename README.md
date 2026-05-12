# BambuMonitor

BambuMonitor is a desktop floating monitor for Bambu Lab printers. It signs in with a Bambu account, reads the bound printer list, discovers reachable printers on the LAN, and displays real-time print progress through local MQTT.

## Features

- Multi-printer desktop overlay for Bambu Lab devices
- Full, compact, and mini window modes
- Always-on-top mode, click-through lock, and opacity control
- Password and verification-code login
- LAN discovery with manual IP fallback
- Real-time progress, remaining time, layer, temperature, fan, speed, and AMS display
- Windows tray menu for show/hide, lock, layout, opacity, and quit
- Webhook notifications for OpenClaw, Hermes, or other automation tools

## Tech Stack

- Electron 40
- React 19
- Vite 7
- MQTT over TLS
- Bambu Cloud API and LAN SSDP discovery

## Development

```bash
npm install
npm run electron:dev
```

## Build

```bash
npm run build
npm run electron:build
```

The packaged Windows installer is generated in `release/`. Build outputs are intentionally not committed.

## Common Shortcuts

- `Ctrl + Shift + L`: lock or unlock click-through mode
- `Ctrl + Shift + H`: switch horizontal or vertical layout

## Project Structure

```text
electron/
  main.cjs        Electron main process
  preload.cjs     Renderer bridge
src/
  App.jsx         Login flow and page switching
  components/
    PrinterWidget.jsx
    MobileDashboard.jsx
  services/
    bambu.js      Printer state and MQTT parsing
    electron.js   Electron API wrapper
    notifications.js
docs/
  ai-webhook-connector.md
  notification-integrations.md
tools/
  generate-icon.ps1
```

## Notes

- Real-time LAN status requires the computer and printer to be on the same local network.
- The app stores session/configuration data locally through Electron and browser storage.
- Webhook targets and HMAC secrets are user-provided at runtime. Do not commit real secrets.

## License

MIT
