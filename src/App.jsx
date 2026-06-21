import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, LockKeyhole, Radio, ShieldCheck } from 'lucide-react';
import PrinterWidget from './components/PrinterWidget';
import MobileDashboard from './components/MobileDashboard';
import appIconUrl from './assets/app-icon.svg';
import { bambuClient, scanPrinters } from './services/bambu';
import { electronAuth, electronWindow, isElectronEnvironment } from './services/electron';
import { dispatchPrinterNotification, getPrinterNotificationEvent } from './services/notifications';
import { buildDeviceSyncSnapshot, mergePrinterState, normalizeName } from './utils/printerSync';

const isTokenInvalidError = (errorText) => (
  /expired|invalid|unauthorized|forbidden|401|token/i.test(String(errorText || ''))
);

const AGREEMENT_KEY = 'bambu_terms_agreed';

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
          _
        </button>
        <button className="title-btn close" onClick={() => electronWindow.close()} aria-label="关闭">
          ×
        </button>
      </div>
    </div>
  );
}

function ConnectionScreen({ onConnect, isElectron }) {
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
    if (!isElectron) {
      setErrorMsg('验证码登录仅支持桌面版应用');
      return;
    }

    if (!account) {
      setErrorMsg('请输入手机号或邮箱');
      return;
    }

    setErrorMsg('');
    setSuccessMsg('');
    setCountdown(60);

    try {
      const result = await electronAuth.requestVerifyCode({ account });

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

  const readCachedIps = () => {
    try {
      return JSON.parse(localStorage.getItem('cached_printer_ips') || '{}');
    } catch {
      return {};
    }
  };

  const buildDeviceSync = (cloudDevices, scannedPrinters = []) => {
    const snapshot = buildDeviceSyncSnapshot({
      cloudDevices,
      scannedPrinters,
      cachedIps: readCachedIps(),
    });

    localStorage.setItem('cached_printer_ips', JSON.stringify(snapshot.cachedIps));

    return {
      devicesWithIp: snapshot.devicesWithIp,
      initialPrinters: snapshot.initialPrinters,
    };
  };

  const connectReachableDevices = (devicesWithIp) => {
    const existingById = new Map(bambuClient.getAllPrinters().map((printer) => [printer.dev_id, printer]));

    devicesWithIp
      .filter((device) => device.ip)
      .forEach((device) => {
        const existing = existingById.get(device.mqttSerial);
        if (existing?.ip === device.ip && bambuClient.isConnected(device.mqttSerial)) return;

        bambuClient.connectLocal(
          device.ip,
          device.accessCode,
          device.mqttSerial,
          (updatedPrinter) => updatedPrinter,
          device.name,
        ).catch((err) => {
          console.error(`Failed to connect ${device.name}:`, err);
        });
      });
  };

  const refreshLanDevicesInBackground = async (cloudDevices) => {
    let scannedPrinters = [];
    try {
      scannedPrinters = await scanPrinters();
    } catch (scanErr) {
      console.error('LAN scan failed:', scanErr);
      return;
    }

    const { devicesWithIp, initialPrinters } = buildDeviceSync(cloudDevices, scannedPrinters);
    if (devicesWithIp.some((device) => device.ip)) {
      onConnect(initialPrinters);
      connectReachableDevices(devicesWithIp);
    }
  };

  const fetchDeviceList = async (token, options = {}) => {
    setLoading(true);

    try {
      const result = await electronAuth.getDeviceList({ accessToken: token });

      if (!result.success) {
        const errorText = result.error || '获取设备列表失败';
        if (isTokenInvalidError(errorText)) {
          localStorage.removeItem('bambu_token');
          setSuccessMsg('');
          setErrorMsg(options.autoLogin ? '登录状态已过期，请重新登录' : '登录已过期，请重新登录');
        } else {
          setErrorMsg(errorText);
        }
        setLoading(false);
        return;
      }

      const cloudDevices = result.devices || [];
      if (cloudDevices.length === 0) {
        setErrorMsg('没有找到已绑定的打印机，请确认设备已绑定到当前账号');
        setLoading(false);
        return;
      }

      const { devicesWithIp, initialPrinters } = buildDeviceSync(cloudDevices);
      const reachableDevices = devicesWithIp.filter((device) => device.ip);

      setSuccessMsg(
        reachableDevices.length > 0
          ? `已读取 ${cloudDevices.length} 台设备，正在使用缓存 IP 快速连接 ${reachableDevices.length} 台...`
          : `已读取 ${cloudDevices.length} 台云端设备，先进入概览，后台继续扫描局域网...`,
      );

      connectReachableDevices(devicesWithIp);
      setLoading(false);
      electronWindow.resize({ width: 450, height: 200 });
      onConnect(initialPrinters);
      refreshLanDevicesInBackground(cloudDevices);
    } catch (err) {
      console.error('Fetch device list error:', err);
      const errorText = err.message || '获取设备失败';
      if (isTokenInvalidError(errorText)) {
        localStorage.removeItem('bambu_token');
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

    if (!isElectron) {
      setErrorMsg('当前为浏览器预览模式，请启动桌面版应用后登录');
      return;
    }

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
        ? await electronAuth.cloudLogin({ account, password })
        : await electronAuth.cloudLoginCode({ account, code: verifyCode });

      if (result.success) {
        setSuccessMsg('登录成功，正在同步设备...');
        localStorage.setItem('bambu_account', account);
        localStorage.setItem('bambu_token', result.accessToken);
        await fetchDeviceList(result.accessToken);
        return;
      }

      if (result.needVerifyCode) {
        setIsPasswordMode(false);
        setPassword('');

        try {
          await electronAuth.requestVerifyCode({ account });
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

    const savedToken = localStorage.getItem('bambu_token');
    if (savedToken && isElectron) {
      setSuccessMsg('检测到已登录会话，正在自动连接...');
      fetchDeviceList(savedToken, { autoLogin: true });
    }
  }, [isElectron]);
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

          {!isElectron ? (
            <div className="feedback-msg error">当前窗口仅用于界面预览，请启动桌面版应用后再登录。</div>
          ) : null}

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
  const [isElectron] = useState(() => isElectronEnvironment());
  const [isPreviewMode] = useState(() => (
    !isElectronEnvironment()
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'dashboard'
  ));
  const [isConnected, setIsConnected] = useState(() => isPreviewMode);
  const [printers, setPrinters] = useState(() => (isPreviewMode ? PREVIEW_PRINTERS : []));
  const lastPrinterStatusRef = useRef(new Map());

  useEffect(() => {
    if (!isElectron) return;
    if (isConnected) {
      electronWindow.resize({ width: 460, height: 610 });
    } else {
      electronWindow.resize({ width: 860, height: 620 });
    }
  }, [isElectron, isConnected]);

  const handleConnect = (initialPrinters = []) => {
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
  };

  useEffect(() => {
    const statusMap = lastPrinterStatusRef.current;
    const currentIds = new Set(printers.map((printer) => printer.dev_id));

    for (const devId of statusMap.keys()) {
      if (!currentIds.has(devId)) {
        statusMap.delete(devId);
      }
    }

    for (const printer of printers) {
      const prevStatus = statusMap.get(printer.dev_id);
      const currentStatus = printer.status;
      const notificationEvent = getPrinterNotificationEvent(prevStatus, currentStatus);

      if (prevStatus && prevStatus !== 'finished' && currentStatus === 'finished') {
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
        dispatchPrinterNotification(notificationEvent, printer, { previousStatus: prevStatus })
          .catch((err) => {
            console.error('发送打印机通知失败:', err);
          });
      }

      statusMap.set(printer.dev_id, currentStatus);
    }
  }, [printers]);

  useEffect(() => () => {
    if (isElectron) {
      bambuClient.disconnect().catch((err) => {
        console.error('Disconnect on teardown failed:', err);
      });
    }
  }, [isElectron]);

  const handleUpdateIp = async (serial, ip) => {
    const normalizedIp = String(ip || '').trim();
    if (!normalizedIp) {
      throw new Error('请输入当前电脑可访问的打印机 IP');
    }

    const printer = printers.find((item) => item.dev_id === serial);
    if (!printer) {
      console.error('Printer not found:', serial);
      throw new Error('未找到对应的打印机');
    }

    const cachedIps = JSON.parse(localStorage.getItem('cached_printer_ips') || '{}');
    cachedIps[printer.cloudId || printer.dev_id] = normalizedIp;
    cachedIps[printer.dev_id] = normalizedIp;
    const nameKey = normalizeName(printer.name);
    if (nameKey) cachedIps[nameKey] = normalizedIp;
    localStorage.setItem('cached_printer_ips', JSON.stringify(cachedIps));

    setPrinters((prev) => {
      const index = prev.findIndex((item) => item.dev_id === serial);
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = {
        ...next[index],
        status: 'connecting',
        statusSource: 'local',
        ip: normalizedIp,
        errorMsg: '',
      };
      return next;
    });

    try {
      await bambuClient.connectLocal(
        normalizedIp,
        printer.accessCode,
        serial,
        (updatedPrinter) => {
          setPrinters((prev) => {
            const index = prev.findIndex((item) => item.dev_id === updatedPrinter.dev_id);
            if (index === -1) return [...prev, mergePrinterState({}, updatedPrinter)];
            const next = [...prev];
            next[index] = mergePrinterState(next[index], updatedPrinter);
            return next;
          });
        },
        printer.name,
      );
    } catch (err) {
      console.error('Manual connect failed:', err);
      setPrinters((prev) => {
        const index = prev.findIndex((item) => item.dev_id === serial);
        if (index === -1) return prev;
        const next = [...prev];
        next[index] = {
          ...next[index],
          status: 'error',
          ip: normalizedIp,
          errorMsg: err.message || '连接失败',
        };
        return next;
      });
      throw err;
    }
  };

  if (!isConnected) {
    return <ConnectionScreen onConnect={handleConnect} isElectron={isElectron} />;
  }

  return (
    <>
      <PrinterWidget printers={printers} onUpdateIp={handleUpdateIp} />
      {!isElectron && !isPreviewMode ? <MobileDashboard printers={printers} /> : null}
    </>
  );
}

export default App;
