# Notification integrations

BambuMonitor can emit printer lifecycle events to webhook-based automation tools such as OpenClaw and Hermes.

## Events

- `print_finished`: a printer transitions into `finished`.
- `printer_issue`: a printer transitions into `error`.
- `printer_disconnected`: a printer transitions into `disconnected`.
- `printer_recovered`: a printer recovers from `error` or `disconnected`.

## Payload

```json
{
  "source": "bambu-monitor",
  "event": "print_finished",
  "severity": "success",
  "title": "打印完成",
  "message": "A1 mini 打印完成",
  "occurredAt": "2026-05-12T10:00:00.000Z",
  "previousStatus": "printing",
  "printer": {
    "id": "PRINTER_SERIAL",
    "cloudId": "CLOUD_ID",
    "name": "A1 mini",
    "ip": "192.168.1.100",
    "status": "finished",
    "progress": 100,
    "timeLeft": "--",
    "filename": "helmet_clip_v7.3mf",
    "layer": "188/188",
    "speed": 100,
    "temperature": {
      "nozzle": 218,
      "bed": 58
    },
    "errorMsg": ""
  }
}
```

## Local configuration

Until the settings UI is added, notification targets are read from `localStorage` under `bambu_notification_integrations`.

```js
localStorage.setItem('bambu_notification_integrations', JSON.stringify({
  enabled: true,
  cooldownMs: 30000,
  targets: [
    {
      id: 'openclaw',
      name: 'OpenClaw',
      type: 'openclaw',
      enabled: true,
      url: 'http://127.0.0.1:8644/webhooks/bambu-monitor',
      secret: 'replace-with-openclaw-route-secret'
    },
    {
      id: 'hermes',
      name: 'Hermes',
      type: 'hermes',
      enabled: true,
      url: 'http://127.0.0.1:8644/webhooks/bambu-monitor',
      secret: 'replace-with-hermes-route-secret'
    }
  ]
}));
```

The main process signs every request with HMAC-SHA256 when `secret` is set. It sends the signature in these headers for compatibility:

- `x-bambu-monitor-signature`
- `x-hub-signature-256`
- `x-openclaw-signature` or `x-hermes-signature`

All signature values use the format `sha256=<hex digest>`.
