# AI Webhook 接入代码

把下面这段代码交给 OpenClaw 或 Hermes 那边的 AI，让它保存为 `bambu-monitor-webhook.cjs` 并运行：

```js
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.BAMBU_MONITOR_SECRET || '';

if (!HMAC_SECRET) {
  console.warn('[Bambu Monitor] BAMBU_MONITOR_SECRET 未设置，任何人都能调用这个接口；仅建议在受信任的局域网内临时使用。');
}

function verifySignature(rawBody, signatureHeader) {
  if (!HMAC_SECRET) return true;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(String(signatureHeader || '')), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function notifyAI(payload) {
  // 这里替换成 OpenClaw / Hermes 自己的通知动作。
  console.log('[Bambu Monitor]', payload.message);
  console.log(JSON.stringify(payload, null, 2));
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/bambu-monitor/webhook') {
    res.writeHead(404);
    res.end('not found');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const signature = req.headers['x-bambu-monitor-signature'] || req.headers['x-hub-signature-256'];

    if (!verifySignature(rawBody, signature)) {
      res.writeHead(401);
      res.end('bad signature');
      return;
    }

    const payload = JSON.parse(rawBody);
    await notifyAI(payload);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(PORT, HOST, () => {
  console.log(`Bambu Monitor webhook listening on http://${HOST}:${PORT}/bambu-monitor/webhook`);
});
```

运行后，在本应用的通知设置里填写：

`http://那台电脑的IP:8787/bambu-monitor/webhook`

如果开启了 HMAC Secret，两边填写同一个 Secret。

安全建议：务必设置 `BAMBU_MONITOR_SECRET`，否则任何能访问该端口的程序都可以伪造通知；如果只在本机联调，可设置 `HOST=127.0.0.1` 避免监听所有网卡。不要把这个端口暴露到公网。
