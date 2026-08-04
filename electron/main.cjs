const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { safeStorage } = require('electron');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const { installSafeConsole } = require('./safe-console.cjs');
const { enforceSingleInstance } = require('./single-instance.cjs');
const { connectMqttForRenderer } = require('./mqtt-ipc-result.cjs');
const {
  clearAuthSession,
  readAuthSession,
  writeAuthSession,
} = require('./auth-session.cjs');
const { buildMqttConnectionOptions } = require('./mqtt-options.cjs');
const { createBambuCloudClient } = require('../core/bambu-cloud.cjs');
const { scanBambuPrinters } = require('../core/lan-discovery.cjs');
const { createMqttConnectionManager } = require('../core/mqtt-connection-manager.cjs');
const {
  clampWindowSize,
  createWindowBoundsCloseHandshake,
  getMainWindowOptions,
  withCurrentWindowSize,
} = require('./window-bounds.cjs');
const {
  ChamberImageStream,
  buildBambuRtspUrl,
  isChamberImageCamera,
} = require('./camera-stream.cjs');

installSafeConsole();
const bambuCloud = createBambuCloudClient({ logger: console });

function getAuthSessionProtection() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return {
      protect: (value) => safeStorage.encryptString(value),
      unprotect: (value) => safeStorage.decryptString(value),
    };
  } catch {
    return null;
  }
}

let mainWindow;
let tray = null;
let isMouseLocked = false;
let isAlwaysOnTop = true;
let isAppQuitRequested = false;
let windowOpacity = 1;
let windowBoundsTimer = null;
let pendingWindowBounds = null;
let windowBoundsLifecycleCleanup = null;
const OPACITY_PRESETS = [1, 0.95, 0.9, 0.85, 0.8];

const cameraSources = new Map();
const cameraProcesses = new Set();
const chamberStreams = new Map();
let cameraServer = null;
let cameraServerPort = 0;
let cameraServerPromise = null;
const MQTT_RECONNECT_GRACE_MS = 45000;
const MQTT_RENDERER_CHANNELS = Object.freeze({
  connected: 'mqtt-connected',
  message: 'mqtt-data',
  reconnecting: 'mqtt-reconnecting',
  disconnected: 'mqtt-disconnected',
});
const mqttConnectionManager = createMqttConnectionManager({
  connectImpl: mqtt.connect,
  buildConnectionOptions: buildMqttConnectionOptions,
  emit(event, payload) {
    const channel = MQTT_RENDERER_CHANNELS[event];
    if (channel) sendRendererEvent(channel, payload);
  },
  logger: console,
  reconnectGraceMs: MQTT_RECONNECT_GRACE_MS,
});
const ownsSingleInstanceLock = enforceSingleInstance(app, () => {
  bringWindowToFront();
  updateTrayMenu();
});

function sendRendererEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function clearWindowBoundsTimer() {
  if (!windowBoundsTimer) return;
  clearTimeout(windowBoundsTimer);
  windowBoundsTimer = null;
}

function clearWindowBoundsState() {
  clearWindowBoundsTimer();
  pendingWindowBounds = null;
}

function clearWindowBoundsLifecycle() {
  const cleanup = windowBoundsLifecycleCleanup;
  windowBoundsLifecycleCleanup = null;
  if (cleanup) cleanup();
}

function getWindowContentBounds(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    const [width, height] = win.getContentSize();
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

function sendWindowBoundsChanged(win, bounds) {
  if (!bounds || !win || win.isDestroyed()) return false;
  try {
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed()) return false;
    webContents.send('window-bounds-changed', bounds);
    return true;
  } catch {
    return false;
  }
}

function scheduleWindowBoundsChanged(win) {
  const bounds = getWindowContentBounds(win);
  if (!bounds) return;

  pendingWindowBounds = bounds;
  clearWindowBoundsTimer();
  windowBoundsTimer = setTimeout(() => {
    windowBoundsTimer = null;
    const boundsToSend = pendingWindowBounds;
    pendingWindowBounds = null;
    sendWindowBoundsChanged(win, boundsToSend);
  }, 120);
}

function buildNotificationHeaders(target, body) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'BambuMonitor/1.0',
    'x-bambu-monitor-provider': String(target.type || target.id || 'webhook'),
  };

  if (target.secret) {
    const signature = crypto
      .createHmac('sha256', String(target.secret))
      .update(body)
      .digest('hex');

    headers['x-bambu-monitor-signature'] = `sha256=${signature}`;
    headers['x-hub-signature-256'] = `sha256=${signature}`;
    headers[`x-${String(target.type || 'webhook').toLowerCase()}-signature`] = `sha256=${signature}`;
  }

  if (target.token) {
    headers.authorization = `Bearer ${target.token}`;
  }

  if (target.headers && typeof target.headers === 'object') {
    for (const [key, value] of Object.entries(target.headers)) {
      if (key && value !== undefined && value !== null) {
        headers[String(key).toLowerCase()] = String(value);
      }
    }
  }

  return headers;
}

function assertValidWebhookUrl(url) {
  const parsed = new URL(String(url || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Webhook URL must use http or https');
  }
  return parsed.toString();
}

function getLoginItemOptions(openAtLogin) {
  if (app.isPackaged) {
    return { openAtLogin };
  }

  return {
    openAtLogin,
    path: process.execPath,
    args: [app.getAppPath()],
  };
}

function getStartupEnabled() {
  try {
    return Boolean(app.getLoginItemSettings(getLoginItemOptions(true)).openAtLogin);
  } catch (err) {
    console.warn('Unable to read startup setting:', err.message);
    return false;
  }
}

function setStartupEnabled(enabled) {
  app.setLoginItemSettings(getLoginItemOptions(Boolean(enabled)));
  return getStartupEnabled();
}

function stopCameraProcesses() {
  for (const child of cameraProcesses) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore already-stopped ffmpeg processes.
    }
  }
  cameraProcesses.clear();
}

function stopChamberStream(id) {
  const entry = chamberStreams.get(id);
  if (!entry) return;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  try {
    entry.stream.stop();
  } catch {
    // Ignore cleanup races.
  }
  chamberStreams.delete(id);
}

function stopChamberStreams() {
  for (const id of Array.from(chamberStreams.keys())) {
    stopChamberStream(id);
  }
}

function retainChamberStream(entry) {
  entry.clients += 1;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
}

function releaseChamberStream(source, entry) {
  entry.clients -= 1;
  if (entry.clients <= 0 && !entry.graceTimer) {
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      if (entry.clients <= 0 && chamberStreams.get(source.id) === entry) {
        stopChamberStream(source.id);
      }
    }, 20000);
  }
}

function getChamberStream(source) {
  const key = `${source.id}|${source.ip}|${source.accessCode}`;
  let entry = chamberStreams.get(source.id);

  if (entry && entry.key !== key) {
    stopChamberStream(source.id);
    entry = null;
  }

  if (!entry) {
    const stream = new ChamberImageStream({
      host: source.ip,
      accessCode: source.accessCode,
    });
    stream.on('error', (error) => {
      console.warn(`[Camera ${source.id}] chamber-image error: ${error?.message || error}`);
    });
    stream.on('warn', (warning) => {
      console.warn(`[Camera ${source.id}] chamber-image warning: ${warning}`);
    });
    stream.start();
    entry = { key, stream, clients: 0, graceTimer: null };
    chamberStreams.set(source.id, entry);
  }

  return entry;
}

function writeMjpegFrame(res, boundary, jpeg) {
  res.write(`--${boundary}\r\n`);
  res.write('Content-Type: image/jpeg\r\n');
  res.write(`Content-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write('\r\n');
}

function handleChamberImageRequest(source, req, res) {
  if (!source.ip || !source.accessCode) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing printer IP or access code');
    return;
  }

  const boundary = 'bambuframe';
  const entry = getChamberStream(source);
  retainChamberStream(entry);

  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'cache-control': 'no-store, no-cache, must-revalidate, private',
    pragma: 'no-cache',
    connection: 'close',
    'access-control-allow-origin': '*',
  });

  const onFrame = (jpeg) => {
    // Drop frames for slow clients instead of buffering them without bound.
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) writeMjpegFrame(res, boundary, jpeg);
  };

  if (entry.stream.lastFrame) onFrame(entry.stream.lastFrame);
  entry.stream.on('frame', onFrame);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    entry.stream.removeListener('frame', onFrame);
    releaseChamberStream(source, entry);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
}

function handleChamberFrameRequest(source, _req, res) {
  if (!source.ip || !source.accessCode) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing printer IP or access code');
    return;
  }

  const entry = getChamberStream(source);
  // Snapshot polling keeps the shared stream retained; the grace timer after the
  // last release is what finally frees the printer's single chamber-image slot.
  retainChamberStream(entry);
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseChamberStream(source, entry);
  };
  res.on('close', releaseOnce);

  const sendFrame = (jpeg) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': jpeg.length,
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      'access-control-allow-origin': '*',
    });
    res.end(jpeg);
  };

  if (entry.stream.lastFrame) {
    sendFrame(entry.stream.lastFrame);
    return;
  }

  const cleanup = () => {
    clearTimeout(timeout);
    entry.stream.removeListener('frame', onFrame);
  };
  const onFrame = (jpeg) => {
    cleanup();
    sendFrame(jpeg);
  };
  const timeout = setTimeout(() => {
    cleanup();
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('timed out waiting for camera frame');
    }
  }, 4000);

  entry.stream.once('frame', onFrame);
  res.on('close', cleanup);
}

function handleRtspCameraRequest(source, req, res) {
  if (!source?.url) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('camera source not registered');
    return;
  }


  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-rtsp_transport', 'tcp',
    '-i', source.url,
    '-an',
    '-vf', 'fps=4,scale=640:-1',
    '-q:v', '6',
    '-f', 'mpjpeg',
    '-boundary_tag', 'ffmpeg',
    'pipe:1',
  ];

  let responded = false;
  const child = spawn('ffmpeg', args, { windowsHide: true });
  cameraProcesses.add(child);

  const cleanup = () => {
    if (cameraProcesses.has(child)) cameraProcesses.delete(child);
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore process cleanup races.
    }
  };

  child.on('error', (err) => {
    cleanup();
    if (!responded) {
      responded = true;
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err.code === 'ENOENT' ? 'ffmpeg is not installed or not in PATH' : err.message);
    }
  });

  child.stderr.on('data', (chunk) => {
    console.warn(`[Camera ${source.id}] ${chunk.toString().trim()}`);
  });

  child.stdout.once('data', (chunk) => {
    if (res.destroyed) {
      cleanup();
      return;
    }

    responded = true;
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace;boundary=ffmpeg',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
      connection: 'close',
      'access-control-allow-origin': '*',
    });
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on('close', () => {
    cameraProcesses.delete(child);
    if (!responded && !res.destroyed) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('camera stream closed before video data was received');
      return;
    }
    if (!res.destroyed) res.end();
  });

  req.on('close', cleanup);
  res.on('close', cleanup);
}

function handleCameraRequest(req, res) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const parts = requestUrl.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && requestUrl.pathname === '/camera-debug') {
    const now = Date.now();
    const sources = Array.from(cameraSources.values()).map((source) => {
      const entry = chamberStreams.get(source.id);
      const stream = entry?.stream;
      return {
        id: source.id,
        name: source.name,
        ip: source.ip,
        mode: source.mode || 'rtsps',
        hasFrame: Boolean(stream?.lastFrame),
        frameCount: stream?.frameCount || 0,
        lastFrameAgeMs: stream?.lastFrameAt ? now - stream.lastFrameAt : null,
        clients: entry?.clients || 0,
      };
    });

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ sources }, null, 2));
    return;
  }

  if (req.method !== 'GET' || parts[0] !== 'camera' || !parts[1]) {
    if (req.method === 'GET' && parts[0] === 'camera-frame' && parts[1]) {
      const frameSource = cameraSources.get(decodeURIComponent(parts[1]));
      if (!frameSource) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('camera source not registered');
        return;
      }
      if (frameSource.mode !== 'chamber-image') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('snapshot frames are only available for chamber-image cameras');
        return;
      }
      handleChamberFrameRequest(frameSource, req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const source = cameraSources.get(decodeURIComponent(parts[1]));
  if (!source) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('camera source not registered');
    return;
  }

  if (source.mode === 'chamber-image') {
    handleChamberImageRequest(source, req, res);
    return;
  }

  handleRtspCameraRequest(source, req, res);
}

async function ensureCameraServer() {
  if (cameraServer && cameraServerPort) return cameraServerPort;
  if (cameraServerPromise) return cameraServerPromise;

  const server = http.createServer(handleCameraRequest);
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  cameraServer = server;

  cameraServerPromise = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      cameraServerPort = Number(address?.port || 0);
      server.off('error', reject);
      server.on('error', (err) => {
        console.warn(`[Camera] local camera server error: ${err?.message || err}`);
      });
      resolve(cameraServerPort);
    });
  });

  try {
    return await cameraServerPromise;
  } catch (err) {
    if (cameraServer === server) {
      cameraServer = null;
      cameraServerPort = 0;
    }
    throw err;
  } finally {
    cameraServerPromise = null;
  }
}

function closeCameraServer() {
  stopCameraProcesses();
  stopChamberStreams();
  cameraSources.clear();

  if (cameraServer) {
    try {
      cameraServer.close();
    } catch {
      // Ignore shutdown races.
    }
  }

  cameraServer = null;
  cameraServerPort = 0;
}

function getIconPath() {
  const isDev = !app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '../public/tray-icon.png');
  }
  return path.join(__dirname, '../dist/tray-icon.png');
}

function updateTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? '隐藏窗口' : '显示窗口',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          bringWindowToFront();
        }
      },
    },
    {
      label: isAlwaysOnTop ? '取消置顶' : '窗口置顶',
      click: () => {
        setAlwaysOnTop(!isAlwaysOnTop);
      },
    },
    {
      label: isMouseLocked ? '解除锁定' : '锁定点击',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        setMouseLock(!isMouseLocked);
      },
    },
    {
      label: '透明度',
      submenu: OPACITY_PRESETS.map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio',
        checked: Math.abs(windowOpacity - value) < 0.001,
        click: () => {
          setWindowOpacity(value);
        },
      })),
    },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: getStartupEnabled(),
      click: (menuItem) => {
        setStartupEnabled(menuItem.checked);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

function setWindowOpacity(opacity) {
  const nextOpacity = Number(opacity);
  if (!Number.isFinite(nextOpacity)) return;
  windowOpacity = Math.min(1, Math.max(0.5, nextOpacity));
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setOpacity(windowOpacity);
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window-opacity-changed', windowOpacity);
    }
  }
  updateTrayMenu();
}

function bringWindowToFront({ focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (isAlwaysOnTop) {
    try {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
    } catch {
      mainWindow.setAlwaysOnTop(true);
    }
  }

  try {
    mainWindow.moveTop();
  } catch {
    // Some platforms do not expose moveTop for every window state.
  }

  if (focus) {
    try {
      mainWindow.focus();
    } catch {
      // Ignore OS focus-stealing prevention.
    }
  }
}

function setAlwaysOnTop(flag) {
  isAlwaysOnTop = !!flag;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setAlwaysOnTop(isAlwaysOnTop, process.platform === 'win32' ? 'screen-saver' : 'floating');
    } catch {
      mainWindow.setAlwaysOnTop(isAlwaysOnTop);
    }
    if (isAlwaysOnTop) {
      bringWindowToFront();
    }
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('always-on-top-changed', isAlwaysOnTop);
    }
  }
  updateTrayMenu();
}

function setMouseLock(lockFlag) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextLocked = !!lockFlag;
  isMouseLocked = nextLocked;
  mainWindow.setIgnoreMouseEvents(nextLocked, nextLocked ? { forward: true } : undefined);
  if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('lock-status-changed', nextLocked);
  }
  updateTrayMenu();
}

function createWindow() {
  isAppQuitRequested = false;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const isDev = !app.isPackaged;

  mainWindow = new BrowserWindow({
    ...getMainWindowOptions({
      width: 400,
      height: 580,
      x: Math.round(width / 2 - 200),
      y: Math.round(height / 2 - 290),
    }),
    alwaysOnTop: isAlwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: isDev,
    },
  });

  const startUrl = process.env.ELECTRON_START_URL || (!app.isPackaged
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '../dist/index.html')}`);

  mainWindow.loadURL(startUrl);
  setWindowOpacity(windowOpacity);
  setAlwaysOnTop(isAlwaysOnTop);

  if (mainWindow.removeMenu) {
    mainWindow.removeMenu();
  }

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toUpperCase();
      const ctrlOrCmd = input.control || input.meta;
      const blocked = key === 'F12'
        || (ctrlOrCmd && input.shift && ['I', 'J', 'C'].includes(key))
        || (ctrlOrCmd && key === 'R');

      if (blocked) {
        event.preventDefault();
      }
    });
  }

  mainWindow.webContents.on('did-finish-load', () => {
    setMouseLock(false);
  });

  clearWindowBoundsLifecycle();
  const windowForBoundsEvents = mainWindow;
  const boundsWebContents = windowForBoundsEvents.webContents;
  const closeHandshake = createWindowBoundsCloseHandshake({
    requestIdFactory: () => crypto.randomUUID(),
    sendRequest: (sender, payload) => {
      if (sender !== boundsWebContents || sender.isDestroyed()) return;
      sender.send('window-bounds-save-request', payload);
    },
    continueClose: () => {
      if (isAppQuitRequested) {
        app.quit();
        return;
      }
      if (!windowForBoundsEvents.isDestroyed()) {
        windowForBoundsEvents.close();
      }
    },
    timeoutMs: 300,
  });
  const handleWindowResize = () => {
    if (closeHandshake.isWaiting() || closeHandshake.shouldAllowClose()) return;
    scheduleWindowBoundsChanged(windowForBoundsEvents);
  };
  const handleWindowClose = (event) => {
    if (closeHandshake.shouldAllowClose()) return;
    if (closeHandshake.isWaiting()) {
      event.preventDefault();
      return;
    }

    const finalBounds = getWindowContentBounds(windowForBoundsEvents) || pendingWindowBounds;
    if (!finalBounds || boundsWebContents.isDestroyed()) {
      clearWindowBoundsState();
      return;
    }

    event.preventDefault();
    clearWindowBoundsState();
    closeHandshake.begin(boundsWebContents, finalBounds);
  };
  const handleWindowBoundsSaveAck = (event, payload) => {
    if (event.sender !== boundsWebContents || boundsWebContents.isDestroyed()) return;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (typeof payload.requestId !== 'string') return;
    closeHandshake.acknowledge(event.sender, payload.requestId);
  };
  let lifecycleDisposed = false;
  const cleanupWindowBoundsLifecycle = () => {
    if (lifecycleDisposed) return;
    lifecycleDisposed = true;
    windowForBoundsEvents.removeListener('resize', handleWindowResize);
    windowForBoundsEvents.removeListener('close', handleWindowClose);
    ipcMain.removeListener('window-bounds-save-ack', handleWindowBoundsSaveAck);
    closeHandshake.dispose();
    clearWindowBoundsState();
  };
  windowBoundsLifecycleCleanup = cleanupWindowBoundsLifecycle;
  ipcMain.on('window-bounds-save-ack', handleWindowBoundsSaveAck);
  mainWindow.on('resize', handleWindowResize);
  mainWindow.on('close', handleWindowClose);

  mainWindow.once('closed', () => {
    if (windowBoundsLifecycleCleanup === cleanupWindowBoundsLifecycle) {
      clearWindowBoundsLifecycle();
    } else {
      cleanupWindowBoundsLifecycle();
    }
    if (mainWindow === windowForBoundsEvents) {
      mainWindow = null;
    }
  });

  if (!tray) {
    const iconPath = getIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('打印机监控');
    updateTrayMenu();

    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        bringWindowToFront();
      }
      updateTrayMenu();
    });
  }
}

app.on('ready', () => {
  if (!ownsSingleInstanceLock) return;
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    setMouseLock(!isMouseLocked);
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('toggle-layout');
    }
  });
});

app.on('before-quit', () => {
  isAppQuitRequested = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  clearWindowBoundsLifecycle();
  clearWindowBoundsState();
  isAppQuitRequested = false;
  globalShortcut.unregisterAll();
  void mqttConnectionManager.shutdown();
  closeCameraServer();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

ipcMain.on('set-ignore-mouse-events', (_event, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setMouseLock(!!ignore);
});

ipcMain.on('toggle-always-on-top', (_event, flag) => {
  setAlwaysOnTop(flag);
});

ipcMain.on('set-window-opacity', (_event, opacity) => {
  setWindowOpacity(opacity);
});

ipcMain.on('resize-me', (event, bounds) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  try {
    const currentSize = win.getContentSize();
    const display = screen.getDisplayMatching(win.getBounds());
    const workArea = display?.workAreaSize || screen.getPrimaryDisplay().workAreaSize;
    const resizeBounds = withCurrentWindowSize(bounds, currentSize);
    const { width, height, minWidth, minHeight } = clampWindowSize(resizeBounds, workArea);

    win.setMinimumSize(minWidth, minHeight);
    win.setContentSize(width, height, true);
  } catch (error) {
    console.warn('Unable to apply window bounds:', error?.message || error);
    return;
  }
  if (isAlwaysOnTop) {
    bringWindowToFront({ focus: false });
  }
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-close', () => {
  app.quit();
});

ipcMain.on('app-quit', () => {
  app.quit();
});

ipcMain.handle('startup-get', async () => ({
  success: true,
  enabled: getStartupEnabled(),
}));

ipcMain.handle('startup-set', async (_event, { enabled }) => {
  try {
    return {
      success: true,
      enabled: setStartupEnabled(enabled),
    };
  } catch (err) {
    return { success: false, error: err.message || '设置开机启动失败' };
  }
});

ipcMain.handle('camera-start', async (_event, payload = {}) => {
  try {
    const id = String(payload.serialNumber || payload.cloudId || payload.id || payload.ip || '').trim();
    const mode = isChamberImageCamera(payload) ? 'chamber-image' : 'rtsps';
    const streamUrl = mode === 'rtsps' ? buildBambuRtspUrl(payload) : '';

    if (!id || !payload.ip || !payload.accessCode || (mode === 'rtsps' && !streamUrl)) {
      return { success: false, error: '缺少打印机 IP 或访问码，无法打开摄像头' };
    }

    const port = await ensureCameraServer();
    cameraSources.set(id, {
      id,
      name: payload.name || id,
      model: payload.model || '',
      modelCode: payload.modelCode || '',
      ip: payload.ip,
      accessCode: payload.accessCode,
      mode,
      url: streamUrl,
    });

    return {
      success: true,
      url: `http://127.0.0.1:${port}/camera/${encodeURIComponent(id)}?v=${Date.now()}`,
      snapshotUrl: mode === 'chamber-image'
        ? `http://127.0.0.1:${port}/camera-frame/${encodeURIComponent(id)}?v=${Date.now()}`
        : '',
      mode: mode === 'chamber-image' ? 'chamber-image-mjpeg' : 'rtsps-mjpeg',
    };
  } catch (err) {
    return { success: false, error: err.message || '打开摄像头失败' };
  }
});

ipcMain.handle('camera-stop', async (_event, { serialNumber, id } = {}) => {
  const key = String(serialNumber || id || '').trim();
  if (key) {
    cameraSources.delete(key);
    stopChamberStream(key);
  }
  return { success: true };
});

ipcMain.handle('camera-stop-all', async () => {
  cameraSources.clear();
  stopCameraProcesses();
  stopChamberStreams();
  return { success: true };
});

ipcMain.handle('scan-printers', async () => {
  try {
    return await scanBambuPrinters({ logger: console });
  } catch (err) {
    throw new Error(err.message || '扫描打印机失败');
  }
});

ipcMain.handle('cloud-login', async (_event, credentials) => (
  bambuCloud.loginPassword(credentials)
));

ipcMain.handle('auth-session-get', async () => ({
  success: true,
  session: readAuthSession(app.getPath('userData'), getAuthSessionProtection()),
}));

ipcMain.handle('auth-session-set', async (_event, session) => {
  try {
    return {
      success: true,
      session: writeAuthSession(app.getPath('userData'), session, getAuthSessionProtection()),
    };
  } catch (err) {
    return { success: false, error: err.message || '保存登录状态失败' };
  }
});

ipcMain.handle('auth-session-clear', async () => {
  try {
    clearAuthSession(app.getPath('userData'));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || '清除登录状态失败' };
  }
});

ipcMain.handle('request-verify-code', async (_event, payload) => (
  bambuCloud.requestVerifyCode(payload)
));

ipcMain.handle('cloud-login-code', async (_event, payload) => (
  bambuCloud.loginCode(payload)
));

ipcMain.handle('get-device-list', async (_event, { accessToken }) => {
  try {
    return await bambuCloud.listDevices(accessToken);
  } catch (err) {
    return {
      success: false,
      error: err.message,
      status: err.status,
      tokenInvalid: Boolean(err.tokenInvalid),
    };
  }
});

ipcMain.handle('notification-send', async (_event, { targets = [], payload }) => {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { success: false, error: 'No notification targets configured', results: [] };
  }

  const body = JSON.stringify(payload || {});
  const results = [];

  for (const target of targets) {
    const result = {
      id: target?.id || target?.name || 'webhook',
      name: target?.name || target?.id || 'Webhook',
      success: false,
    };

    try {
      const url = assertValidWebhookUrl(target?.url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: buildNotificationHeaders(target || {}, body),
          body,
          signal: controller.signal,
        });

        result.status = response.status;
        result.success = response.ok;
        if (!response.ok) {
          result.error = await response.text().catch(() => response.statusText);
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      result.error = err?.message || 'Notification failed';
    }

    results.push(result);
  }

  return {
    success: results.some((result) => result.success),
    results,
  };
});

ipcMain.handle('mqtt-connect', async (_event, payload = {}) => {
  return connectMqttForRenderer(mqttConnectionManager, payload, console);
});

ipcMain.handle('mqtt-disconnect', async (_event, { serialNumber } = {}) => {
  return mqttConnectionManager.disconnect(serialNumber);
});

ipcMain.handle('mqtt-disconnect-all', async () => {
  return mqttConnectionManager.shutdown();
});
