import React, { useEffect, useRef, useState } from 'react';
import { Bell, Copy, LayoutGrid, Lock, Maximize2, Minimize2, Pin, PinOff, Power, RefreshCw, Rows3, Send, Settings } from 'lucide-react';
import { electronEvents, electronWindow, isElectronEnvironment } from '../services/electron';
import {
  buildIntegrationSnippet,
  createDefaultNotificationConfig,
  getNotificationConfig,
  saveNotificationConfig,
  sendTestNotification,
} from '../services/notifications';

const statusMap = {
  no_ip: ['云端概览', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  cloud_overview: ['云端概览', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  cloud_offline: ['云端离线', '#a9b5c7', 'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.12)'],
  connecting: ['连接中...', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  connected: ['已连接', '#89d8ff', 'rgba(91, 177, 255, 0.12)', 'rgba(91, 177, 255, 0.2)'],
  idle: ['闲置', '#dce6f9', 'rgba(255, 255, 255, 0.09)', 'rgba(255, 255, 255, 0.12)'],
  paused: ['已暂停', '#ffd08a', 'rgba(255, 190, 92, 0.14)', 'rgba(255, 190, 92, 0.22)'],
  preparing: ['准备中', '#a5caff', 'rgba(124, 151, 255, 0.14)', 'rgba(124, 151, 255, 0.22)'],
  finished: ['已完成', '#78f0b8', 'rgba(59, 214, 139, 0.14)', 'rgba(59, 214, 139, 0.22)'],
  error: ['异常', '#ff9c9c', 'rgba(255, 107, 107, 0.14)', 'rgba(255, 107, 107, 0.24)'],
  disconnected: ['已断开', '#ff9c9c', 'rgba(255, 107, 107, 0.14)', 'rgba(255, 107, 107, 0.24)'],
};

const dotPalette = [
  ['white', '白', '#f4f6f8'],
  ['black', '黑', '#1e2128'],
  ['silver', '银色', '#aab3be'],
  ['gray', 'grey', '灰', '#8992a0'],
  ['red', '红', '#e85c58'],
  ['green', '绿', '#29bc79'],
  ['blue', '蓝', '#4388f7'],
  ['yellow', '黄', '#f1c44a'],
  ['orange', '橙', '#f08e42'],
  ['purple', 'violet', '紫', '#8b6af2'],
  ['pink', '粉', '#ee78b8'],
  ['brown', '棕', '咖', '#966140'],
  ['gold', '金', '#d0ac4b'],
  ['clear', 'transparent', '透明', '#b7d3ff'],
];

const interactive = {
  WebkitAppRegion: 'no-drag',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  cursor: 'pointer',
  transition: 'all 0.2s ease',
};

const VIEW_MODE_KEY = 'bambu_widget_view_mode';
const ALWAYS_ON_TOP_KEY = 'bambu_widget_always_on_top';
const OPACITY_KEY = 'bambu_widget_opacity';
const MINI_ROTATE_MS = 3000;

function isCloudOverview(printer) {
  return !printer?.ip && (printer?.statusSource === 'cloud' || ['cloud_overview', 'cloud_offline', 'no_ip'].includes(printer?.status));
}

function statusText(printer) {
  if (isCloudOverview(printer)) {
    if (printer.status === 'cloud_offline' || printer.cloudOnline === false) return '云端离线';
    if (printer.status === 'printing') return '云端：打印中';
    if (printer.status === 'paused') return '云端：暂停';
    if (printer.status === 'preparing') return '云端：准备';
    if (printer.status === 'finished') return '云端：完成';
    if (printer.status === 'idle') return '云端：空闲';
    return '云端概览';
  }
  if (printer.status === 'printing') return `${printer.progress || 0}% • ${printer.timeLeft || '--'}`;
  return (statusMap[printer.status] || [printer.status || '--'])[0];
}

function statusStyle(printer) {
  const [, color = '#dce6f9', background = 'rgba(255,255,255,0.09)', border = 'rgba(255,255,255,0.12)'] = statusMap[printer.status] || [];
  return { color, background, border };
}

function trayColor(tray) {
  const raw = String(tray?.color || '').replace('#', '').trim();
  if (raw.length === 8 && raw.slice(0, 6) !== '000000') return `#${raw.slice(0, 6)}`;
  if (raw.length === 6 && raw !== '000000') return `#${raw}`;
  const text = `${tray?.name || ''} ${tray?.subBrand || ''} ${tray?.type || ''}`.toLowerCase();
  const match = dotPalette.find((rule) => rule.slice(0, -1).some((key) => text.includes(key)));
  return match ? match[match.length - 1] : '#546175';
}

function amsInfo(printer) {
  const units = printer?.ams?.units;
  if (!Array.isArray(units) || units.length === 0) return { text: '', trays: [] };
  const active = units.find((unit) => unit.index === printer.ams.activeAmsIndex) || units[0];
  const parts = [];
  if (Number.isFinite(active?.humidityRaw) && active.humidityRaw > 0) parts.push(`湿度 ${active.humidityRaw}%`);
  else if (Number.isFinite(active?.humidityIndex) && active.humidityIndex > 0) parts.push(`湿度等级 ${active.humidityIndex}`);
  if (active?.activeTray && Number.isFinite(active.activeTray.remain) && active.activeTray.remain >= 0) {
    const remain = active.activeTray.remain;
    const weight = Number(active.activeTray.trayWeight);
    parts.push(Number.isFinite(weight) && weight > 0 ? `余量 ${remain}% (${Math.round((weight * remain) / 100)}g)` : `余量 ${remain}%`);
  }

  const trays = units
    .flatMap((unit) => unit.trays || [])
    .filter((tray) => Number.isFinite(tray?.id))
    .slice(0, 8)
    .map((tray) => ({
      id: tray.id,
      remain: Number.isFinite(Number(tray.remain)) ? Number(tray.remain) : null,
      color: trayColor(tray),
    }));

  return { text: parts.join(' · '), trays };
}

function infoLine(printer) {
  if (isCloudOverview(printer)) {
    const cloudLabel = statusText(printer).replace('云端：', '');
    return {
      left: cloudLabel === '云端概览' ? '云端概览模式' : `云端状态：${cloudLabel}`,
      right: '温度 / AMS / 层数需本地实时连接',
    };
  }

  const left = printer.filename || '等待任务下发';
  const right = [];
  if (printer.layer) right.push(`层 ${printer.layer}`);
  if (printer.speed) right.push(`速度 ${printer.speed}%`);
  return { left, right: right.join(' · ') || `预计剩余 ${printer.timeLeft || '--'}` };
}

function safeProgress(value) {
  return Math.max(0, Math.min(Number(value) || 0, 100));
}

function formatTemperatureValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric)}°` : '--';
}

function temperatureText(printer) {
  if (isCloudOverview(printer)) return '云端状态 · 非实时遥测';
  const temperature = printer.temperature || {};
  return `喷嘴 ${formatTemperatureValue(temperature.nozzle)} · 热床 ${formatTemperatureValue(temperature.bed)}`;
}

function isFinishedPrinter(printer) {
  return printer.status === 'finished' || safeProgress(printer.progress) >= 100;
}

function miniRemainingText(printer) {
  if (!printer) return '--';
  if (isCloudOverview(printer)) return statusText(printer).replace('云端：', '');
  if (printer.timeLeft && printer.timeLeft !== '--') return printer.timeLeft;
  return statusMap[printer.status]?.[0] || '--';
}

function miniRingState(printer) {
  const progress = safeProgress(printer?.progress);
  if (isCloudOverview(printer)) {
    const offline = printer.status === 'cloud_offline' || printer.cloudOnline === false;
    if (printer.status === 'finished') {
      return {
        progress: 100,
        label: '完成',
        color: '#78f0b8',
        glow: 'rgba(120, 240, 184, 0.34)',
        track: 'rgba(120, 240, 184, 0.14)',
      };
    }
    return {
      progress: offline ? 100 : Math.max(16, progress),
      label: offline ? '离线' : miniRemainingText(printer),
      color: offline ? '#a9b5c7' : '#8cc8ff',
      glow: offline ? 'rgba(169, 181, 199, 0.2)' : 'rgba(102, 178, 255, 0.3)',
      track: offline ? 'rgba(255,255,255,0.1)' : 'rgba(102, 178, 255, 0.14)',
    };
  }

  if (['error', 'disconnected'].includes(printer?.status)) {
    return {
      progress: 100,
      label: '故障',
      color: '#ff6b6b',
      glow: 'rgba(255, 107, 107, 0.34)',
      track: 'rgba(255, 107, 107, 0.16)',
    };
  }
  if (isFinishedPrinter(printer)) {
    return {
      progress: 100,
      label: '完成',
      color: '#78f0b8',
      glow: 'rgba(120, 240, 184, 0.34)',
      track: 'rgba(120, 240, 184, 0.14)',
    };
  }
  return {
    progress,
    label: miniRemainingText(printer),
    color: progressPalette(printer?.status || 'idle').text,
    glow: progressPalette(printer?.status || 'idle').glow,
    track: 'rgba(255,255,255,0.12)',
  };
}

function progressPalette(status) {
  switch (status) {
    case 'printing':
      return {
        text: '#d8fff1',
        badge: 'rgba(74, 226, 170, 0.14)',
        border: 'rgba(112, 238, 194, 0.22)',
        track: 'linear-gradient(180deg, rgba(13, 29, 37, 0.96), rgba(8, 17, 27, 0.98))',
        fill: 'linear-gradient(90deg, #55e4a5 0%, #6cf1cb 45%, #7faeff 100%)',
        glow: 'rgba(83, 235, 183, 0.34)',
        cap: '#ebfffb',
      };
    case 'finished':
      return {
        text: '#dfffea',
        badge: 'rgba(84, 226, 151, 0.14)',
        border: 'rgba(120, 240, 181, 0.22)',
        track: 'linear-gradient(180deg, rgba(15, 28, 24, 0.96), rgba(10, 19, 17, 0.98))',
        fill: 'linear-gradient(90deg, #58d98b 0%, #7aefb6 48%, #9bffda 100%)',
        glow: 'rgba(88, 226, 145, 0.26)',
        cap: '#effff5',
      };
    case 'paused':
      return {
        text: '#ffe4bd',
        badge: 'rgba(255, 186, 92, 0.14)',
        border: 'rgba(255, 196, 118, 0.22)',
        track: 'linear-gradient(180deg, rgba(35, 24, 12, 0.96), rgba(24, 16, 8, 0.98))',
        fill: 'linear-gradient(90deg, #f0a642 0%, #ffd072 54%, #ffe2a1 100%)',
        glow: 'rgba(255, 188, 95, 0.26)',
        cap: '#fff3da',
      };
    case 'preparing':
    case 'connecting':
      return {
        text: '#dfeeff',
        badge: 'rgba(113, 175, 255, 0.14)',
        border: 'rgba(131, 192, 255, 0.22)',
        track: 'linear-gradient(180deg, rgba(16, 25, 40, 0.96), rgba(9, 15, 26, 0.98))',
        fill: 'linear-gradient(90deg, #69a9ff 0%, #7bc7ff 55%, #99e1ff 100%)',
        glow: 'rgba(111, 178, 255, 0.24)',
        cap: '#eef6ff',
      };
    case 'error':
    case 'disconnected':
    case 'no_ip':
      return {
        text: '#ffd8d8',
        badge: 'rgba(255, 120, 120, 0.12)',
        border: 'rgba(255, 146, 146, 0.2)',
        track: 'linear-gradient(180deg, rgba(39, 20, 22, 0.96), rgba(24, 12, 14, 0.98))',
        fill: 'linear-gradient(90deg, #ff7c7c 0%, #ff9f7d 52%, #ffd18f 100%)',
        glow: 'rgba(255, 126, 126, 0.22)',
        cap: '#fff0ee',
      };
    default:
      return {
        text: '#eef5ff',
        badge: 'rgba(255, 255, 255, 0.08)',
        border: 'rgba(255, 255, 255, 0.14)',
        track: 'linear-gradient(180deg, rgba(17, 26, 39, 0.96), rgba(10, 16, 26, 0.98))',
        fill: 'linear-gradient(90deg, #90a3bf 0%, #a9bbd4 52%, #c6d7ee 100%)',
        glow: 'rgba(188, 205, 228, 0.18)',
        cap: '#f8fbff',
      };
  }
}

function ProgressBar({ progress, status = 'idle', compact = false }) {
  const safeProgress = Math.max(0, Math.min(Number(progress) || 0, 100));
  const palette = progressPalette(status);
  const height = compact ? 8 : 10;
  const capSize = compact ? 10 : 14;
  const segmentWidth = compact ? 20 : 24;

  return (
    <div
      style={{
        position: 'relative',
        height,
        overflow: 'hidden',
        borderRadius: 999,
        background: palette.track,
        border: `1px solid ${palette.border}`,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -8px 16px rgba(3,9,18,0.42)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.13), rgba(255,255,255,0) 46%)',
          opacity: 0.6,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.07) 0 1px, transparent 1px ${segmentWidth}px)`,
          opacity: 0.32,
        }}
      />
      <div
        style={{
          position: 'relative',
          width: `${safeProgress}%`,
          height: '100%',
          borderRadius: 999,
          background: palette.fill,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.08), 0 0 22px ${palette.glow}`,
          overflow: 'visible',
          transition: 'width 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            background: 'linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0.04) 42%, rgba(255,255,255,0) 100%)',
            opacity: 0.56,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            backgroundImage: 'repeating-linear-gradient(112deg, rgba(255,255,255,0.24) 0 12px, rgba(255,255,255,0.04) 12px 22px)',
            opacity: status === 'printing' ? 0.36 : 0.18,
            mixBlendMode: 'screen',
          }}
        />
        {safeProgress > 2 ? (
          <div
            style={{
              position: 'absolute',
              right: compact ? 1 : 2,
              top: '50%',
              transform: 'translate(50%, -50%)',
              width: capSize,
              height: capSize,
              borderRadius: '50%',
              background: `radial-gradient(circle at 35% 35%, ${palette.cap} 0%, rgba(255,255,255,0.92) 28%, rgba(255,255,255,0.18) 62%, transparent 70%)`,
              boxShadow: `0 0 0 1px rgba(255,255,255,0.16), 0 0 ${compact ? 10 : 16}px ${palette.glow}`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function StatusBadge({ printer, compact = false }) {
  const { color, background, border } = statusStyle(printer);
  return (
    <span
      style={{
        ...interactive,
        minWidth: compact ? 90 : 104,
        minHeight: compact ? 30 : 32,
        padding: compact ? '0 10px' : '0 12px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        color,
        background,
        border: `1px solid ${border}`,
      }}
    >
      {statusText(printer)}
    </span>
  );
}

async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error('当前系统阻止了剪贴板写入');
  }
}

export default function PrinterWidget({ printers, onUpdateIp }) {
  const [isLocked, setIsLocked] = useState(false);
  const [isHorizontal, setIsHorizontal] = useState(false);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem(VIEW_MODE_KEY) || 'full');
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(() => localStorage.getItem(ALWAYS_ON_TOP_KEY) !== 'false');
  const [windowOpacity, setWindowOpacityState] = useState(() => {
    const stored = Number(localStorage.getItem(OPACITY_KEY));
    return Number.isFinite(stored) && stored >= 0.5 && stored <= 1 ? stored : 1;
  });
  const [miniActiveIndex, setMiniActiveIndex] = useState(0);
  const [ipDialog, setIpDialog] = useState(null);
  const [ipDialogError, setIpDialogError] = useState('');
  const [submittingIp, setSubmittingIp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationConfig, setNotificationConfig] = useState(() => createDefaultNotificationConfig());
  const [notificationFeedback, setNotificationFeedback] = useState('');
  const [testingTargetId, setTestingTargetId] = useState('');
  const widgetRef = useRef(null);
  const lastResizeRef = useRef({ width: 0, height: 0 });

  const isCompact = viewMode === 'compact';
  const isMini = viewMode === 'mini';
  const onlineCount = printers.filter((printer) => !['error', 'disconnected', 'cloud_offline'].includes(printer.status) && printer.cloudOnline !== false).length;
  const printingCount = printers.filter((printer) => printer.status === 'printing').length;
  const cloudOverviewCount = printers.filter((printer) => isCloudOverview(printer)).length;
  const finishedPrinters = printers.filter((printer) => isFinishedPrinter(printer));
  const activeMiniPrinters = printers.filter((printer) => !isFinishedPrinter(printer));
  const rotatingMiniPrinter = activeMiniPrinters.length > 0
    ? activeMiniPrinters[miniActiveIndex % activeMiniPrinters.length]
    : null;
  const compactProgress = printers.length > 0
    ? Math.round(printers.reduce((sum, printer) => sum + safeProgress(printer.progress), 0) / printers.length)
    : 0;
  const miniAutoSize = isMini && !settingsOpen && !ipDialog;
  const panelWidth = settingsOpen ? 432 : (ipDialog ? 360 : (isCompact ? 396 : (isHorizontal ? Math.min(120 + Math.max(printers.length, 1) * 232, 1600) : 432)));

  useEffect(() => {
    if (!isElectronEnvironment()) return undefined;
    const offLock = electronEvents.onLockStatusChanged((locked) => setIsLocked(locked));
    const offLayout = electronEvents.onToggleLayout(() => setIsHorizontal((prev) => !prev));
    const offTop = electronEvents.onAlwaysOnTopChanged((flag) => setIsAlwaysOnTop(Boolean(flag)));
    const offOpacity = electronEvents.onWindowOpacityChanged((opacity) => {
      const next = Number(opacity);
      if (Number.isFinite(next)) setWindowOpacityState(next);
    });
    return () => {
      offLock();
      offLayout();
      offTop();
      offOpacity();
    };
  }, []);

  useEffect(() => {
    if (!['full', 'compact', 'mini'].includes(viewMode)) {
      setViewMode('full');
      return;
    }
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem(ALWAYS_ON_TOP_KEY, String(isAlwaysOnTop));
    electronWindow.setAlwaysOnTop(isAlwaysOnTop);
  }, [isAlwaysOnTop]);

  useEffect(() => {
    localStorage.setItem(OPACITY_KEY, String(windowOpacity));
    electronWindow.setOpacity(windowOpacity);
  }, [windowOpacity]);

  useEffect(() => {
    if (!isMini || activeMiniPrinters.length <= 1) {
      setMiniActiveIndex(0);
      return undefined;
    }

    const timer = setInterval(() => {
      setMiniActiveIndex((prev) => (prev + 1) % activeMiniPrinters.length);
    }, MINI_ROTATE_MS);

    return () => clearInterval(timer);
  }, [isMini, activeMiniPrinters.length]);

  useEffect(() => {
    setNotificationConfig(getNotificationConfig());
  }, []);

  useEffect(() => {
    if (!isElectronEnvironment()) return;
    const node = widgetRef.current;
    if (!node) return undefined;

    let frameId = 0;
    const measureAndResize = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const measuredWidth = Math.ceil(rect.width);
        const measuredHeight = Math.ceil(node.scrollHeight || rect.height);
        const minWindowWidth = miniAutoSize ? 1 : (isCompact ? 360 : 320);
        const minWindowHeight = miniAutoSize ? 1 : 80;
        const width = Math.max(minWindowWidth, measuredWidth);
        const height = Math.max(minWindowHeight, measuredHeight);

        if (
          Math.abs(lastResizeRef.current.width - width) > 1
          || Math.abs(lastResizeRef.current.height - height) > 1
        ) {
          lastResizeRef.current = { width, height };
          electronWindow.resize({ width, height });
        }
      });
    };

    measureAndResize();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frameId) cancelAnimationFrame(frameId);
      };
    }

    const observer = new ResizeObserver(measureAndResize);
    observer.observe(node);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [printers.length, miniAutoSize, isCompact, isHorizontal, ipDialog, settingsOpen, panelWidth, finishedPrinters.length, activeMiniPrinters.length]);

  const openIpDialog = (printer) => {
    setIpDialog({ serial: printer.dev_id, name: printer.name, value: printer.ip || '' });
    setIpDialogError('');
  };

  const closeIpDialog = () => {
    if (!submittingIp) {
      setIpDialog(null);
      setIpDialogError('');
    }
  };

  const submitIpDialog = async (event) => {
    event.preventDefault();
    if (!ipDialog) return;
    const value = String(ipDialog.value || '').trim();
    if (!value) {
      setIpDialogError('请输入当前电脑可访问的打印机 IP，例如 192.168.1.100 或 VPN/Tailscale IP');
      return;
    }
    setSubmittingIp(true);
    setIpDialogError('');
    try {
      await onUpdateIp(ipDialog.serial, value);
      setIpDialog(null);
    } catch (error) {
      setIpDialogError(error?.message || '连接失败，请检查 IP 或访问码');
    } finally {
      setSubmittingIp(false);
    }
  };

  const updateNotificationConfig = (updater) => {
    setNotificationFeedback('');
    setNotificationConfig((prev) => {
      const base = prev || createDefaultNotificationConfig();
      return typeof updater === 'function' ? updater(base) : { ...base, ...updater };
    });
  };

  const updateNotificationTarget = (targetId, patch) => {
    updateNotificationConfig((prev) => ({
      ...prev,
      targets: prev.targets.map((target) => (
        target.id === targetId ? { ...target, ...patch } : target
      )),
    }));
  };

  const saveNotificationSettings = () => {
    saveNotificationConfig(notificationConfig);
    setNotificationFeedback('通知设置已保存');
  };

  const testNotificationTarget = async (target) => {
    setTestingTargetId(target.id);
    setNotificationFeedback('');
    try {
      const result = await sendTestNotification(target);
      const failed = result?.results?.find((item) => !item.success);
      if (failed) {
        setNotificationFeedback(`${target.name} 测试失败：${failed.error || failed.status || '未知错误'}`);
      } else {
        setNotificationFeedback(`${target.name} 测试通知已发送`);
      }
    } catch (error) {
      setNotificationFeedback(`${target.name} 测试失败：${error?.message || '未知错误'}`);
    } finally {
      setTestingTargetId('');
    }
  };

  const copyIntegrationCode = async (target) => {
    try {
      await copyTextToClipboard(buildIntegrationSnippet(target));
      setNotificationFeedback(`${target.name} 接入代码已复制：发给那边 AI 运行后，把返回的 Webhook URL 填到这里`);
    } catch (error) {
      setNotificationFeedback(`复制失败：${error?.message || '请手动复制 docs/ai-webhook-connector.md'}`);
    }
  };

  const renderCloudNotice = (compact = false) => {
    if (cloudOverviewCount === 0) return null;
    return (
      <div
        style={{
          padding: compact ? '9px 10px' : '10px 12px',
          borderRadius: compact ? 13 : 14,
          background: 'linear-gradient(135deg, rgba(102,178,255,0.12), rgba(126,240,196,0.08))',
          border: '1px solid rgba(135,195,255,0.18)',
          color: 'rgba(226,238,255,0.78)',
          fontSize: compact ? 10 : 11,
          lineHeight: 1.55,
        }}
      >
        {cloudOverviewCount} 台处于云端概览：可看云端在线/打印状态；温度、AMS、层数和精确进度需要本地或 VPN 实时连接。
        <br />
        官方远程视图请使用 Bambu Connect / Bambu Handy；本工具不读取私有网络插件数据。
      </div>
    );
  };

  const toggleAlwaysOnTop = () => {
    setIsAlwaysOnTop((prev) => !prev);
  };

  const updateWindowOpacity = (value) => {
    const next = Math.min(1, Math.max(0.5, Number(value) || 1));
    setWindowOpacityState(next);
  };

  const lockMousePassthrough = () => {
    if (isLocked) return;
    setIsLocked(true);
    electronWindow.setIgnoreMouseEvents(true);
  };

  const renderTopButton = (size = 34) => (
    <button
      type="button"
      onClick={toggleAlwaysOnTop}
      title={isAlwaysOnTop ? '取消窗口置顶' : '窗口置顶'}
      style={{
        ...interactive,
        width: size,
        height: size,
        borderRadius: size <= 28 ? 8 : (size <= 30 ? 10 : 11),
        color: isAlwaysOnTop ? '#8df0c0' : 'rgba(246,250,255,0.88)',
        background: isAlwaysOnTop ? 'rgba(86,226,168,0.15)' : 'rgba(255,255,255,0.08)',
        border: isAlwaysOnTop ? '1px solid rgba(86,226,168,0.26)' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      {isAlwaysOnTop ? <Pin size={size <= 24 ? 12 : (size <= 30 ? 13 : 15)} /> : <PinOff size={size <= 24 ? 12 : (size <= 30 ? 13 : 15)} />}
    </button>
  );

  const renderOpacityControl = () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ fontSize: 12, color: 'rgba(203,217,239,0.72)', fontWeight: 700 }}>窗口透明度</div>
      <input
        type="range"
        min="50"
        max="100"
        value={Math.round(windowOpacity * 100)}
        onChange={(event) => updateWindowOpacity(Number(event.target.value) / 100)}
        style={{ width: '100%', accentColor: '#7ef0c4' }}
      />
      <div style={{ width: 36, textAlign: 'right', fontSize: 12, color: '#eaf7ff', fontWeight: 800 }}>
        {Math.round(windowOpacity * 100)}%
      </div>
    </div>
  );

  const renderMiniRow = (printer, options = {}) => {
    const done = isFinishedPrinter(printer);
    const palette = progressPalette(printer?.status || 'idle');
    const ring = miniRingState(printer);
    const ringSize = 30;
    const ringStroke = 3;
    const ringRadius = (ringSize - ringStroke) / 2;
    const ringCircumference = 2 * Math.PI * ringRadius;
    const ringDashOffset = ringCircumference * (1 - ring.progress / 100);
    const activeChrome = options.active && !options.bare;
    return (
      <div
        key={`${options.active ? 'active' : 'done'}-${printer.dev_id}`}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          alignItems: 'center',
          gap: 8,
          minHeight: 22,
          width: 'max-content',
          maxWidth: '100%',
          padding: options.bare ? 0 : (activeChrome ? '5px 8px' : '2px 0'),
          borderRadius: 9,
          background: activeChrome ? 'rgba(255,255,255,0.065)' : 'transparent',
          border: activeChrome ? `1px solid ${palette.border}` : '1px solid transparent',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: done ? '#8df0c0' : palette.text, boxShadow: `0 0 9px ${done ? 'rgba(141,240,192,0.35)' : palette.glow}`, flex: '0 0 auto' }} />
          <span style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: '#f7fbff', fontSize: 11, fontWeight: 800 }}>
            {printer.name || '未命名打印机'}
          </span>
          <span
            aria-label={`${printer.name || '打印机'} ${ring.label}`}
            style={{
              position: 'relative',
              width: ringSize,
              height: ringSize,
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginLeft: 1,
            }}
          >
            <svg width={ringSize} height={ringSize} viewBox={`0 0 ${ringSize} ${ringSize}`} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
              <circle
                cx={ringSize / 2}
                cy={ringSize / 2}
                r={ringRadius}
                fill="none"
                stroke={ring.track}
                strokeWidth={ringStroke}
              />
              <circle
                cx={ringSize / 2}
                cy={ringSize / 2}
                r={ringRadius}
                fill="none"
                stroke={ring.color}
                strokeWidth={ringStroke}
                strokeLinecap="round"
                strokeDasharray={ringCircumference}
                strokeDashoffset={ringDashOffset}
                style={{
                  filter: `drop-shadow(0 0 4px ${ring.glow})`,
                  transition: 'stroke-dashoffset 0.45s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.2s ease',
                }}
              />
            </svg>
            <span style={{ position: 'relative', zIndex: 1, color: ring.color, fontSize: ring.label.length > 5 ? 6 : (ring.label.length > 3 ? 7 : 8), lineHeight: 1, fontWeight: 900, letterSpacing: '-0.04em' }}>
              {ring.label}
            </span>
          </span>
        </div>
      </div>
    );
  };

  const renderMiniActiveSlot = () => {
    if (!rotatingMiniPrinter) return null;

    return (
      <div
        style={{
          display: 'grid',
          width: 'max-content',
          maxWidth: '100%',
          padding: '5px 8px',
          borderRadius: 11,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.062), rgba(255,255,255,0.038))',
          border: '1px solid rgba(126,240,196,0.2)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      >
        {activeMiniPrinters.map((printer) => (
          <div key={`mini-size-${printer.dev_id}`} style={{ gridArea: '1 / 1', visibility: 'hidden' }}>
            {renderMiniRow(printer, { bare: true })}
          </div>
        ))}
        <div key={`mini-active-${rotatingMiniPrinter.dev_id}`} style={{ gridArea: '1 / 1' }}>
          {renderMiniRow(rotatingMiniPrinter, { bare: true })}
        </div>
      </div>
    );
  };

  const renderAction = (printer, compact = false) => {
    const buttonStyle = {
      ...interactive,
      minWidth: compact ? 92 : 102,
      height: compact ? 30 : 32,
      padding: compact ? '0 10px' : '0 12px',
      borderRadius: 999,
      fontSize: 12,
      fontWeight: 600,
    };

    if (isCloudOverview(printer) || printer.status === 'no_ip') {
      return (
        <button
          type="button"
          onClick={() => openIpDialog(printer)}
          style={{ ...buttonStyle, color: '#ffd287', background: 'rgba(255,183,77,0.14)', border: '1px solid rgba(255,183,77,0.24)' }}
          title="填写当前电脑可访问的 IP，切换为完整实时监控"
        >
          连实时
        </button>
      );
    }

    if ((printer.status === 'error' || printer.status === 'disconnected') && printer.ip) {
      return (
        <button
          type="button"
          onClick={() => onUpdateIp(printer.dev_id, printer.ip)}
          style={{ ...buttonStyle, color: '#9ac8ff', background: 'rgba(70,136,255,0.14)', border: '1px solid rgba(70,136,255,0.22)' }}
          title={printer.errorMsg || '重新连接打印机'}
        >
          <RefreshCw size={13} />
          重连
        </button>
      );
    }

    return <StatusBadge printer={printer} compact={compact} />;
  };

  return (
    <div
      ref={widgetRef}
      style={{
        position: 'relative',
        width: miniAutoSize ? 'fit-content' : panelWidth,
        minWidth: miniAutoSize ? 0 : (isCompact ? 360 : 220),
        minHeight: settingsOpen ? 640 : (ipDialog ? 240 : undefined),
        padding: isMini ? '9px 10px' : (isCompact ? '12px 14px' : '18px 18px 14px'),
        borderRadius: 0,
        background: 'radial-gradient(circle at top left, rgba(104,196,255,0.16), transparent 34%), radial-gradient(circle at top right, rgba(118,255,181,0.14), transparent 28%), linear-gradient(160deg, rgba(10,17,28,0.97) 0%, rgba(14,23,37,0.95) 42%, rgba(8,13,24,0.98) 100%)',
        boxShadow: '0 18px 48px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 0 0 1px rgba(255,255,255,0.06)',
        color: '#fff',
        cursor: isLocked ? 'default' : 'move',
        WebkitAppRegion: isLocked ? 'no-drag' : 'drag',
        overflow: settingsOpen || ipDialog ? 'hidden' : 'visible',
      }}
    >
      {isMini ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-start', gap: 5, WebkitAppRegion: 'no-drag' }}>
            <button type="button" onClick={() => setViewMode('compact')} title="返回紧凑模式" style={{ ...interactive, width: 24, height: 24, borderRadius: 8, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
              <Maximize2 size={12} />
            </button>
            {renderTopButton(24)}
            <button type="button" onClick={() => setSettingsOpen(true)} title="通知与透明度" style={{ ...interactive, width: 24, height: 24, borderRadius: 8, color: notificationConfig.enabled ? '#8df0c0' : 'rgba(246,250,255,0.88)', background: notificationConfig.enabled ? 'rgba(86,226,168,0.14)' : 'rgba(255,255,255,0.08)', border: notificationConfig.enabled ? '1px solid rgba(86,226,168,0.24)' : '1px solid rgba(255,255,255,0.1)' }}>
              <Settings size={12} />
            </button>
          </div>

          {printers.length === 0 ? (
            <div style={{ padding: '10px 9px', textAlign: 'center', color: 'rgba(225,234,248,0.68)', fontSize: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
              正在同步设备...
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {finishedPrinters.map((printer) => renderMiniRow(printer))}
              {renderMiniActiveSlot()}
            </div>
          )}
        </div>
      ) : isCompact ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr auto', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 42, height: 42, borderRadius: 14, background: 'linear-gradient(135deg, rgba(126,240,196,0.28), rgba(139,195,255,0.2))', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dff8ff', fontSize: 12, fontWeight: 800, letterSpacing: '0.12em' }}>
              BM
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#f7fbff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {printers.length > 0 ? `${printers.length} 台打印机 · ${onlineCount} 台在线` : 'Bambu Monitor'}
                </div>
                <div style={{ flex: '0 0 auto', fontSize: 11, color: printingCount > 0 ? '#80f6b8' : 'rgba(203,217,239,0.62)' }}>
                  {printingCount > 0 ? `${printingCount} 台打印中` : '全部总览'}
                </div>
              </div>
              <div style={{ marginTop: 7 }}>
                <ProgressBar progress={compactProgress} status={printingCount > 0 ? 'printing' : 'idle'} compact />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 7, WebkitAppRegion: 'no-drag' }}>
              <button type="button" onClick={() => setViewMode('full')} title="展开监控面板" style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <Maximize2 size={14} />
              </button>
              <button type="button" onClick={() => setViewMode('mini')} title="切换为超迷你模式" style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <Minimize2 size={14} />
              </button>
              {renderTopButton(30)}
              <button type="button" onClick={() => setSettingsOpen(true)} title="通知设置" style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: notificationConfig.enabled ? '#8df0c0' : 'rgba(246,250,255,0.88)', background: notificationConfig.enabled ? 'rgba(86,226,168,0.14)' : 'rgba(255,255,255,0.08)', border: notificationConfig.enabled ? '1px solid rgba(86,226,168,0.24)' : '1px solid rgba(255,255,255,0.1)' }}>
                <Bell size={14} />
              </button>
              <button
                type="button"
                onClick={lockMousePassthrough}
                disabled={isLocked}
                title={isLocked ? '已锁定，使用 Ctrl+Shift+L 或托盘解除' : '锁定鼠标穿透'}
                style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: isLocked ? '#ffcf82' : 'rgba(246,250,255,0.88)', background: isLocked ? 'rgba(255,183,77,0.14)' : 'rgba(255,255,255,0.08)', border: isLocked ? '1px solid rgba(255,183,77,0.22)' : '1px solid rgba(255,255,255,0.1)', opacity: isLocked ? 0.62 : 1, cursor: isLocked ? 'default' : 'pointer' }}
              >
                <Lock size={14} />
              </button>
            </div>
          </div>

          {renderCloudNotice(true)}

          {printers.length === 0 ? (
            <div style={{ padding: '14px 12px', textAlign: 'center', color: 'rgba(225,234,248,0.68)', fontSize: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 14, border: '1px solid rgba(255,255,255,0.06)' }}>
              正在同步设备...
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {printers.map((printer) => {
                const progress = safeProgress(printer.progress);
                const progressMeta = progressPalette(printer.status);
                const meta = infoLine(printer);

                return (
                  <div
                    key={printer.dev_id}
                    style={{
                      padding: '10px 11px',
                      borderRadius: 15,
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.045))',
                      border: '1px solid rgba(255,255,255,0.08)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
                    }}
                  >
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#f7fbff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {printer.name || '未命名打印机'}
                        </div>
                        <div style={{ marginTop: 3, fontSize: 10, color: 'rgba(200,214,234,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {meta.left}
                        </div>
                      </div>
                      {renderAction(printer, true)}
                    </div>

                    <div style={{ marginTop: 8 }}>
                      <ProgressBar progress={progress} status={printer.status} compact />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8, marginTop: 7, fontSize: 10, color: 'rgba(205,220,241,0.68)' }}>
                      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.right}</span>
                      <span style={{ color: progressMeta.text, whiteSpace: 'nowrap' }}>{temperatureText(printer)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, lineHeight: 1.2, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(185,205,235,0.64)', marginBottom: 7 }}>
                Bambu Monitor
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#f7fbff' }}>
                {printers.length > 0 ? `${printers.length} 台打印机 · ${onlineCount} 台在线` : '正在准备打印机数据'}
              </div>
              <div style={{ marginTop: 5, fontSize: 11, color: 'rgba(203,217,239,0.58)' }}>
                {cloudOverviewCount > 0 ? '云端概览 + 本地实时混合模式' : (isHorizontal ? '横向总览模式' : '纵向实时监控模式')}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, WebkitAppRegion: 'no-drag' }}>
              <button type="button" onClick={() => setViewMode('compact')} title="切换为紧凑模式" style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <Minimize2 size={16} />
              </button>
              {renderTopButton(34)}
              <button
                type="button"
                onClick={() => setIsHorizontal((prev) => !prev)}
                title={isHorizontal ? '切换为竖向' : '切换为横向'}
                style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                {isHorizontal ? <Rows3 size={16} /> : <LayoutGrid size={16} />}
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="通知与集成设置"
                style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: notificationConfig.enabled ? '#8df0c0' : 'rgba(246,250,255,0.88)', background: notificationConfig.enabled ? 'rgba(86,226,168,0.14)' : 'rgba(255,255,255,0.08)', border: notificationConfig.enabled ? '1px solid rgba(86,226,168,0.24)' : '1px solid rgba(255,255,255,0.1)' }}
              >
                <Bell size={16} />
              </button>
              <button
                type="button"
                onClick={lockMousePassthrough}
                disabled={isLocked}
                title={isLocked ? '已锁定，使用 Ctrl+Shift+L 或托盘解除' : '锁定鼠标穿透'}
                style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: isLocked ? '#ffcf82' : 'rgba(246,250,255,0.88)', background: isLocked ? 'rgba(255,183,77,0.14)' : 'rgba(255,255,255,0.08)', border: isLocked ? '1px solid rgba(255,183,77,0.22)' : '1px solid rgba(255,255,255,0.1)', opacity: isLocked ? 0.62 : 1, cursor: isLocked ? 'default' : 'pointer' }}
              >
                <Lock size={16} />
              </button>
              <button
                type="button"
                onClick={() => electronWindow.quit()}
                title="退出应用"
                style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: '#ff9f9f', background: 'rgba(255,107,107,0.12)', border: '1px solid rgba(255,107,107,0.2)' }}
              >
                <Power size={16} />
              </button>
            </div>
          </div>

          {renderCloudNotice()}

          {printers.length === 0 ? (
            <div style={{ padding: '24px 18px', textAlign: 'center', color: 'rgba(225,234,248,0.68)', fontSize: 13, background: 'rgba(255,255,255,0.05)', borderRadius: 16, border: '1px solid rgba(255,255,255,0.06)' }}>
              正在同步云端设备并等待本地遥测...
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: isHorizontal ? 'row' : 'column', gap: isHorizontal ? 12 : 10, alignItems: 'stretch' }}>
              {printers.map((printer) => {
                const ams = amsInfo(printer);
                const meta = infoLine(printer);
                const progress = safeProgress(printer.progress);
                const progressMeta = progressPalette(printer.status);

                return (
                  <div
                    key={printer.dev_id}
                    style={{
                      flex: isHorizontal ? '0 0 212px' : '1 1 auto',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      padding: '14px',
                      borderRadius: 16,
                      background: 'linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.04))',
                      border: '1px solid rgba(255,255,255,0.08)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#f7fbff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {printer.name || '未命名打印机'}
                        </div>
                        <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(200,214,234,0.58)' }}>
                          {printer.ip ? `IP ${printer.ip}` : (isCloudOverview(printer) ? '云端概览 · 连实时需填写可访问 IP' : '等待填写可访问 IP')}
                        </div>
                      </div>
                      {renderAction(printer, isHorizontal)}
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7, fontSize: 11, color: 'rgba(226,235,248,0.72)' }}>
                        <span style={{ maxWidth: isHorizontal ? 118 : 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {meta.left}
                        </span>
                        <span
                          style={{
                            padding: '4px 8px',
                            borderRadius: 999,
                            color: progressMeta.text,
                            background: progressMeta.badge,
                            border: `1px solid ${progressMeta.border}`,
                            fontWeight: 700,
                            letterSpacing: '0.02em',
                          }}
                        >
                          {isCloudOverview(printer) ? statusText(printer).replace('云端：', '') : `${progress}%`}
                        </span>
                      </div>
                      <ProgressBar progress={progress} status={printer.status} />
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: isHorizontal ? '1fr' : '1fr auto', gap: '6px 10px', alignItems: 'center' }}>
                      <div style={{ fontSize: 11, color: 'rgba(226,235,248,0.72)' }}>{meta.right}</div>
                      <div style={{ fontSize: 11, color: 'rgba(172,191,216,0.64)', justifySelf: isHorizontal ? 'start' : 'end' }}>
                        {temperatureText(printer)}
                      </div>
                    </div>

                    {ams.text ? (
                      <div style={{ padding: '9px 10px', borderRadius: 12, background: 'rgba(118,143,179,0.12)', color: 'rgba(229,239,255,0.78)', fontSize: 11, lineHeight: 1.5 }}>
                        {ams.text}
                      </div>
                    ) : null}

                    {ams.trays.length > 0 ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {ams.trays.map((tray) => (
                          <div key={`${printer.dev_id}-${tray.id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)', fontSize: 10, color: 'rgba(236,243,255,0.8)' }}>
                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: tray.color, border: '1px solid rgba(255,255,255,0.24)' }} />
                            <span>{tray.remain === null ? '--' : `${tray.remain}%`}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {printer.errorMsg ? (
                      <div style={{ fontSize: 11, color: '#ffb1b1', background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.16)', borderRadius: 12, padding: '8px 10px', lineHeight: 1.5 }}>
                        {printer.errorMsg}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 12, textAlign: 'center', color: 'rgba(203,217,239,0.48)', fontSize: 10 }}>
            Ctrl+Shift+L 切换穿透 · {isLocked ? '当前已锁定鼠标穿透' : '可拖拽移动窗口'}
          </div>
        </>
      )}

      {settingsOpen ? (
        <div style={{ position: 'absolute', inset: 0, padding: 18, background: 'rgba(5,8,15,0.62)', backdropFilter: 'blur(14px)', borderRadius: 0, WebkitAppRegion: 'no-drag', overflow: 'hidden' }}>
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 14, padding: 18, borderRadius: 18, background: 'linear-gradient(180deg, rgba(18,28,44,0.98), rgba(10,16,27,0.98))', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 20px 52px rgba(0,0,0,0.38)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: '#f7fbff' }}>
                  <Settings size={16} />
                  通知与集成
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(203,217,239,0.66)', lineHeight: 1.5 }}>
                  打印完成、异常、断开和恢复时推送到 OpenClaw 或 Hermes。
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                style={{ ...interactive, width: 32, height: 32, borderRadius: 10, color: 'rgba(246,250,255,0.78)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                ×
              </button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
              <span>启用外部通知</span>
              <input
                type="checkbox"
                checked={notificationConfig.enabled}
                onChange={(event) => updateNotificationConfig({ enabled: event.target.checked })}
                style={{ width: 18, height: 18 }}
              />
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center' }}>
              <div style={{ fontSize: 12, color: 'rgba(203,217,239,0.68)' }}>同一事件冷却时间</div>
              <input
                type="number"
                min="5"
                max="3600"
                value={Math.round((Number(notificationConfig.cooldownMs) || 30000) / 1000)}
                onChange={(event) => updateNotificationConfig({ cooldownMs: Math.max(5, Number(event.target.value) || 30) * 1000 })}
                style={{ width: 86, padding: '8px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none' }}
              />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 12, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
              <span>窗口保持最前</span>
              <input
                type="checkbox"
                checked={isAlwaysOnTop}
                onChange={(event) => setIsAlwaysOnTop(event.target.checked)}
                style={{ width: 18, height: 18 }}
              />
            </label>

            {renderOpacityControl()}

            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 2 }}>
              {notificationConfig.targets.map((target) => (
                <div key={target.id} style={{ padding: 12, borderRadius: 14, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#f7fbff' }}>{target.name}</div>
                      <div style={{ marginTop: 3, fontSize: 11, color: 'rgba(203,217,239,0.58)' }}>
                        Webhook URL + HMAC Secret
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => copyIntegrationCode(target)}
                        title={`复制 ${target.name} 接入代码`}
                        style={{ ...interactive, height: 28, padding: '0 9px', borderRadius: 9, color: '#dff8ff', background: 'rgba(91,177,255,0.12)', border: '1px solid rgba(91,177,255,0.2)', fontSize: 11, fontWeight: 700 }}
                      >
                        <Copy size={12} />
                        接入代码
                      </button>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'rgba(203,217,239,0.74)' }}>
                        启用
                        <input
                          type="checkbox"
                          checked={Boolean(target.enabled)}
                          onChange={(event) => updateNotificationTarget(target.id, { enabled: event.target.checked })}
                          style={{ width: 16, height: 16 }}
                        />
                      </label>
                    </div>
                  </div>

                  <input
                    type="text"
                    value={target.url || ''}
                    onChange={(event) => updateNotificationTarget(target.id, { url: event.target.value })}
                    placeholder={`填写 ${target.name} Webhook URL`}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 11, border: '1px solid rgba(255,255,255,0.11)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none', fontSize: 12 }}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginTop: 8 }}>
                    <input
                      type="password"
                      value={target.secret || ''}
                      onChange={(event) => updateNotificationTarget(target.id, { secret: event.target.value })}
                      placeholder="HMAC Secret（可选）"
                      style={{ width: '100%', minWidth: 0, padding: '10px 12px', borderRadius: 11, border: '1px solid rgba(255,255,255,0.11)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none', fontSize: 12 }}
                    />
                    <button
                      type="button"
                      onClick={() => testNotificationTarget(target)}
                      disabled={testingTargetId === target.id || !target.url}
                      style={{ ...interactive, height: 38, padding: '0 12px', borderRadius: 11, color: '#dff8ff', background: 'rgba(91,177,255,0.13)', border: '1px solid rgba(91,177,255,0.22)', fontSize: 12, fontWeight: 700, opacity: !target.url ? 0.48 : 1 }}
                    >
                      <Send size={13} />
                      {testingTargetId === target.id ? '测试中' : '测试'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {notificationFeedback ? (
              <div style={{ fontSize: 12, color: notificationFeedback.includes('失败') ? '#ffb1b1' : '#95f0bf', lineHeight: 1.5 }}>
                {notificationFeedback}
              </div>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => {
                  setNotificationConfig(getNotificationConfig());
                  setNotificationFeedback('');
                }}
                style={{ ...interactive, height: 36, padding: '0 14px', borderRadius: 10, color: 'rgba(229,239,255,0.82)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                还原
              </button>
              <button
                type="button"
                onClick={saveNotificationSettings}
                style={{ ...interactive, height: 36, padding: '0 14px', borderRadius: 10, color: '#06151f', background: 'linear-gradient(135deg, #7ef0c4, #8bc3ff)', border: 'none', fontWeight: 800 }}
              >
                保存设置
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {ipDialog ? (
        <div style={{ position: 'absolute', inset: 0, padding: 18, background: 'rgba(5,8,15,0.58)', backdropFilter: 'blur(12px)', borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', WebkitAppRegion: 'no-drag' }}>
          <form onSubmit={submitIpDialog} style={{ width: '100%', maxWidth: 320, padding: 18, borderRadius: 16, background: 'linear-gradient(180deg, rgba(18,28,44,0.98), rgba(11,18,30,0.98))', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 18px 42px rgba(0,0,0,0.38)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#f7fbff' }}>设置打印机 IP</div>
            <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(203,217,239,0.68)', lineHeight: 1.5 }}>
              {ipDialog.name || '当前设备'}
              <br />
              实时监控走打印机本地 MQTT，需要这台电脑能访问到打印机。
              <br />
              在外面使用时，请先通过 Tailscale、ZeroTier 或 VPN 连回同一网络，再填写对应 IP。
            </div>

            <input
              autoFocus
              type="text"
              value={ipDialog.value}
              onChange={(event) => {
                setIpDialog((prev) => (prev ? { ...prev, value: event.target.value } : prev));
                if (ipDialogError) setIpDialogError('');
              }}
              placeholder="192.168.1.100 或 VPN/Tailscale IP"
              style={{ width: '100%', marginTop: 16, padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none' }}
            />

            {ipDialogError ? (
              <div style={{ marginTop: 10, fontSize: 12, color: '#ffaeae', lineHeight: 1.5 }}>{ipDialogError}</div>
            ) : null}

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={closeIpDialog}
                disabled={submittingIp}
                style={{ ...interactive, height: 36, padding: '0 14px', borderRadius: 10, color: 'rgba(229,239,255,0.8)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                取消
              </button>
              <button
                type="submit"
                disabled={submittingIp}
                style={{ ...interactive, height: 36, padding: '0 14px', borderRadius: 10, color: '#04121e', background: 'linear-gradient(135deg, #7ef0c4, #8bc3ff)', border: 'none', fontWeight: 700 }}
              >
                {submittingIp ? '连接中...' : '连接'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
