const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const { installSafeConsole } = require('./safe-console.cjs');
const { buildMqttConnectionOptions, extractBambuUsername } = require('./mqtt-options.cjs');
const {
  ChamberImageStream,
  buildBambuRtspUrl,
  isChamberImageCamera,
} = require('./camera-stream.cjs');

installSafeConsole();

let mainWindow;
let tray = null;
let isMouseLocked = false;
let isAlwaysOnTop = true;
let windowOpacity = 1;
const OPACITY_PRESETS = [1, 0.95, 0.9, 0.85, 0.8];

const mqttConnections = new Map();
const cameraSources = new Map();
const cameraProcesses = new Set();
const chamberStreams = new Map();
let cameraServer = null;
let cameraServerPort = 0;
const MQTT_RECONNECT_PERIOD_MS = 5000;
const MQTT_RECONNECT_GRACE_MS = 45000;

function sendRendererEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function clearMqttDisconnectTimer(entry) {
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
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

function safelyCloseSocket(socket) {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // Ignore cleanup failures for already-closed sockets.
  }
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

function stopChamberStreams() {
  for (const entry of chamberStreams.values()) {
    try {
      entry.stream.stop();
    } catch {
      // Ignore cleanup races.
    }
  }
  chamberStreams.clear();
}

function getChamberStream(source) {
  const key = `${source.id}|${source.ip}|${source.accessCode}`;
  let entry = chamberStreams.get(source.id);

  if (entry && entry.key !== key) {
    try {
      entry.stream.stop();
    } catch {
      // Ignore cleanup races.
    }
    chamberStreams.delete(source.id);
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
  entry.clients += 1;
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }

  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'cache-control': 'no-store, no-cache, must-revalidate, private',
    pragma: 'no-cache',
    connection: 'close',
    'access-control-allow-origin': '*',
  });

  const onFrame = (jpeg) => {
    if (!res.destroyed && !res.writableEnded) writeMjpegFrame(res, boundary, jpeg);
  };

  if (entry.stream.lastFrame) onFrame(entry.stream.lastFrame);
  entry.stream.on('frame', onFrame);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    entry.stream.removeListener('frame', onFrame);
    entry.clients -= 1;
    if (entry.clients <= 0 && !entry.graceTimer) {
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null;
        if (entry.clients <= 0) {
          try {
            entry.stream.stop();
          } catch {
            // Ignore cleanup races.
          }
          chamberStreams.delete(source.id);
        }
      }, 20000);
    }
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

  cameraServer = http.createServer(handleCameraRequest);
  cameraServer.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    cameraServer.once('error', reject);
    cameraServer.listen(0, '127.0.0.1', () => {
      const address = cameraServer.address();
      cameraServerPort = Number(address?.port || 0);
      cameraServer.off('error', reject);
      resolve(cameraServerPort);
    });
  });
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
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const isDev = !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 400,
    height: 580,
    x: Math.round(width / 2 - 200),
    y: Math.round(height / 2 - 290),
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: isAlwaysOnTop,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    useContentSize: true,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  safelyCloseSocket(global.listenSocket);
  safelyCloseSocket(global.searchSocket);
  global.listenSocket = null;
  global.searchSocket = null;
  for (const [, conn] of mqttConnections) {
    conn.intentional = true;
    clearMqttDisconnectTimer(conn);
    if (conn.client) {
      conn.client.end();
    }
  }
  mqttConnections.clear();
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
  if (!win) return;

  const currentSize = win.getContentSize();
  const display = screen.getDisplayMatching(win.getBounds());
  const workArea = display?.workAreaSize || screen.getPrimaryDisplay().workAreaSize;
  const minWidth = Math.max(96, Number(bounds.minWidth) || 1);
  const minHeight = Math.max(56, Number(bounds.minHeight) || 1);
  const maxWidth = Math.max(minWidth, workArea.width - 24);
  const maxHeight = Math.max(minHeight, workArea.height - 24);
  const newHeight = Math.min(maxHeight, Math.max(minHeight, Number(bounds.height) || currentSize[1]));
  const newWidth = Math.min(maxWidth, Math.max(minWidth, Number(bounds.width) || currentSize[0]));

  win.setContentSize(newWidth, newHeight, true);
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
  if (key) cameraSources.delete(key);
  return { success: true };
});

ipcMain.handle('camera-stop-all', async () => {
  cameraSources.clear();
  stopCameraProcesses();
  return { success: true };
});

ipcMain.handle('scan-printers', async () => {
  const dgram = require('dgram');
  const foundPrinters = new Map();

  safelyCloseSocket(global.listenSocket);
  safelyCloseSocket(global.searchSocket);

  try {
    const listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const searchSocket = dgram.createSocket('udp4');

    global.listenSocket = listenSocket;
    global.searchSocket = searchSocket;

    const parseMessage = (msg, rinfo) => {
      const message = msg.toString();

      if (
        message.includes('urn:bambulab-com:device:3dprinter')
        || message.includes('DevModel.bambu.com')
        || message.includes('DevName.bambu.com')
      ) {
        if (message.includes('M-SEARCH')) {
          return;
        }

        const printer = {
          ip: rinfo.address,
          name: 'Bambu Printer',
          model: 'Unknown',
          serial: '',
        };

        const usnLineMatch = message.match(/^USN:\s*([^\r\n]+)/im);
        if (usnLineMatch) {
          const usnValue = usnLineMatch[1].trim();
          const uuidMatch = usnValue.match(/uuid:([^:\s]+)(?:::|$)/i);
          const tokenMatch = usnValue.match(/^([A-Za-z0-9_-]+)/);
          printer.serial = (uuidMatch?.[1] || tokenMatch?.[1] || '').trim();
        }

        if (!printer.serial) {
          const serialFieldMatch = message.match(/(?:DevSerialNumber|SerialNumber)\.bambu\.com:\s*([^\r\n]+)/i);
          if (serialFieldMatch) {
            printer.serial = serialFieldMatch[1].trim();
          }
        }

        const modelMatch = message.match(/DevModel\.bambu\.com:\s*([^\r\n]+)/i);
        if (modelMatch) {
          const modelCode = modelMatch[1].trim();
          const modelMap = {
            C12: 'P1S',
            C11: 'P1P',
            '3DPrinter-X1-Carbon': 'X1 Carbon',
            '3DPrinter-X1': 'X1',
            N2S: 'A1',
            N1: 'A1 Mini',
            O1D: 'H2D',
            O1: 'H2',
            'BL-P001': 'P1P',
            'BL-P002': 'P1S',
            'BL-A001': 'A1',
          };
          printer.model = modelMap[modelCode] || modelCode;
        }

        const nameMatch = message.match(/DevName\.bambu\.com:\s*([^\r\n]+)/i);
        if (nameMatch) {
          printer.name = nameMatch[1].trim();
        }

        if (printer.serial || printer.ip) {
          foundPrinters.set(printer.ip, printer);
          console.log('Found Bambu printer:', printer);
        }
      }
    };

    listenSocket.on('message', parseMessage);
    searchSocket.on('message', parseMessage);

    listenSocket.on('error', (err) => {
      console.error('Listen socket error:', err);
    });

    searchSocket.on('error', (err) => {
      console.error('Search socket error:', err);
    });

    listenSocket.bind(2021, () => {
      console.log('Listening for Bambu printer broadcasts on port 2021');
    });

    searchSocket.bind(() => {
      searchSocket.setBroadcast(true);

      const bambuSearch = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n'
        + 'HOST: 239.255.255.250:1900\r\n'
        + 'MAN: "ssdp:discover"\r\n'
        + 'MX: 3\r\n'
        + 'ST: urn:bambulab-com:device:3dprinter:1\r\n'
        + '\r\n',
      );

      const genericSearch = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n'
        + 'HOST: 239.255.255.250:1900\r\n'
        + 'MAN: "ssdp:discover"\r\n'
        + 'MX: 3\r\n'
        + 'ST: ssdp:all\r\n'
        + '\r\n',
      );

      const targets = [
        { port: 1900, address: '239.255.255.250' },
        { port: 2021, address: '255.255.255.255' },
        { port: 1990, address: '255.255.255.255' },
      ];

      const sendSearchRequests = () => {
        targets.forEach((target) => {
          searchSocket.send(bambuSearch, 0, bambuSearch.length, target.port, target.address);
          searchSocket.send(genericSearch, 0, genericSearch.length, target.port, target.address);
        });
      };

      sendSearchRequests();
      console.log('Sent SSDP M-SEARCH requests (round 1)');

      setTimeout(() => {
        sendSearchRequests();
        console.log('Sent SSDP M-SEARCH requests (round 2)');
      }, 1500);

      setTimeout(() => {
        sendSearchRequests();
        console.log('Sent SSDP M-SEARCH requests (round 3)');
      }, 3000);

      setTimeout(() => {
        sendSearchRequests();
        console.log('Sent SSDP M-SEARCH requests (round 4)');
      }, 4500);
    });

    return await new Promise((resolve) => {
      setTimeout(() => {
        safelyCloseSocket(listenSocket);
        safelyCloseSocket(searchSocket);
        global.listenSocket = null;
        global.searchSocket = null;

        const results = Array.from(foundPrinters.values());
        console.log(`Scan complete. Found ${results.length} printer(s)`);
        resolve(results);
      }, 6000);
    });
  } catch (err) {
    console.error('Scan error:', err);
    throw new Error(err.message || '扫描打印机失败');
  }
});

const BAMBU_API = {
  LOGIN: 'https://api.bambulab.cn/v1/user-service/user/login',
  EMAIL_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendemail/code',
  SMS_CODE: 'https://api.bambulab.cn/v1/user-service/user/sendsmscode',
  BIND: 'https://api.bambulab.cn/v1/iot-service/api/user/bind',
  PREFERENCE: 'https://api.bambulab.cn/v1/design-user-service/my/preference',
};

function getBambuHeaders() {
  return {
    'User-Agent': 'bambu_network_agent/01.09.05.01',
    'X-BBL-Client-Name': 'OrcaSlicer',
    'X-BBL-Client-Type': 'slicer',
    'X-BBL-Client-Version': '01.09.05.51',
    'X-BBL-Language': 'zh-CN',
    'X-BBL-OS-Type': 'windows',
    'X-BBL-OS-Version': '10.0',
    'X-BBL-Agent-Version': '01.09.05.01',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function getBambuCloudUsername(accessToken) {
  const tokenUsername = extractBambuUsername(accessToken);
  if (tokenUsername) return tokenUsername;

  try {
    const response = await fetch(BAMBU_API.PREFERENCE, {
      method: 'GET',
      headers: {
        ...getBambuHeaders(),
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const data = await response.json();
    return data?.uid ? `u_${data.uid}` : '';
  } catch (err) {
    console.warn('Get Bambu username failed:', err.message);
    return '';
  }
}

function translateError(errorMsg) {
  if (!errorMsg) return '';

  const translations = {
    'Incorrect password': '密码错误',
    'incorrect password': '密码错误',
    'This account is not registered': '此账号未注册',
    'Account not found': '账号不存在',
    'Code does not exist or has expired': '验证码已过期或不存在',
    'Incorrect code': '验证码错误',
    'Invalid phone number': '手机号格式错误',
    'Enter a valid phone number': '请输入有效的手机号',
    'Network error': '网络错误',
    'Request failed': '请求失败',
  };

  if (translations[errorMsg]) {
    return translations[errorMsg];
  }

  for (const eng of Object.keys(translations)) {
    if (errorMsg.toLowerCase().includes(eng.toLowerCase())) {
      return translations[eng];
    }
  }

  return errorMsg;
}

ipcMain.handle('cloud-login', async (_event, { account, password }) => {
  try {
    const response = await fetch(BAMBU_API.LOGIN, {
      method: 'POST',
      headers: getBambuHeaders(),
      body: JSON.stringify({ account, password, apiError: '' }),
    });

    const data = await response.json();
    console.log('Login response:', JSON.stringify(data, null, 2));

    if (data.accessToken) {
      return { success: true, accessToken: data.accessToken };
    }

    if (data.loginType === 'verifyCode') {
      return { success: false, needVerifyCode: true, message: '需要验证码' };
    }

    if (data.loginType === 'tfa') {
      return { success: false, needTfa: true, tfaKey: data.tfaKey, message: '需要两步验证码' };
    }

    return { success: false, error: translateError(data.error) || '登录失败' };
  } catch (err) {
    console.error('Cloud login error:', err);
    return { success: false, error: translateError(err.message) };
  }
});

ipcMain.handle('request-verify-code', async (_event, { account }) => {
  try {
    account = account.toString().replace(/\s+/g, '');

    const isEmail = account.includes('@');
    const url = isEmail ? BAMBU_API.EMAIL_CODE : BAMBU_API.SMS_CODE;
    const body = isEmail
      ? { email: account, type: 'codeLogin' }
      : { phone: account, type: 'codeLogin' };

    const response = await fetch(url, {
      method: 'POST',
      headers: getBambuHeaders(),
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return { success: true, message: isEmail ? '验证码已发送到您的邮箱' : '验证码已发送到您的手机' };
    }

    const data = await response.json();
    return { success: false, error: translateError(data.error) || '发送验证码失败' };
  } catch (err) {
    console.error('Request verify code error:', err);
    return { success: false, error: translateError(err.message) };
  }
});

ipcMain.handle('cloud-login-code', async (_event, { account, code }) => {
  try {
    account = account.toString().replace(/\s+/g, '');

    const isEmail = account.includes('@');
    const body = { code };

    if (isEmail) {
      body.email = account;
    } else {
      body.account = account;
      body.loginType = 'phone';
    }

    const response = await fetch(BAMBU_API.LOGIN, {
      method: 'POST',
      headers: getBambuHeaders(),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (data.accessToken) {
      return { success: true, accessToken: data.accessToken };
    }

    if (data.code === 1) {
      return { success: false, codeExpired: true, error: '验证码已过期或无效' };
    }

    if (data.code === 2) {
      return { success: false, error: '验证码错误' };
    }

    return { success: false, error: translateError(data.error || data.message) || '登录失败' };
  } catch (err) {
    console.error('Code login error:', err);
    return { success: false, error: translateError(err.message) };
  }
});

ipcMain.handle('get-device-list', async (_event, { accessToken }) => {
  try {
    const response = await fetch(BAMBU_API.BIND, {
      method: 'GET',
      headers: {
        ...getBambuHeaders(),
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();
    console.log('Device list response:', JSON.stringify(data, null, 2));

    if (data.devices) {
      const username = await getBambuCloudUsername(accessToken);
      const devices = data.devices.map((d) => ({
        id: d.dev_id,
        name: d.name,
        model: d.dev_product_name || d.dev_model_name,
        modelCode: d.dev_model_name,
        accessCode: d.dev_access_code,
        online: d.online,
        printStatus: d.print_status,
        nozzle: d.nozzle_diameter,
      }));
      return { success: true, devices, username };
    }

    return { success: false, error: data.error || '获取设备列表失败' };
  } catch (err) {
    console.error('Get device list error:', err);
    return { success: false, error: err.message };
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
  try {
    const connectionConfig = buildMqttConnectionOptions(payload);
    const { serialNumber, url, mode, options } = connectionConfig;

    if (mqttConnections.has(serialNumber)) {
      const existing = mqttConnections.get(serialNumber);
      existing.intentional = true;
      clearMqttDisconnectTimer(existing);
      if (existing.client) {
        existing.client.end();
      }
      mqttConnections.delete(serialNumber);
    }

    console.log(`[Main] Connecting ${mode} MQTT to ${serialNumber}: ${url}`);

    const client = mqtt.connect(url, {
      username: options.username,
      password: options.password,
      rejectUnauthorized: options.rejectUnauthorized,
      connectTimeout: 15000,
      reconnectPeriod: MQTT_RECONNECT_PERIOD_MS,
      resubscribe: true,
    });
    const entry = {
      client,
      mode,
      intentional: false,
      connected: false,
      disconnectTimer: null,
    };
    mqttConnections.set(serialNumber, entry);

    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          entry.intentional = true;
          client.end(true);
          mqttConnections.delete(serialNumber);
          settled = true;
          reject(new Error('MQTT连接超时'));
        }, 15000);

        client.on('connect', () => {
          clearTimeout(timeout);
          clearMqttDisconnectTimer(entry);
          entry.connected = true;
          console.log(`[Main] MQTT Connected: ${serialNumber}`);
          sendRendererEvent('mqtt-connected', { serialNumber });

          const topic = `device/${serialNumber}/report`;
          client.subscribe(topic, (err) => {
            if (err) {
              console.error('[Main] Subscribe error:', err);
              if (!settled) {
                settled = true;
                reject(err);
              }
            } else {
              console.log(`[Main] Subscribed to ${topic}`);
              try {
                const requestTopic = `device/${serialNumber}/request`;
                const pushAllPayload = JSON.stringify({
                  pushing: {
                    sequence_id: '0',
                    command: 'pushall',
                  },
                });
                client.publish(requestTopic, pushAllPayload);
              } catch (publishErr) {
                console.warn(`[Main] pushall request failed (${serialNumber}):`, publishErr.message);
              }
              if (!settled) {
                settled = true;
                resolve({ success: true, serialNumber });
              }
            }
          });
        });

        client.on('message', (_topic, message) => {
          try {
            const payload = JSON.parse(message.toString());
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('mqtt-data', { serialNumber, payload });
            }
          } catch {
            // Ignore parse errors.
          }
        });

        client.on('reconnect', () => {
          console.log(`[Main] MQTT Reconnecting: ${serialNumber}`);
          sendRendererEvent('mqtt-reconnecting', { serialNumber });
        });

        client.on('offline', () => {
          console.log(`[Main] MQTT Offline: ${serialNumber}`);
          entry.connected = false;
          sendRendererEvent('mqtt-reconnecting', { serialNumber });
        });

        client.on('error', (err) => {
          console.error(`[Main] MQTT Error (${serialNumber}):`, err.message);
          if (!settled) {
            clearTimeout(timeout);
            settled = true;
            reject(err);
          }
        });

        client.on('close', () => {
          console.log(`[Main] MQTT Connection closed: ${serialNumber}`);
          entry.connected = false;
          if (entry.intentional) return;

          sendRendererEvent('mqtt-reconnecting', { serialNumber });
          if (!entry.disconnectTimer) {
            entry.disconnectTimer = setTimeout(() => {
              entry.disconnectTimer = null;
              if (entry.connected || entry.intentional) return;
              sendRendererEvent('mqtt-disconnected', { serialNumber });
            }, MQTT_RECONNECT_GRACE_MS);
            if (entry.disconnectTimer.unref) {
              entry.disconnectTimer.unref();
            }
          }
        });
      });

      return result;
    } catch (promiseErr) {
      console.error('[Main] MQTT Promise error:', promiseErr.message);
      entry.intentional = true;
      clearMqttDisconnectTimer(entry);
      client.end(true);
      mqttConnections.delete(serialNumber);
      return { success: false, error: promiseErr.message };
    }
  } catch (err) {
    console.error('[Main] MQTT connect error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mqtt-disconnect', async (_event, { serialNumber }) => {
  if (mqttConnections.has(serialNumber)) {
    const conn = mqttConnections.get(serialNumber);
    conn.intentional = true;
    clearMqttDisconnectTimer(conn);
    if (conn.client) {
      conn.client.end();
    }
    mqttConnections.delete(serialNumber);
  }
  return { success: true };
});

ipcMain.handle('mqtt-disconnect-all', async () => {
  for (const [, conn] of mqttConnections) {
    conn.intentional = true;
    clearMqttDisconnectTimer(conn);
    if (conn.client) {
      conn.client.end();
    }
  }
  mqttConnections.clear();
  return { success: true };
});
