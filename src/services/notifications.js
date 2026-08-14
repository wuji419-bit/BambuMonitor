import { electronNotifications, isElectronEnvironment } from './electron.js';
import { getPrinterConnectionState, getPrinterJobStatus } from '../utils/printerPresentation.js';

const STORAGE_KEY = 'bambu_notification_integrations';
const DEFAULT_COOLDOWN_MS = 30_000;
const EVENT_COPY = {
  print_finished: {
    severity: 'success',
    title: '打印完成',
    action: '打印完成',
  },
  printer_issue: {
    severity: 'error',
    title: '打印机异常',
    action: '出现异常',
  },
  printer_disconnected: {
    severity: 'warning',
    title: '打印机断开',
    action: '连接断开',
  },
  printer_recovered: {
    severity: 'info',
    title: '打印机恢复',
    action: '恢复在线',
  },
};

const recentEvents = new Map();

export function createDefaultNotificationConfig() {
  return {
    enabled: false,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    targets: [
      {
        id: 'openclaw',
        name: 'OpenClaw',
        type: 'openclaw',
        enabled: false,
        url: '',
        secret: '',
      },
      {
        id: 'hermes',
        name: 'Hermes',
        type: 'hermes',
        enabled: false,
        url: '',
        secret: '',
      },
    ],
  };
}

export function mergeNotificationConfig(
  current = createDefaultNotificationConfig(),
  incoming = {},
) {
  const currentTargets = Array.isArray(current?.targets) ? current.targets : [];
  const incomingTargets = Array.isArray(incoming?.targets) ? incoming.targets : [];
  const targetIds = new Set([
    ...currentTargets.map((target) => target?.id),
    ...incomingTargets.map((target) => target?.id),
  ].filter(Boolean));
  const targets = [...targetIds].map((id) => ({
    ...(currentTargets.find((target) => target?.id === id) || {}),
    ...(incomingTargets.find((target) => target?.id === id) || {}),
  }));

  return {
    enabled: Boolean(incoming?.enabled ?? current?.enabled),
    cooldownMs: Number(current?.cooldownMs) || DEFAULT_COOLDOWN_MS,
    targets,
  };
}

export function buildServerNotificationConfig(config = {}) {
  return {
    enabled: Boolean(config?.enabled),
    targets: Array.isArray(config?.targets) ? config.targets.map((target) => ({ ...target })) : [],
  };
}

export function getNotificationConfig() {
  if (typeof localStorage === 'undefined') {
    return createDefaultNotificationConfig();
  }

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored || typeof stored !== 'object') {
      return createDefaultNotificationConfig();
    }

    const defaults = createDefaultNotificationConfig();
    const storedTargets = Array.isArray(stored.targets) ? stored.targets : [];
    const targets = defaults.targets.map((target) => ({
      ...target,
      ...(storedTargets.find((item) => item?.id === target.id) || {}),
    }));

    return {
      ...defaults,
      ...stored,
      targets,
    };
  } catch {
    return createDefaultNotificationConfig();
  }
}

export function saveNotificationConfig(config) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function buildIntegrationSnippet(target = {}) {
  const targetName = target.name || 'OpenClaw / Hermes';
  const envName = `${String(target.id || target.type || 'ai').toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SECRET`;
  const sampleSecret = target.secret || 'change-this-secret-or-leave-empty';

  return `// Bambu Monitor -> ${targetName} webhook connector
// 保存为: bambu-monitor-webhook.cjs
// 运行: node bambu-monitor-webhook.cjs
// 然后在 Bambu Monitor 里填写: http://你的电脑IP:8787/bambu-monitor/webhook
// 如果填写了 HMAC Secret，请让这里的 ${envName} 和 Bambu Monitor 里的 Secret 一致。
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.${envName} || '${sampleSecret}';

if (!HMAC_SECRET || HMAC_SECRET === 'change-this-secret-or-leave-empty') {
  console.warn('[Bambu Monitor] 未设置 HMAC Secret，任何能访问该端口的程序都可以伪造通知；仅建议在受信任的局域网内临时使用。');
}

function verifySignature(rawBody, signatureHeader) {
  if (!HMAC_SECRET || HMAC_SECRET === 'change-this-secret-or-leave-empty') return true;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(rawBody)
    .digest('hex');

  const actual = String(signatureHeader || '');
  try {
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function notifyAI(payload) {
  // 这里交给 ${targetName} 那边的 AI 替换成它自己的通知动作。
  // payload.event: print_finished / printer_issue / printer_disconnected / printer_recovered
  // payload.message: 已经整理好的中文通知文案
  console.log('[Bambu Monitor]', payload.message);
  console.log(JSON.stringify(payload, null, 2));
}

const server = http.createServer((req, res) => {
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

    try {
      const payload = JSON.parse(rawBody);
      await notifyAI(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(\`Bambu Monitor webhook listening on http://\${HOST}:\${PORT}/bambu-monitor/webhook\`);
});
`;
}

function normalizeNotificationState(value) {
  if (!value) return null;
  const printer = typeof value === 'string' ? { status: value } : value;
  return {
    jobStatus: getPrinterJobStatus(printer) || printer.status || '',
    connectionState: getPrinterConnectionState(printer),
  };
}

export function getPrinterNotificationEvent(previousValue, currentValue) {
  const previous = normalizeNotificationState(previousValue);
  const current = normalizeNotificationState(currentValue);
  if (!previous || !current) return null;

  if (previous.jobStatus !== 'finished' && current.jobStatus === 'finished') {
    return 'print_finished';
  }

  if (previous.connectionState !== 'offline' && current.connectionState === 'offline') {
    return 'printer_disconnected';
  }

  if (
    current.connectionState === 'error'
    || (previous.jobStatus !== 'error' && current.jobStatus === 'error')
  ) {
    return 'printer_issue';
  }

  if (
    ['offline', 'error'].includes(previous.connectionState)
    && current.connectionState === 'online'
  ) {
    return 'printer_recovered';
  }

  return null;
}

export function getPrinterNotificationName(printer = {}) {
  return String(printer.baseName || printer.name || '').trim() || '未命名打印机';
}

function buildPrinterSnapshot(printer) {
  return {
    id: printer.dev_id,
    cloudId: printer.cloudId,
    name: getPrinterNotificationName(printer),
    ip: printer.ip || '',
    status: printer.status || '',
    progress: Math.max(0, Math.min(Number(printer.progress) || 0, 100)),
    timeLeft: printer.timeLeft || '--',
    filename: printer.filename || '',
    layer: printer.layer || '',
    speed: printer.speed ?? '',
    temperature: printer.temperature || {},
    errorMsg: printer.errorMsg || '',
  };
}

function buildPayload(eventType, printer, options = {}) {
  const copy = EVENT_COPY[eventType] || {
    severity: 'info',
    title: '打印机状态更新',
    action: '状态更新',
  };
  const snapshot = buildPrinterSnapshot(printer);

  return {
    source: 'bambu-monitor',
    event: eventType,
    severity: copy.severity,
    title: copy.title,
    message: `${snapshot.name} ${copy.action}`,
    occurredAt: new Date().toISOString(),
    previousStatus: options.previousStatus || '',
    printer: snapshot,
  };
}

function shouldSkipCooldown(eventType, printerId, cooldownMs) {
  const key = `${eventType}:${printerId}`;
  const now = Date.now();
  const lastSentAt = recentEvents.get(key) || 0;

  if (now - lastSentAt < cooldownMs) {
    return true;
  }

  recentEvents.set(key, now);
  return false;
}

export async function dispatchPrinterNotification(eventType, printer, options = {}) {
  if (!isElectronEnvironment()) return { skipped: true, reason: 'not-electron' };

  const config = getNotificationConfig();
  if (!config.enabled) return { skipped: true, reason: 'disabled' };

  const targets = (config.targets || [])
    .filter((target) => target?.enabled && target.url)
    .map((target) => ({
      id: target.id,
      name: target.name,
      type: target.type,
      url: target.url,
      secret: target.secret,
      token: target.token,
      headers: target.headers,
    }));

  if (targets.length === 0) return { skipped: true, reason: 'no-targets' };

  const cooldownMs = Number(config.cooldownMs) || DEFAULT_COOLDOWN_MS;
  if (shouldSkipCooldown(eventType, printer.dev_id, cooldownMs)) {
    return { skipped: true, reason: 'cooldown' };
  }

  const payload = buildPayload(eventType, printer, options);
  return electronNotifications.send({ targets, payload });
}

export async function sendTestNotification(target, runtime) {
  if (runtime?.kind === 'web') return runtime.notifications.send();
  const notificationRuntime = runtime?.notifications || electronNotifications;
  if (!runtime && !isElectronEnvironment()) return { skipped: true, reason: 'not-electron' };
  if (!target?.url) throw new Error('请先填写 Webhook URL');

  return notificationRuntime.send({
    targets: [{
      id: target.id,
      name: target.name,
      type: target.type,
      url: target.url,
      secret: target.secret,
      token: target.token,
      headers: target.headers,
    }],
    payload: buildPayload('print_finished', {
      dev_id: 'TEST_PRINTER',
      name: 'A1 mini',
      ip: '192.168.1.100',
      status: 'finished',
      progress: 100,
      timeLeft: '--',
      filename: 'test_print.3mf',
      layer: '188/188',
      speed: 100,
      temperature: { nozzle: 218, bed: 58 },
      errorMsg: '',
    }, { previousStatus: 'printing' }),
  });
}

export function getTestNotificationError(result, { web = false } = {}) {
  if (web && (result?.success !== true || result?.sent !== true)) {
    const error = typeof result?.error === 'string' ? result.error.trim().slice(0, 256) : '';
    return error || '通知未发送';
  }
  const failed = result?.results?.find((item) => item?.success === false);
  if (!failed) return '';
  return String(failed.error || failed.status || '未知错误').slice(0, 256);
}
