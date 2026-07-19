import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 4096;

export function checkHealth({
  port,
  host = '127.0.0.1',
  timeoutMs = 2000,
  requestImpl = http.request,
  timers: timerOverrides = {},
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new TypeError('Invalid healthcheck port'));
  }
  if (typeof host !== 'string' || host.length === 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0
    || typeof requestImpl !== 'function') {
    return Promise.reject(new TypeError('Invalid healthcheck options'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    let wallTimer;
    const timers = {
      setTimeout: timerOverrides.setTimeout?.bind(timerOverrides) ?? setTimeout,
      clearTimeout: timerOverrides.clearTimeout?.bind(timerOverrides) ?? clearTimeout,
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(wallTimer);
      response?.destroy?.();
      if (error) reject(error);
      else resolve(value);
    };
    const expire = () => {
      const error = new Error('Healthcheck timed out');
      request?.destroy?.(error);
      response?.destroy?.(error);
      finish(error);
    };

    wallTimer = timers.setTimeout(expire, timeoutMs);
    try {
      request = requestImpl({
        host,
        port,
        path: '/healthz',
        method: 'GET',
        agent: false,
        headers: { Connection: 'close', Accept: 'application/json' },
      }, (incoming) => {
        response = incoming;
        const chunks = [];
        let bytes = 0;
        incoming.on('data', (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy();
            finish(new Error('Healthcheck response is too large'));
            return;
          }
          chunks.push(buffer);
        });
        incoming.once('error', (error) => finish(error));
        incoming.once('end', () => {
          if (settled) return;
          if (incoming.statusCode !== 200) {
            finish(new Error(`Healthcheck returned status ${incoming.statusCode ?? 'unknown'}`));
            return;
          }
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!payload || payload.status !== 'ok') throw new Error('unexpected payload');
            finish(null, true);
          } catch {
            finish(new Error('Healthcheck returned an invalid payload'));
          }
        });
      });
      request.once('error', (error) => finish(error));
      request.setTimeout?.(timeoutMs, expire);
      request.end();
    } catch (error) {
      request?.destroy?.();
      finish(error);
    }
  });
}

async function main() {
  const port = Number(process.env.PORT || 3080);
  try {
    await checkHealth({ port });
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) void main();
