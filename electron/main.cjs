const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

let mainWindow;
let tray = null;
let isMouseLocked = false;
let isAlwaysOnTop = true;
let windowOpacity = 1;
const OPACITY_PRESETS = [1, 0.95, 0.9, 0.85, 0.8];

const mqttConnections = new Map();

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

function setAlwaysOnTop(flag) {
  isAlwaysOnTop = !!flag;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(isAlwaysOnTop);
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
    if (conn.client) {
      conn.client.end();
    }
  }
  mqttConnections.clear();
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
  const newHeight = bounds.height || currentSize[1];
  const newWidth = bounds.width || currentSize[0];
  win.setContentSize(newWidth, newHeight, true);
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
      return { success: true, devices };
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

ipcMain.handle('mqtt-connect', async (_event, { ip, accessCode, serialNumber }) => {
  try {
    if (mqttConnections.has(serialNumber)) {
      const existing = mqttConnections.get(serialNumber);
      if (existing.client) {
        existing.client.end();
      }
      mqttConnections.delete(serialNumber);
    }

    const url = `mqtts://${ip}:8883`;
    console.log(`[Main] Connecting MQTT to ${serialNumber}: ${url}`);

    const client = mqtt.connect(url, {
      username: 'bblp',
      password: accessCode,
      rejectUnauthorized: false,
      connectTimeout: 15000,
      reconnectPeriod: 0,
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          client.end();
          reject(new Error('MQTT连接超时'));
        }, 15000);

        client.on('connect', () => {
          clearTimeout(timeout);
          console.log(`[Main] MQTT Connected: ${serialNumber}`);

          const topic = `device/${serialNumber}/report`;
          client.subscribe(topic, (err) => {
            if (err) {
              console.error('[Main] Subscribe error:', err);
              reject(err);
            } else {
              console.log(`[Main] Subscribed to ${topic}`);
              mqttConnections.set(serialNumber, { client, ip, accessCode });
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
              resolve({ success: true, serialNumber });
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

        client.on('error', (err) => {
          clearTimeout(timeout);
          console.error(`[Main] MQTT Error (${serialNumber}):`, err.message);
          reject(err);
        });

        client.on('close', () => {
          console.log(`[Main] MQTT Connection closed: ${serialNumber}`);
          mqttConnections.delete(serialNumber);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mqtt-disconnected', { serialNumber });
          }
        });
      });

      return result;
    } catch (promiseErr) {
      console.error('[Main] MQTT Promise error:', promiseErr.message);
      client.end();
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
    if (conn.client) {
      conn.client.end();
    }
    mqttConnections.delete(serialNumber);
  }
  return { success: true };
});

ipcMain.handle('mqtt-disconnect-all', async () => {
  for (const [, conn] of mqttConnections) {
    if (conn.client) {
      conn.client.end();
    }
  }
  mqttConnections.clear();
  return { success: true };
});
