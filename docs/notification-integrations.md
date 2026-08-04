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
    "ip": "192.0.2.100",
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

Configure notification targets in the app: Settings → 通知与集成 (enable toggle, cooldown seconds, per-target URL and HMAC secret, plus test/copy-connector buttons). The values persist to `localStorage` under `bambu_notification_integrations`.

Notifications ship disabled by default (`enabled: false`, empty `url`/`secret`). The snippet below is an override example you can paste into DevTools if you need to script the configuration instead of using the settings UI:

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
      url: 'http://127.0.0.1:8645/webhooks/bambu-monitor',
      secret: 'replace-with-hermes-route-secret'
    }
  ]
}));
```

## Request headers

Every request carries `content-type: application/json` and `x-bambu-monitor-provider: <target type>`. When `secret` is set, the main process signs the body with HMAC-SHA256 and sends the signature in these headers for compatibility:

- `x-bambu-monitor-signature`
- `x-hub-signature-256`
- `x-openclaw-signature` or `x-hermes-signature`

All signature values use the format `sha256=<hex digest>`.

Optionally, a target may also define `token` (sent as `Authorization: Bearer <token>`) and a `headers` object with extra custom headers.
