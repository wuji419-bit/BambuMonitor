import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, LockKeyhole, Minus, Radio, ShieldCheck, X } from 'lucide-react';
import PrinterWidget from './components/PrinterWidget';
import appIconUrl from './assets/app-icon.svg';
import { bambuClient, scanPrinters } from './services/bambu';
import { electronEvents, electronWindow } from './services/electron';
import { dispatchPrinterNotification, getPrinterNotificationEvent } from './services/notifications';
import {
  mergeRuntimeDevice,
  replaceRuntimeSnapshot,
  runtime as selectedRuntime,
} from './services/runtime';
import { getRemovedPrinterIds, reconcilePrinterInventory } from './utils/deviceInventory';
import { buildDeviceSyncSnapshot, mergePrinterState } from './utils/printerSync';
import { acceptsConnectionGeneration, beginConnectionGeneration } from './utils/sessionGeneration';
import { cachePrinterAddress, isValidPrinterAddress, normalizePrinterAddress } from './utils/printerAddress';
import { runGenerationBoundScan } from './utils/generationBoundScan';
import {
  getWindowModeConfig,
  normalizeSavedWindowSize,
  readWindowSizeMap,
  updateWindowSizeMap,
  WINDOW_SIZE_STORAGE_KEY,
} from './utils/windowModes';

const isTokenInvalidError = (errorText) => (
  /expired|invalid|unauthorized|forbidden|401|token/i.test(String(errorText || ''))
);

const AGREEMENT_KEY = 'bambu_terms_agreed';
const DEVICE_SYNC_INTERVAL_MS = 5 * 60 * 1000;

function readCachedPrinterIps() {
  try {
    return JSON.parse(localStorage.getItem('cached_printer_ips') || '{}');
  } catch {
    return {};
  }
}

function syncCloudDeviceSnapshot(cloudDevices, scannedPrinters = []) {
  const snapshot = buildDeviceSyncSnapshot({
    cloudDevices,
    scannedPrinters,
    cachedIps: readCachedPrinterIps(),
  });
  localStorage.setItem('cached_printer_ips', JSON.stringify(snapshot.cachedIps));
  return snapshot;
}

function connectCloudPrinters(initialPrinters, token, username = '') {
  const existingById = new Map(bambuClient.getAllPrinters().map((printer) => [printer.dev_id, printer]));

  initialPrinters.forEach((printer) => {
    const existing = existingById.get(printer.dev_id);
    if (existing?.connectionMode === 'cloud' && bambuClient.isConnected(printer.dev_id)) return;

    bambuClient.connectCloud({
      authToken: token,
      username,
      region: 'China',
      serialNumber: printer.dev_id,
      onUpdate: (updatedPrinter) => updatedPrinter,
      deviceName: printer.name,
      initialPrinter: printer,
    }).catch((err) => {
      console.error(`Failed to connect cloud MQTT for ${printer.name}:`, err);
    });
  });
}

const PREVIEW_PRINTERS = [
  {
    dev_id: 'PREVIEW_A1_MINI',
    cloudId: 'cloud-a1-mini',
    name: 'A1 mini',
    model: 'A1 mini',
    modelCode: 'N2S',
    ip: '192.168.1.101',
    accessCode: '00000000',
    status: 'printing',
    statusSource: 'local',
    cloudOnline: true,
    progress: 68,
    timeLeft: '2h 18m',
    temperature: { nozzle: 219, bed: 61, chamber: 0 },
    fan: 72,
    speed: 100,
    layer: '132/300',
    filename: 'RX178马克兔440%精细分件V2-背包.3mf',
    errorMsg: '',
    ams: {
      activeAmsIndex: 0,
      units: [{
        index: 0,
        humidityRaw: 43,
        activeTray: { remain: 58, trayWeight: 850 },
        trays: [
          { id: 0, color: '55E6B2FF', remain: 82 },
          { id: 1, color: '74B8FFFF', remain: 58 },
          { id: 2, color: 'FFD166FF', remain: 34 },
          { id: 3, color: 'FF827DFF', remain: 16 },
        ],
      }],
    },
  },
  {
    dev_id: 'PREVIEW_H2D',
    cloudId: 'cloud-h2d',
    name: 'H2D',
    model: 'H2D',
    modelCode: 'H2D',
    ip: '192.168.1.102',
    accessCode: '00000000',
    status: 'paused',
    statusSource: 'local',
    cloudOnline: true,
    progress: 44,
    timeLeft: '3h 35m',
    temperature: { nozzle: 210, bed: 55, chamber: 35 },
    fan: 46,
    speed: 70,
    layer: '88/260',
    filename: '0.2mm 层高，2 层墙，15% 填充.3mf',
    errorMsg: '',
  },
  {
    dev_id: 'PREVIEW_P1S',
    cloudId: 'cloud-p1s',
    name: 'P1S',
    model: 'P1S',
    modelCode: 'P1S',
    ip: null,
    accessCode: '',
    status: 'cloud_overview',
    statusSource: 'cloud',
    cloudOnline: true,
    progress: 22,
    timeLeft: '--',
    temperature: { nozzle: 0, bed: 0, chamber: 0 },
    fan: 0,
    speed: 100,
    layer: '',
    filename: '云端状态同步中',
    errorMsg: '',
  },
];

function TitleBar({ isElectron }) {
  if (!isElectron) return null;

  return (
    <div className="title-bar">
      <div className="title-bar-drag" />
      <div className="title-bar-buttons">
        <button className="title-btn minimize" onClick={() => electronWindow.minimize()} aria-label="最小化">
          <Minus size={16} aria-hidden="true" />
        </button>
        <button className="title-btn close" onClick={() => electronWindow.close()} aria-label="关闭">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ConnectionScreen({
  onConnect,
  isConnectionGenerationCurrent,
  runtime,
  suppressAutoLogin = false,
  sessionWarning = '',
}) {
  const isElectron = runtime.kind === 'electron';
  const [isPasswordMode, setIsPasswordMode] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [agreed, setAgreed] = useState(() => localStorage.getItem(AGREEMENT_KEY) === 'true');
  const autoLoginAttemptedRef = useRef(false);

  useEffect(() => {
    document.body.classList.remove('transparent-mode');
    const savedAccount = localStorage.getItem('bambu_account');
    if (savedAccount) setAccount(savedAccount);

    return () => {
      document.body.classList.add('transparent-mode');
    };
  }, []);

  useEffect(() => {
    if (countdown <= 0) return undefined;

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [countdown]);

  useEffect(() => {
    localStorage.setItem(AGREEMENT_KEY, String(agreed));
  }, [agreed]);

  const handleSendCode = async () => {
    if (!account) {
      setErrorMsg('请输入手机号或邮箱');
      return;
    }

    setErrorMsg('');
    setSuccessMsg('');
    setCountdown(60);

    try {
      const result = await runtime.auth.requestVerifyCode({ account });

      if (result.success) {
        setSuccessMsg(result.message || '验证码已发送，请查看短信或邮箱');
      } else {
        setCountdown(0);
        setErrorMsg(result.error || '验证码发送失败');
      }
    } catch (err) {
      setCountdown(0);
      console.error('Send code error:', err);
      setErrorMsg(err.message || '验证码发送失败');
    }
  };

  const buildDeviceSync = (cloudDevices, scannedPrinters = []) => {
    const snapshot = syncCloudDeviceSnapshot(cloudDevices, scannedPrinters);

    return {
      devicesWithIp: snapshot.devicesWithIp,
      initialPrinters: snapshot.initialPrinters,
    };
  };

  const connectCloudDevices = (initialPrinters, token, username = '') => {
    connectCloudPrinters(initialPrinters, token, username);
  };

  const refreshLanDevicesInBackground = async (cloudDevices, expectedGeneration) => {
    await runGenerationBoundScan({
      scan: scanPrinters,
      expectedGeneration,
      isCurrent: isConnectionGenerationCurrent,
      buildSnapshot: (scannedPrinters) => buildDeviceSync(cloudDevices, scannedPrinters),
      mergeSnapshot: ({ devicesWithIp, initialPrinters }) => {
        if (devicesWithIp.some((device) => device.ip)) onConnect(initialPrinters, null, expectedGeneration);
      },
      onError: (scanErr) => console.error('LAN scan failed:', scanErr),
    });
  };

  const clearSavedLogin = async () => {
    if (isElectron) localStorage.removeItem('bambu_token');
    try {
      await runtime.auth.clearSavedSession();
    } catch (err) {
      console.warn('Clear saved session failed:', err);
    }
  };

  const fetchDeviceList = async (token, options = {}) => {
    setLoading(true);

    try {
      const result = await runtime.auth.getDeviceList(
        isElectron ? { accessToken: token } : undefined,
      );

      if (!result.success) {
        const errorText = result.error || '获取设备列表失败';
        if (isTokenInvalidError(errorText)) {
          await clearSavedLogin();
          setSuccessMsg('');
          setErrorMsg(options.autoLogin ? '登录状态已过期，请重新登录' : '登录已过期，请重新登录');
        } else {
          setErrorMsg(errorText);
        }
        setLoading(false);
        return;
      }

      const cloudDevices = result.devices || [];
      if (isElectron && cloudDevices.length === 0) {
        setErrorMsg('没有找到已绑定的打印机，请确认设备已绑定到当前账号');
        setLoading(false);
        return;
      }

      const initialPrinters = isElectron
        ? buildDeviceSync(cloudDevices).initialPrinters
        : replaceRuntimeSnapshot([], cloudDevices);

      setSuccessMsg(isElectron
        ? `已读取 ${cloudDevices.length} 台云端设备，正在通过云端 MQTT 同步实时状态...`
        : `已读取 ${cloudDevices.length} 台设备，正在同步实时状态...`);
      if (isElectron) connectCloudDevices(initialPrinters, token, result.username);
      setLoading(false);
      const connectionGeneration = onConnect(initialPrinters, {
        ...(isElectron ? { accessToken: token } : { serverSession: true }),
        username: result.username || '',
      });
      if (isElectron) refreshLanDevicesInBackground(cloudDevices, connectionGeneration);
    } catch (err) {
      console.error('Fetch device list error:', err);
      const errorText = err.message || '获取设备失败';
      if (isTokenInvalidError(errorText)) {
        await clearSavedLogin();
        setSuccessMsg('');
        setErrorMsg('登录状态已过期，请重新登录');
      } else {
        setErrorMsg(errorText);
      }
      setLoading(false);
    }
  };

  const handleLogin = async (event) => {
    event.preventDefault();

    if (!agreed) {
      setErrorMsg('请先勾选用户协议与隐私政策');
      return;
    }
    if (!account) {
      setErrorMsg('请输入账号');
      return;
    }
    if (isPasswordMode && !password) {
      setErrorMsg('请输入密码');
      return;
    }
    if (!isPasswordMode && !verifyCode) {
      setErrorMsg('请输入验证码');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const result = isPasswordMode
        ? await runtime.auth.cloudLogin({ account, password })
        : await runtime.auth.cloudLoginCode({ account, code: verifyCode });

      if (result.success) {
        setSuccessMsg('登录成功，正在同步设备...');
        localStorage.setItem('bambu_account', account);
        if (isElectron) {
          await runtime.auth.saveSession({ account, accessToken: result.accessToken });
        }
        await fetchDeviceList(isElectron ? result.accessToken : undefined);
        return;
      }

      if (result.needVerifyCode) {
        setIsPasswordMode(false);
        setPassword('');

        try {
          await runtime.auth.requestVerifyCode({ account });
          setCountdown(60);
          setSuccessMsg('检测到新设备登录，请输入验证码完成安全验证。');
          setErrorMsg('');
        } catch {
          setErrorMsg('验证码发送失败，请手动点击发送验证码');
        }
        return;
      }

      if (result.needTfa) {
        setErrorMsg('暂不支持开启 2FA 的账号，请关闭 2FA 后重试，或改用验证码登录');
        return;
      }

      setErrorMsg(result.error || '登录失败，请检查账号和密码');
    } catch (err) {
      console.error('Login error:', err);
      setErrorMsg(err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (autoLoginAttemptedRef.current) return;
    autoLoginAttemptedRef.current = true;
    if (suppressAutoLogin) return;

    const restoreLogin = async () => {
      if (isElectron) localStorage.removeItem('bambu_token');
      let savedToken = '';
      let savedAccount = localStorage.getItem('bambu_account') || '';
      let hasSavedSession = false;

      try {
        const result = await runtime.auth.getSavedSession();
        const session = result?.session;
        if (session?.accessToken || session?.serverSession) {
          hasSavedSession = true;
          savedToken = session.accessToken;
          savedAccount = session.account || savedAccount;
          if (savedAccount) localStorage.setItem('bambu_account', savedAccount);
        }
      } catch (err) {
        console.warn('Read saved session failed:', err);
      }

      if (savedAccount) setAccount(savedAccount);
      if (savedToken || hasSavedSession) {
        setSuccessMsg('检测到已登录会话，正在自动连接...');
        fetchDeviceList(savedToken, { autoLogin: true });
      }
    };

    restoreLogin();
  }, [isElectron, runtime, suppressAutoLogin]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const canSubmit = account && (isPasswordMode ? password : verifyCode) && agreed;

  return (
    <div className="app-window login-window">
      <TitleBar isElectron={isElectron} />

      <div className="login-shell">
        <section className="login-visual">
          <div className="login-icon-frame">
            <img src={appIconUrl} alt="" className="login-app-icon" />
          </div>
          <div className="login-visual-copy">
            <div className="login-kicker">Bambu Monitor</div>
            <h1>BambuMonitor</h1>
            <p>一个常驻桌面的打印状态控制台：同步云端设备，本地实时连接，快速看进度、温度、AMS 和异常提醒。</p>
          </div>
          <div className="login-status-card">
            <div className="status-card-title">实时概览</div>
            <div className="status-row">
              <span className="status-dot mint" />
              <span>A1 mini</span>
              <strong>68%</strong>
            </div>
            <div className="status-row">
              <span className="status-dot blue" />
              <span>X1 Carbon</span>
              <strong>22%</strong>
            </div>
            <div className="status-row">
              <span className="status-dot red" />
              <span>P1SC</span>
              <strong>异常</strong>
            </div>
            <div className="login-mini-metrics">
              <span>局域网实时</span>
              <span>云端兜底</span>
              <span>通知联动</span>
            </div>
          </div>
        </section>

        <section className="login-card">
          <div className="login-header">
            <div className="login-badge">
              <ShieldCheck size={15} />
              Bambu Lab / MakerWorld
            </div>
            <h2>同步你的打印机</h2>
            <p>账号只用于读取绑定设备；实时遥测仍优先走本机可访问的局域网连接。</p>
          </div>

          {sessionWarning ? <div className="feedback-msg error" role="alert">{sessionWarning}</div> : null}

          <form onSubmit={handleLogin}>
            <div className="mode-switch">
              <button
                type="button"
                className={isPasswordMode ? 'active' : ''}
                onClick={() => {
                  setIsPasswordMode(true);
                  setErrorMsg('');
                  setSuccessMsg('');
                }}
              >
                <LockKeyhole size={14} />
                密码登录
              </button>
              <button
                type="button"
                className={!isPasswordMode ? 'active' : ''}
                onClick={() => {
                  setIsPasswordMode(false);
                  setErrorMsg('');
                  setSuccessMsg('');
                }}
              >
                <Radio size={14} />
                验证码
              </button>
            </div>

            <div className="input-group">
              <label className="input-label">邮箱 / 手机号</label>
              <input
                type="text"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                placeholder="输入 Bambu Lab 或 MakerWorld 账号"
              />
            </div>

            {isPasswordMode ? (
              <div className="input-group">
                <label className="input-label">密码</label>
                <div className="input-with-action">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="输入登录密码"
                  />
                  <button
                    type="button"
                    className="icon-field-btn"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    title={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="input-group">
                <label className="input-label">验证码</label>
                <div className="input-with-action">
                  <input
                    type="text"
                    value={verifyCode}
                    onChange={(event) => setVerifyCode(event.target.value)}
                    placeholder="输入短信或邮箱验证码"
                  />
                  <button
                    type="button"
                    className="send-code-btn"
                    onClick={handleSendCode}
                    disabled={countdown > 0}
                  >
                    {countdown > 0 ? `${countdown}s` : '发送'}
                  </button>
                </div>
              </div>
            )}

            {errorMsg ? <div className="feedback-msg error">{errorMsg}</div> : null}
            {successMsg ? <div className="feedback-msg success">{successMsg}</div> : null}

            <label className="checkbox-group">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>我已阅读并同意用户协议与隐私政策</span>
            </label>

            <button
              type="submit"
              className={`submit-btn ${canSubmit ? 'active' : ''}`}
              disabled={loading}
            >
              {loading ? '正在连接...' : '登录并同步设备'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function App() {
  const [runtime] = useState(() => selectedRuntime);
  const [isElectron] = useState(() => runtime.kind === 'electron');
  const [isPreviewMode] = useState(() => (
    runtime.kind !== 'electron'
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'dashboard'
  ));
  const [isConnected, setIsConnected] = useState(() => isPreviewMode);
  const [printers, setPrinters] = useState(() => (isPreviewMode ? PREVIEW_PRINTERS : []));
  const [isRefreshingDevices, setIsRefreshingDevices] = useState(false);
  const [lastDeviceSyncAt, setLastDeviceSyncAt] = useState(() => (isPreviewMode ? Date.now() : 0));
  const [deviceSyncError, setDeviceSyncError] = useState('');
  const [suppressAutoLogin, setSuppressAutoLogin] = useState(false);
  const [sessionWarning, setSessionWarning] = useState('');
  const lastPrinterStatusRef = useRef(new Map());
  const authSessionRef = useRef(null);
  const deviceSyncBusyRef = useRef(false);
  const deviceSyncGenerationRef = useRef(0);
  const deviceSyncBusyGenerationRef = useRef(null);
  const refreshDevicesRef = useRef(null);

  useEffect(() => {
    if (!isElectron || isConnected) return undefined;

    const persistLoginBounds = (bounds) => {
      const normalized = normalizeSavedWindowSize('login', bounds);
      if (!normalized) return;
      const current = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
      localStorage.setItem(
        WINDOW_SIZE_STORAGE_KEY,
        JSON.stringify(updateWindowSizeMap(current, 'login', normalized)),
      );
    };

    const config = getWindowModeConfig('login');
    const savedSizes = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
    const size = normalizeSavedWindowSize('login', savedSizes.login) || config.defaultSize;
    const frameId = requestAnimationFrame(() => {
      electronWindow.setModeSize({
        ...size,
        minWidth: config.minSize.width,
        minHeight: config.minSize.height,
      });
    });
    const offBoundsChanged = electronEvents.onWindowBoundsChanged(persistLoginBounds);
    const offBoundsSaveRequest = electronEvents.onWindowBoundsSaveRequest(persistLoginBounds);

    return () => {
      cancelAnimationFrame(frameId);
      offBoundsChanged();
      offBoundsSaveRequest();
    };
  }, [isElectron, isConnected]);

  const handleConnect = (initialPrinters = [], session = null, expectedGeneration = null) => {
    if (!acceptsConnectionGeneration(deviceSyncGenerationRef.current, expectedGeneration)) return null;
    if (session?.accessToken || session?.serverSession) {
      deviceSyncGenerationRef.current = beginConnectionGeneration(deviceSyncGenerationRef.current);
      deviceSyncBusyRef.current = false;
      deviceSyncBusyGenerationRef.current = null;
      authSessionRef.current = session;
      setSuppressAutoLogin(false);
      setSessionWarning('');
      setLastDeviceSyncAt(Date.now());
      setDeviceSyncError('');
    }

    if (!isElectron) {
      setPrinters(replaceRuntimeSnapshot([], initialPrinters));
      setIsConnected(true);
      return deviceSyncGenerationRef.current;
    }

    const connectedPrinters = bambuClient.getAllPrinters();
    const mergedById = new Map();

    initialPrinters.forEach((printer) => {
      mergedById.set(printer.dev_id, mergePrinterState({}, printer));
    });

    connectedPrinters.forEach((printer) => {
      mergedById.set(printer.dev_id, mergePrinterState(mergedById.get(printer.dev_id), printer));
    });

    setPrinters(Array.from(mergedById.values()));

    bambuClient.setGlobalUpdateCallback((updatedPrinter) => {
      setPrinters((prev) => {
        const existingIndex = prev.findIndex((printer) => printer.dev_id === updatedPrinter.dev_id);
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = mergePrinterState(next[existingIndex], updatedPrinter);
          return next;
        }
        return [...prev, mergePrinterState({}, updatedPrinter)];
      });
    });

    setIsConnected(true);
    return deviceSyncGenerationRef.current;
  };

  const refreshDeviceInventory = async ({ includeLan = true } = {}) => {
    if (isPreviewMode) {
      setLastDeviceSyncAt(Date.now());
      setDeviceSyncError('');
      return;
    }
    if (deviceSyncBusyRef.current) return;

    if (!isElectron) {
      const generation = deviceSyncGenerationRef.current;
      deviceSyncBusyRef.current = true;
      setIsRefreshingDevices(true);
      setDeviceSyncError('');
      try {
        const result = await runtime.devices.refresh();
        if (deviceSyncGenerationRef.current !== generation) return;
        if (!result?.success) throw new Error(result?.error || '同步设备失败');
        setPrinters((current) => replaceRuntimeSnapshot(current, result.devices));
        setLastDeviceSyncAt(result.syncedAt || Date.now());
      } catch (error) {
        if (deviceSyncGenerationRef.current === generation) {
          setDeviceSyncError(error?.message || '同步设备失败');
        }
      } finally {
        if (deviceSyncGenerationRef.current === generation) {
          deviceSyncBusyRef.current = false;
          setIsRefreshingDevices(false);
        }
      }
      return;
    }

    const generation = deviceSyncGenerationRef.current + 1;
    deviceSyncGenerationRef.current = generation;
    const isCurrentGeneration = () => deviceSyncGenerationRef.current === generation;
    deviceSyncBusyRef.current = true;
    deviceSyncBusyGenerationRef.current = generation;
    setIsRefreshingDevices(true);
    setDeviceSyncError('');

    try {
      let session = authSessionRef.current;
      if (!session?.accessToken) {
        const saved = await runtime.auth.getSavedSession();
        if (!isCurrentGeneration()) return;
        session = saved?.session || null;
        if (session?.accessToken) authSessionRef.current = session;
      }
      if (!session?.accessToken) {
        throw new Error('登录状态不可用，请重新登录');
      }

      const result = await runtime.auth.getDeviceList({ accessToken: session.accessToken });
      if (!isCurrentGeneration()) return;
      if (!result?.success) {
        throw new Error(result?.error || '同步设备失败');
      }

      const cloudDevices = result.devices || [];
      const snapshot = syncCloudDeviceSnapshot(cloudDevices);
      const removedIds = getRemovedPrinterIds(bambuClient.getAllPrinters(), snapshot.initialPrinters);
      await Promise.allSettled(removedIds.map((serialNumber) => bambuClient.disconnect(serialNumber)));
      if (!isCurrentGeneration()) return;

      setPrinters((current) => reconcilePrinterInventory(current, snapshot.initialPrinters));
      authSessionRef.current = {
        ...session,
        username: result.username || session.username || '',
      };
      connectCloudPrinters(snapshot.initialPrinters, session.accessToken, authSessionRef.current.username);
      setLastDeviceSyncAt(Date.now());

      if (includeLan) {
        scanPrinters()
          .then((scannedPrinters) => {
            if (!isCurrentGeneration()) return;
            const lanSnapshot = syncCloudDeviceSnapshot(cloudDevices, scannedPrinters);
            setPrinters((current) => reconcilePrinterInventory(current, lanSnapshot.initialPrinters));
          })
          .catch((error) => {
            if (!isCurrentGeneration()) return;
            console.warn('Background LAN refresh failed:', error);
          });
      }
    } catch (error) {
      if (!isCurrentGeneration()) return;
      setDeviceSyncError(error?.message || '同步设备失败');
    } finally {
      if (isCurrentGeneration() && deviceSyncBusyGenerationRef.current === generation) {
        deviceSyncBusyRef.current = false;
        deviceSyncBusyGenerationRef.current = null;
        setIsRefreshingDevices(false);
      }
    }
  };

  refreshDevicesRef.current = refreshDeviceInventory;

  const handleSignOut = async () => {
    const signOutGeneration = deviceSyncGenerationRef.current + 1;
    deviceSyncGenerationRef.current = signOutGeneration;
    deviceSyncBusyRef.current = false;
    deviceSyncBusyGenerationRef.current = null;
    setIsRefreshingDevices(false);
    setSuppressAutoLogin(true);
    let disconnectError = null;
    let sessionClearError = null;
    try {
      if (isElectron) await bambuClient.disconnect();
    } catch (error) {
      disconnectError = error;
      console.warn('Disconnect during sign-out failed:', error);
    } finally {
      if (deviceSyncGenerationRef.current === signOutGeneration) {
        try {
          const clearResult = await runtime.auth.clearSavedSession();
          if (!clearResult?.success) sessionClearError = new Error(clearResult?.error || '无法清除登录状态');
        } catch (error) {
          sessionClearError = error;
          console.warn('Clear saved session during sign-out failed:', error);
        }
        if (deviceSyncGenerationRef.current === signOutGeneration) {
          if (!isElectron) runtime.events.close();
          localStorage.removeItem('bambu_account');
          if (isElectron) localStorage.removeItem('bambu_token');
          authSessionRef.current = null;
          lastPrinterStatusRef.current.clear();
          deviceSyncBusyRef.current = false;
          deviceSyncBusyGenerationRef.current = null;
          setPrinters([]);
          setIsRefreshingDevices(false);
          setLastDeviceSyncAt(0);
          setDeviceSyncError('');
          setSessionWarning(sessionClearError
            ? (isElectron
              ? '已退出账号，但加密登录文件删除失败；本次运行不会自动登录，请稍后重试。'
              : '退出登录失败，请稍后重试。')
            : (disconnectError ? '设备断开失败，但你已退出账号。' : ''));
          setIsConnected(false);
        }
      }
    }
  };

  useEffect(() => {
    if (!isConnected || !isElectron || isPreviewMode) return undefined;
    const timer = window.setInterval(() => {
      refreshDevicesRef.current?.({ includeLan: false });
    }, DEVICE_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [isConnected, isElectron, isPreviewMode]);

  useEffect(() => {
    if (!isConnected || isElectron || isPreviewMode) return undefined;
    const generation = deviceSyncGenerationRef.current;
    const isCurrent = () => deviceSyncGenerationRef.current === generation;

    const offSnapshot = runtime.events.onDeviceSnapshot((event) => {
      if (!isCurrent()) return;
      setPrinters((current) => replaceRuntimeSnapshot(current, event.devices));
      setLastDeviceSyncAt(event.syncedAt || Date.now());
      setDeviceSyncError('');
    });
    const offUpdate = runtime.events.onDeviceUpdate((event) => {
      if (!isCurrent()) return;
      setPrinters((current) => mergeRuntimeDevice(current, event.device));
    });
    const offInvalid = runtime.events.onSessionInvalid(() => {
      if (!isCurrent()) return;
      deviceSyncGenerationRef.current = beginConnectionGeneration(deviceSyncGenerationRef.current);
      deviceSyncBusyRef.current = false;
      deviceSyncBusyGenerationRef.current = null;
      authSessionRef.current = null;
      lastPrinterStatusRef.current.clear();
      runtime.events.close();
      setPrinters([]);
      setIsRefreshingDevices(false);
      setLastDeviceSyncAt(0);
      setDeviceSyncError('');
      setSuppressAutoLogin(true);
      setSessionWarning('登录状态已过期，请重新登录');
      setIsConnected(false);
    });

    return () => {
      offSnapshot();
      offUpdate();
      offInvalid();
    };
  }, [isConnected, isElectron, isPreviewMode, runtime]);

  useEffect(() => {
    const statusMap = lastPrinterStatusRef.current;
    const currentIds = new Set(printers.map((printer) => printer.dev_id));

    for (const devId of statusMap.keys()) {
      if (!currentIds.has(devId)) {
        statusMap.delete(devId);
      }
    }

    for (const printer of printers) {
      const previousPrinter = statusMap.get(printer.dev_id);
      const previousJobStatus = previousPrinter?.jobStatus || previousPrinter?.status;
      const currentJobStatus = printer.jobStatus || printer.status;
      const notificationEvent = getPrinterNotificationEvent(previousPrinter, printer);

      if (previousJobStatus && previousJobStatus !== 'finished' && currentJobStatus === 'finished') {
        const message = `${printer.name || '打印机'} 打印完成`;
        try {
          if (typeof window !== 'undefined' && window.speechSynthesis && window.SpeechSynthesisUtterance) {
            const utterance = new window.SpeechSynthesisUtterance(message);
            utterance.lang = 'zh-CN';
            window.speechSynthesis.speak(utterance);
          }
        } catch (err) {
          console.error('语音播报失败:', err);
        }
      }

      if (notificationEvent) {
        dispatchPrinterNotification(notificationEvent, printer, { previousStatus: previousJobStatus })
          .catch((err) => {
            console.error('发送打印机通知失败:', err);
          });
      }

      statusMap.set(printer.dev_id, {
        status: printer.status,
        jobStatus: printer.jobStatus,
        connectionState: printer.connectionState,
      });
    }
  }, [printers]);

  useEffect(() => () => {
    if (isElectron) {
      bambuClient.disconnect().catch((err) => {
        console.error('Disconnect on teardown failed:', err);
      });
    } else {
      runtime.events.close();
    }
  }, [isElectron, runtime]);

  const handleUpdateIp = async (serial, ip) => {
    const normalizedIp = normalizePrinterAddress(ip);
    if (!isValidPrinterAddress(normalizedIp)) {
      throw new Error('请输入有效的 IPv4、IPv6 或主机名，不要包含协议或端口');
    }

    const printer = printers.find((item) => item.dev_id === serial);
    if (!printer) {
      console.error('Printer not found:', serial);
      throw new Error('未找到对应的打印机');
    }

    if (!isElectron) {
      const result = await runtime.devices.update(serial, { ip: normalizedIp });
      if (!result?.success || !result.device) {
        throw new Error(result?.error || '更新打印机地址失败');
      }
      setPrinters((current) => mergeRuntimeDevice(current, result.device));
      return;
    }

    let savedToken = authSessionRef.current?.accessToken || '';
    if (!savedToken && isElectron) {
      const saved = await runtime.auth.getSavedSession();
      if (saved?.session?.accessToken) {
        authSessionRef.current = saved.session;
        savedToken = saved.session.accessToken;
      }
    }
    const shouldUseCloudStatus = Boolean(savedToken)
      && (printer.connectionMode === 'cloud' || printer.statusSource === 'cloud');

    setPrinters((prev) => {
      const index = prev.findIndex((item) => item.dev_id === serial);
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = {
        ...next[index],
        connectionState: 'connecting',
        statusSource: shouldUseCloudStatus ? 'cloud' : 'local',
        connectionMode: shouldUseCloudStatus ? 'cloud' : 'local',
        ip: normalizedIp,
        errorMsg: '',
      };
      return next;
    });

    try {
      const onPrinterUpdate = (updatedPrinter) => {
        setPrinters((prev) => {
          const index = prev.findIndex((item) => item.dev_id === updatedPrinter.dev_id);
          if (index === -1) return [...prev, mergePrinterState({}, updatedPrinter)];
          const next = [...prev];
          next[index] = mergePrinterState(next[index], updatedPrinter);
          return next;
        });
      };

      if (shouldUseCloudStatus) {
        await bambuClient.connectCloud({
          authToken: savedToken,
          username: authSessionRef.current?.username || printer.cloudUsername || '',
          region: 'China',
          serialNumber: serial,
          onUpdate: onPrinterUpdate,
          deviceName: printer.name,
          initialPrinter: {
            ...printer,
            ip: normalizedIp,
            statusSource: 'cloud',
            connectionMode: 'cloud',
          },
        });
      } else {
        await bambuClient.connectLocal(
          normalizedIp,
          printer.accessCode,
          serial,
          onPrinterUpdate,
          printer.name,
        );
      }
      const cachedIps = cachePrinterAddress(readCachedPrinterIps(), printer, normalizedIp);
      localStorage.setItem('cached_printer_ips', JSON.stringify(cachedIps));
    } catch (err) {
      console.error('Manual connect failed:', err);
      setPrinters((prev) => {
        const index = prev.findIndex((item) => item.dev_id === serial);
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: next[index].jobStatus || next[index].status || 'error',
          connectionState: 'error',
          statusSource: shouldUseCloudStatus ? 'cloud' : 'local',
          connectionMode: shouldUseCloudStatus ? 'cloud' : 'local',
          ip: normalizedIp,
          errorMsg: err.message || '连接失败',
        };
        return next;
      });
      throw err;
    }
  };

  if (!isConnected) {
    return (
      <ConnectionScreen
        onConnect={handleConnect}
        isConnectionGenerationCurrent={(generation) => deviceSyncGenerationRef.current === generation}
        runtime={runtime}
        suppressAutoLogin={suppressAutoLogin}
        sessionWarning={sessionWarning}
      />
    );
  }

  return (
    <>
      <PrinterWidget
        printers={printers}
        onUpdateIp={handleUpdateIp}
        onRefreshDevices={() => refreshDeviceInventory({ includeLan: true })}
        isRefreshingDevices={isRefreshingDevices}
        lastDeviceSyncAt={lastDeviceSyncAt}
        deviceSyncError={deviceSyncError}
        onSignOut={handleSignOut}
      />
    </>
  );
}

export default App;
