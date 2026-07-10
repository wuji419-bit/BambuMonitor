import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, RefreshCw } from 'lucide-react';
import MonitorShell from './monitor/MonitorShell';
import DeviceWorkspace from './monitor/DeviceWorkspace';
import CompactMonitor from './monitor/CompactMonitor';
import MiniMonitor from './monitor/MiniMonitor';
import CameraWorkspace from './monitor/CameraWorkspace';
import CameraZoom from './monitor/CameraZoom';
import SettingsSheet from './monitor/SettingsSheet';
import { electronApp, electronCamera, electronEvents, electronWindow, isElectronEnvironment } from '../services/electron';
import {
  createDefaultCameraConfig,
  getCameraTransport,
  getCameraConfig,
  getCustomCameraUrl,
  getPrinterCameraKey,
  isAutoCameraSupported,
  saveCameraConfig,
} from '../services/camera';
import { buildCameraZoomState } from '../utils/cameraZoom';
import { shouldClearCameraZoom } from '../utils/cameraPresentation';
import { mapWithConcurrency } from '../utils/asyncPool';
import { hasCloudStatus, shouldPromptForPrinterIp } from '../utils/printerIpPrompt';
import {
  getWindowModeConfig,
  normalizeSavedWindowSize,
  readWindowSizeMap,
  updateWindowSizeMap,
  WINDOW_SIZE_STORAGE_KEY,
} from '../utils/windowModes';
import {
  getPrinterConnectionState,
  getPrinterJobStatus,
  getPrinterSummary,
  sortPrintersForDisplay,
} from '../utils/printerPresentation';
import {
  buildInitialCameraState,
  cameraStartErrorState,
  cameraStartResultState,
  cameraStartWithTimeout,
  DEFAULT_CAMERA_START_TIMEOUT_MS,
  getCameraRetryDelay,
} from '../utils/cameraStartup';
import {
  buildIntegrationSnippet,
  createDefaultNotificationConfig,
  getNotificationConfig,
  saveNotificationConfig,
  sendTestNotification,
} from '../services/notifications';
import { isValidPrinterAddress, normalizePrinterAddress } from '../utils/printerAddress';
import { applySettingsTransaction } from '../utils/settingsTransaction';

const statusMap = {
  no_ip: ['云端概览', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  cloud_overview: ['云端概览', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  cloud_offline: ['云端离线', '#a9b5c7', 'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.12)'],
  connecting: ['连接中...', '#8cc8ff', 'rgba(102, 178, 255, 0.14)', 'rgba(102, 178, 255, 0.22)'],
  connected: ['已连接', '#89d8ff', 'rgba(91, 177, 255, 0.12)', 'rgba(91, 177, 255, 0.2)'],
  idle: ['闲置', '#dce6f9', 'rgba(255, 255, 255, 0.09)', 'rgba(255, 255, 255, 0.12)'],
  drying: ['烘干中', '#ffd08a', 'rgba(255, 190, 92, 0.14)', 'rgba(255, 190, 92, 0.22)'],
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
const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getDialogFocusables(dialog) {
  if (!dialog) return [];
  return [...dialog.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)]
    .filter((element) => !element.closest('[inert]') && element.getClientRects().length > 0);
}

function isCloudOverview(printer) {
  return !printer?.ip && hasCloudStatus(printer);
}

function statusText(printer) {
  const connectionState = getPrinterConnectionState(printer);
  const jobStatus = getPrinterJobStatus(printer) || printer.status;

  if (connectionState === 'reconnecting') {
    return jobStatus === 'printing'
      ? `重连中 · ${safeProgress(printer.progress)}%`
      : '正在重连';
  }
  if (['offline', 'error'].includes(connectionState)) return '连接中断';

  if (isCloudOverview(printer)) {
    if (jobStatus === 'printing') return '云端：打印中';
    if (jobStatus === 'paused') return '云端：暂停';
    if (jobStatus === 'preparing') return '云端：准备';
    if (jobStatus === 'finished') return '云端：完成';
    if (jobStatus === 'idle') return '云端：空闲';
    return '云端概览';
  }
  if (jobStatus === 'printing') return `${printer.progress || 0}% • ${printer.timeLeft || '--'}`;
  return (statusMap[jobStatus] || [jobStatus || printer.status || '--'])[0];
}

function statusStyle(printer) {
  const connectionState = getPrinterConnectionState(printer);
  const paletteKey = ['offline', 'error'].includes(connectionState)
    ? 'disconnected'
    : (connectionState === 'reconnecting' ? 'connecting' : (getPrinterJobStatus(printer) || printer.status));
  const [, color = '#dce6f9', background = 'rgba(255,255,255,0.09)', border = 'rgba(255,255,255,0.12)'] = statusMap[paletteKey] || [];
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
    .flatMap((unit, unitPosition) => {
      const unitIndex = Number.isFinite(Number(unit?.index)) ? Number(unit.index) : unitPosition;
      return (unit?.trays || []).map((tray) => ({ tray, unitIndex }));
    })
    .filter(({ tray }) => Number.isFinite(tray?.id))
    .slice(0, 8)
    .map(({ tray, unitIndex }) => ({
      id: tray.id,
      unitIndex,
      slotId: `${unitIndex}-${tray.id}`,
      remain: Number.isFinite(Number(tray.remain)) ? Number(tray.remain) : null,
      color: trayColor(tray),
    }));

  return { text: parts.join(' · '), trays };
}

function infoLine(printer) {
  if (hasCloudStatus(printer)) {
    const cloudLabel = statusText(printer).replace('云端：', '');
    return {
      left: cloudLabel && cloudLabel !== '云端概览'
        ? `云端状态：${cloudLabel}`
        : '云端状态已启用',
      right: printer.ip ? `IP ${printer.ip}` : 'IP 仅用于摄像头/本地直连',
    };
  }

  if (isCloudOverview(printer)) {
    const cloudLabel = statusText(printer).replace('云端：', '');
    return {
      left: cloudLabel === '云端概览' ? '未识别本地 IP' : `云端状态：${cloudLabel}`,
      right: '本地实时需填写这台电脑可访问的 IP',
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

function formatDeviceSyncTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '尚未同步设备';
  return `设备同步于 ${new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatTemperatureValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? `${Math.round(numeric)}°` : '--';
}

function temperatureText(printer) {
  const temperature = printer.temperature || {};
  if (isCloudOverview(printer) && !Number(temperature.nozzle) && !Number(temperature.bed)) {
    return '等待实时温度';
  }
  return `喷嘴 ${formatTemperatureValue(temperature.nozzle)} · 热床 ${formatTemperatureValue(temperature.bed)}`;
}

function isFinishedPrinter(printer) {
  return printer.status === 'finished' || safeProgress(printer.progress) >= 100;
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
    case 'drying':
      return {
        text: '#fff0c7',
        badge: 'rgba(255, 190, 92, 0.14)',
        border: 'rgba(255, 199, 112, 0.24)',
        track: 'linear-gradient(180deg, rgba(38, 28, 12, 0.96), rgba(24, 17, 8, 0.98))',
        fill: 'linear-gradient(90deg, #f2b34f 0%, #ffd66d 52%, #fff0a8 100%)',
        glow: 'rgba(255, 197, 92, 0.3)',
        cap: '#fff7dc',
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
              background: palette.cap,
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

export default function PrinterWidget({
  printers,
  onUpdateIp,
  onRefreshDevices,
  isRefreshingDevices = false,
  lastDeviceSyncAt = 0,
  deviceSyncError = '',
  onSignOut,
}) {
  const [isLocked, setIsLocked] = useState(false);
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
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraConfig, setCameraConfig] = useState(() => createDefaultCameraConfig());
  const [cameraStreams, setCameraStreams] = useState({});
  const [cameraImageStates, setCameraImageStates] = useState({});
  const [cameraZoomKey, setCameraZoomKey] = useState('');
  const [cameraFeedback, setCameraFeedback] = useState('');
  const [startupEnabled, setStartupEnabledState] = useState(false);
  const [startupFeedback, setStartupFeedback] = useState('');
  const cameraWallOpenRef = useRef(false);
  const cameraRetryAttemptsRef = useRef({});
  const cameraRetryTimersRef = useRef({});
  const cameraZoomOriginKeyRef = useRef('');
  const restartCameraRef = useRef(null);
  const nativeModeRef = useRef(viewMode);
  const submittingIpRef = useRef(submittingIp);
  const settingsDialogRef = useRef(null);
  const ipDialogRef = useRef(null);

  const isCompact = viewMode === 'compact';
  const isMini = viewMode === 'mini';
  const zoomPrinter = cameraZoomKey ? printers.find((printer) => getPrinterCameraKey(printer) === cameraZoomKey) : null;
  const zoomState = cameraZoomKey ? buildCameraZoomState({ key: cameraZoomKey, printer: zoomPrinter, stream: cameraStreams[cameraZoomKey], imageState: cameraImageStates[cameraZoomKey] }) : null;
  const isCameraZoomActive = Boolean(zoomState?.canZoom);
  const nativeMode = isCameraZoomActive ? 'zoom' : (cameraOpen ? 'full' : viewMode);
  const activeDialog = ipDialog ? 'ip' : (settingsOpen ? 'settings' : '');
  const isFullPanel = !cameraOpen && !settingsOpen && !ipDialog && !isMini && !isCompact;
  const displayPrinters = sortPrintersForDisplay(printers);
  const summary = getPrinterSummary(printers);
  const onlineCount = summary.online;
  const reconnectingCount = summary.reconnecting;
  const cloudOverviewCount = displayPrinters.filter((printer) => isCloudOverview(printer)).length;
  const finishedPrinters = displayPrinters.filter((printer) => isFinishedPrinter(printer));
  const activeMiniPrinters = displayPrinters.filter((printer) => (
    ['printing', 'drying', 'preparing', 'paused'].includes(getPrinterJobStatus(printer))
  ));
  const rotatingMiniPrinter = activeMiniPrinters.length > 0
    ? activeMiniPrinters[miniActiveIndex % activeMiniPrinters.length]
    : null;
  const deviceSyncCopy = deviceSyncError
    ? `同步失败：${deviceSyncError}`
    : (isRefreshingDevices ? '正在同步设备...' : formatDeviceSyncTime(lastDeviceSyncAt));
  const cameraSourceKey = JSON.stringify(printers.map((printer) => {
    const key = getPrinterCameraKey(printer);
    return {
      key,
      cloudId: printer.cloudId || '',
      name: printer.name || '',
      model: printer.model || printer.modelCode || '',
      modelCode: printer.modelCode || '',
      ip: printer.ip || '',
      accessCode: printer.accessCode || '',
      customUrl: getCustomCameraUrl(cameraConfig, printer),
      cameraMode: getCameraTransport(printer),
      autoCameraSupported: isAutoCameraSupported(printer),
    };
  }));
  cameraWallOpenRef.current = cameraOpen;
  nativeModeRef.current = nativeMode;
  submittingIpRef.current = submittingIp;

  const updateCameraState = (key, nextState) => {
    if (!key || !nextState || !cameraWallOpenRef.current) return;
    setCameraStreams((prev) => ({ ...prev, [key]: nextState.stream }));
    setCameraImageStates((prev) => ({ ...prev, [key]: nextState.imageState }));
  };

  const restartCameraSource = async (sourceOrKey, { stopFirst = true } = {}) => {
    let sources = [];
    try {
      sources = JSON.parse(cameraSourceKey);
    } catch {
      sources = [];
    }
    const source = typeof sourceOrKey === 'string'
      ? sources.find((item) => item.key === sourceOrKey)
      : sourceOrKey;
    if (!source?.key || !cameraWallOpenRef.current) return;

    const initialState = buildInitialCameraState(source);
    if (!initialState) return;

    if (!initialState.shouldStart) {
      if (source.customUrl) {
        const separator = source.customUrl.includes('?') ? '&' : '?';
        updateCameraState(source.key, {
          stream: { success: true, url: `${source.customUrl}${separator}bambuRetry=${Date.now()}`, mode: 'custom' },
          imageState: { status: 'loading' },
        });
      } else {
        updateCameraState(source.key, initialState);
      }
      return;
    }

    updateCameraState(source.key, initialState);
    try {
      if (stopFirst) {
        await electronCamera.stop({ serialNumber: source.key });
      }
      const result = await cameraStartWithTimeout(
        electronCamera.start({
          serialNumber: source.key,
          cloudId: source.cloudId,
          name: source.name,
          model: source.model,
          modelCode: source.modelCode,
          cameraMode: source.cameraMode,
          ip: source.ip,
          accessCode: source.accessCode,
        }),
        DEFAULT_CAMERA_START_TIMEOUT_MS,
        source.name || source.key,
      );
      updateCameraState(source.key, cameraStartResultState(result));
    } catch (error) {
      updateCameraState(source.key, cameraStartErrorState(error));
    }
  };

  restartCameraRef.current = restartCameraSource;

  const clearCameraRetryTimer = useCallback((key) => {
    const timer = cameraRetryTimersRef.current[key];
    if (timer) window.clearTimeout(timer);
    delete cameraRetryTimersRef.current[key];
  }, []);

  const scheduleCameraRetry = useCallback((key) => {
    if (!key || cameraRetryTimersRef.current[key]) return;
    const attempt = cameraRetryAttemptsRef.current[key] || 0;
    const delay = getCameraRetryDelay(attempt);
    if (delay === null) return;

    cameraRetryAttemptsRef.current[key] = attempt + 1;
    cameraRetryTimersRef.current[key] = window.setTimeout(() => {
      delete cameraRetryTimersRef.current[key];
      restartCameraRef.current?.(key);
    }, delay);
  }, []);

  const retryCamera = (printer) => {
    const key = getPrinterCameraKey(printer);
    if (!key) return;
    clearCameraRetryTimer(key);
    cameraRetryAttemptsRef.current[key] = 0;
    restartCameraRef.current?.(key);
  };

  const closeCameraZoom = useCallback(() => setCameraZoomKey(''), []);
  const openCameraZoom = useCallback((key) => {
    cameraZoomOriginKeyRef.current = key;
    setCameraZoomKey(key);
  }, []);

  const openCameraWorkspace = useCallback(() => {
    setViewMode('full');
    setCameraOpen(true);
  }, []);

  const persistWindowBounds = useCallback((bounds) => {
    const mode = nativeModeRef.current;
    const normalized = normalizeSavedWindowSize(mode, bounds);
    if (!normalized) return;
    const current = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
    localStorage.setItem(
      WINDOW_SIZE_STORAGE_KEY,
      JSON.stringify(updateWindowSizeMap(current, mode, normalized)),
    );
  }, []);

  useEffect(() => {
    if (!isElectronEnvironment()) return undefined;
    const offLock = electronEvents.onLockStatusChanged((locked) => setIsLocked(locked));
    const offTop = electronEvents.onAlwaysOnTopChanged((flag) => setIsAlwaysOnTop(Boolean(flag)));
    const offOpacity = electronEvents.onWindowOpacityChanged((opacity) => {
      const next = Number(opacity);
      if (Number.isFinite(next)) setWindowOpacityState(next);
    });
    return () => {
      offLock();
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
    setCameraConfig(getCameraConfig());
  }, []);

  useEffect(() => {
    if (!isElectronEnvironment()) return undefined;

    let cancelled = false;
    electronApp.getStartupEnabled()
      .then((result) => {
        if (!cancelled && result?.success) {
          setStartupEnabledState(Boolean(result.enabled));
        }
      })
      .catch((error) => {
        if (!cancelled) setStartupFeedback(error?.message || '读取开机启动状态失败');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (cameraConfig.autoOpen && printers.length > 0) {
      openCameraWorkspace();
    }
  }, [cameraConfig.autoOpen, openCameraWorkspace, printers.length]);

  useEffect(() => {
    if (cameraOpen) return;
    closeCameraZoom();
  }, [cameraOpen, closeCameraZoom]);

  useEffect(() => {
    if (!shouldClearCameraZoom({ selectedKey: cameraZoomKey, printer: zoomPrinter, zoomState })) return;
    closeCameraZoom();
  }, [cameraZoomKey, closeCameraZoom, zoomPrinter, zoomState]);

  useEffect(() => {
    if (isCameraZoomActive || !cameraOpen || !cameraZoomOriginKeyRef.current) return undefined;
    const originKey = cameraZoomOriginKeyRef.current;
    const frame = requestAnimationFrame(() => {
      const cards = document.querySelectorAll('[data-camera-card]');
      const card = [...cards].find((element) => element.getAttribute('data-camera-card') === originKey);
      const grid = document.querySelector('[data-testid="camera-grid"]');
      const cameraTab = document.querySelector('[data-testid="camera-tab"]');
      const target = card instanceof HTMLElement
        ? card
        : grid instanceof HTMLElement
          ? grid
          : cameraTab instanceof HTMLElement
            ? cameraTab
            : document.querySelector('.monitor-actions button');
      if (target instanceof HTMLElement) target.focus();
      cameraZoomOriginKeyRef.current = '';
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraOpen, isCameraZoomActive]);

  useEffect(() => {
    if (!isCameraZoomActive || activeDialog) return undefined;

    const closeOnEscape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeCameraZoom();
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activeDialog, closeCameraZoom, isCameraZoomActive]);

  useEffect(() => {
    if (!activeDialog) return undefined;
    const dialog = activeDialog === 'ip' ? ipDialogRef.current : settingsDialogRef.current;
    if (!dialog) return undefined;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const shell = dialog.closest('.monitor-shell');
    const legacySurface = dialog.closest('.monitor-legacy-surface');
    const inertTargets = [
      shell?.querySelector('.monitor-appbar'),
      shell?.querySelector('.monitor-tabs'),
      ...[...(legacySurface?.children || [])]
        .filter((child) => !child.classList.contains('monitor-modal-backdrop')),
    ].filter(Boolean);
    const inertState = inertTargets.map((element) => ({
      element,
      wasInert: element.hasAttribute('inert'),
      ariaHidden: element.getAttribute('aria-hidden'),
    }));

    inertTargets.forEach((element) => {
      element.inert = true;
      element.setAttribute('inert', '');
      element.setAttribute('aria-hidden', 'true');
    });

    const focusFrame = requestAnimationFrame(() => {
      const target = dialog.querySelector('[autofocus]')
        || getDialogFocusables(dialog)[0]
        || dialog;
      target.focus();
    });

    const handleDialogKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeDialog === 'settings') {
          setSettingsOpen(false);
        } else if (!submittingIpRef.current) {
          setIpDialog(null);
          setIpDialogError('');
        }
        return;
      }
      if (event.key !== 'Tab') return;

      const focusables = getDialogFocusables(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleDialogKeyDown);
      inertState.forEach(({ element, wasInert, ariaHidden }) => {
        element.inert = wasInert;
        if (wasInert) element.setAttribute('inert', '');
        else element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [activeDialog]);

  useEffect(() => {
    if (!cameraOpen || !isElectronEnvironment()) {
      return undefined;
    }

    let cancelled = false;

    const startCameraStreams = () => {
      setCameraFeedback('');
      Object.values(cameraRetryTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      cameraRetryTimersRef.current = {};
      cameraRetryAttemptsRef.current = {};
      const initialStreams = {};
      const initialImageStates = {};
      const startableSources = [];
      let sources = [];

      try {
        sources = JSON.parse(cameraSourceKey);
      } catch {
        sources = [];
      }

      for (const source of sources) {
        const initialState = buildInitialCameraState(source);
        if (!initialState) continue;
        initialStreams[initialState.key] = initialState.stream;
        initialImageStates[initialState.key] = initialState.imageState;
        if (initialState.shouldStart) startableSources.push(source);
      }

      if (!cancelled) {
        setCameraStreams(initialStreams);
        setCameraImageStates(initialImageStates);
      }

      mapWithConcurrency(startableSources, 2, async (source) => {
        if (cancelled) return;
        await restartCameraRef.current?.(source, { stopFirst: false });
      }).catch((error) => {
        if (!cancelled) setCameraFeedback(error?.message || '摄像头启动失败');
      });
    };

    startCameraStreams();

    return () => {
      cancelled = true;
    };
  }, [cameraOpen, cameraSourceKey]);

  useEffect(() => {
    if (cameraOpen) return undefined;
    Object.values(cameraRetryTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    cameraRetryTimersRef.current = {};
    cameraRetryAttemptsRef.current = {};
    setCameraStreams({});
    setCameraImageStates({});
    if (!isElectronEnvironment()) return undefined;
    electronCamera.stopAll().catch(() => {});
    return undefined;
  }, [cameraOpen]);

  useEffect(() => {
    if (!cameraOpen) return undefined;

    const timers = Object.entries(cameraStreams)
      .filter(([, stream]) => stream?.success && stream.url && stream.mode !== 'chamber-image-mjpeg')
      .map(([key, stream]) => window.setTimeout(() => {
        setCameraImageStates((prev) => {
          if (prev[key]?.status === 'ready') return prev;
          return {
            ...prev,
            [key]: {
              status: 'error',
              message: stream.mode === 'custom'
                ? '自定义摄像头地址没有返回画面'
                : '自动摄像头没有返回画面，可在设置里填写 MJPEG 或快照 URL',
            },
          };
        });
      }, 8000));

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [cameraOpen, cameraStreams]);

  useEffect(() => {
    if (!cameraOpen) return undefined;

    let sources = [];
    try {
      sources = JSON.parse(cameraSourceKey);
    } catch {
      sources = [];
    }
    const retryableKeys = new Set(sources
      .filter((source) => (
        !source.customUrl
        && source.ip
        && source.accessCode
        && source.autoCameraSupported
      ))
      .map((source) => source.key));

    Object.entries(cameraImageStates).forEach(([key, imageState]) => {
      if (imageState?.status === 'ready') {
        clearCameraRetryTimer(key);
        cameraRetryAttemptsRef.current[key] = 0;
      } else if (imageState?.status === 'error' && retryableKeys.has(key)) {
        scheduleCameraRetry(key);
      }
    });

    return undefined;
  }, [cameraImageStates, cameraOpen, cameraSourceKey, clearCameraRetryTimer, scheduleCameraRetry]);

  useEffect(() => {
    if (!isElectronEnvironment()) return undefined;
    const frameId = requestAnimationFrame(() => {
      const sizes = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
      const config = getWindowModeConfig(nativeMode);
      const size = normalizeSavedWindowSize(nativeMode, sizes[nativeMode]) || config.defaultSize;
      electronWindow.setModeSize({
        ...size,
        minWidth: config.minSize.width,
        minHeight: config.minSize.height,
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [nativeMode]);

  useEffect(() => {
    const offBoundsChanged = electronEvents.onWindowBoundsChanged(persistWindowBounds);
    const offBoundsSaveRequest = electronEvents.onWindowBoundsSaveRequest(persistWindowBounds);
    return () => {
      offBoundsChanged();
      offBoundsSaveRequest();
    };
  }, [persistWindowBounds]);

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
    const value = normalizePrinterAddress(ipDialog.value);
    if (!isValidPrinterAddress(value)) {
      setIpDialogError('请输入有效的 IPv4、IPv6 或主机名，不要包含协议或端口');
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

  const applySettingsDraft = async (draft) => {
    setNotificationFeedback('');
    setCameraFeedback('');
    const original = { isAlwaysOnTop, windowOpacity, startupEnabled, cameraConfig, notificationConfig };
    const next = {
      isAlwaysOnTop: Boolean(draft.isAlwaysOnTop),
      windowOpacity: Math.min(1, Math.max(0.5, Number(draft.windowOpacity) || 1)),
      startupEnabled: Boolean(draft.startupEnabled),
      cameraConfig: draft.cameraConfig || createDefaultCameraConfig(),
      notificationConfig: draft.notificationConfig || createDefaultNotificationConfig(),
    };
    const setStartup = async (enabled) => {
      const result = await electronApp.setStartupEnabled({ enabled });
      if (!result?.success) throw new Error(result?.error || '设置开机启动失败');
      setStartupEnabledState(Boolean(result.enabled));
    };
    await applySettingsTransaction({
      startupChanged: next.startupEnabled !== original.startupEnabled,
      applyStartup: () => setStartup(next.startupEnabled),
      commitLocal: () => {
        saveCameraConfig(next.cameraConfig);
        saveNotificationConfig(next.notificationConfig);
        setIsAlwaysOnTop(next.isAlwaysOnTop);
        setWindowOpacityState(next.windowOpacity);
        setCameraConfig(next.cameraConfig);
        setNotificationConfig(next.notificationConfig);
        if (next.cameraConfig.autoOpen) openCameraWorkspace();
      },
      rollbackStartup: () => setStartup(original.startupEnabled),
      rollbackLocal: () => {
        saveCameraConfig(original.cameraConfig);
        saveNotificationConfig(original.notificationConfig);
        setIsAlwaysOnTop(original.isAlwaysOnTop);
        setWindowOpacityState(original.windowOpacity);
        setCameraConfig(original.cameraConfig);
        setNotificationConfig(original.notificationConfig);
      },
    });
  };

  const toggleAlwaysOnTop = () => {
    setIsAlwaysOnTop((prev) => !prev);
  };

  const toggleMousePassthrough = () => {
    const nextLocked = !isLocked;
    setIsLocked(nextLocked);
    electronWindow.setIgnoreMouseEvents(nextLocked);
  };

  const changeViewMode = (mode) => {
    closeCameraZoom();
    setCameraOpen(false);
    setSettingsOpen(false);
    setIpDialog(null);
    setIpDialogError('');
    setViewMode(mode);
  };

  const changeWorkspaceTab = (tab) => {
    closeCameraZoom();
    setViewMode('full');
    if (tab === 'cameras') {
      openCameraWorkspace();
    } else {
      setCameraOpen(false);
    }
  };

  const resetCurrentWindowSize = () => {
    const storedMode = ['full', 'compact', 'mini'].includes(viewMode) ? viewMode : 'full';
    const mode = isCameraZoomActive ? 'zoom' : (cameraOpen ? 'full' : storedMode);
    const { defaultSize, minSize } = getWindowModeConfig(mode);
    const savedSizes = readWindowSizeMap(localStorage.getItem(WINDOW_SIZE_STORAGE_KEY));
    delete savedSizes[mode];
    localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify(savedSizes));
    electronWindow.setModeSize({
      ...defaultSize,
      minWidth: minSize.width,
      minHeight: minSize.height,
    });
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

    if (shouldPromptForPrinterIp(printer)) {
      return (
        <button
          type="button"
          onClick={() => openIpDialog(printer)}
          style={{ ...buttonStyle, color: '#ffd287', background: 'rgba(255,183,77,0.14)', border: '1px solid rgba(255,183,77,0.24)' }}
          title="未识别本地 IP，填写后会记住并自动连接实时监控"
        >
          填 IP
        </button>
      );
    }

    if (['offline', 'error'].includes(getPrinterConnectionState(printer)) && printer.ip) {
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

  const zoomCustomUrl = zoomPrinter ? getCustomCameraUrl(cameraConfig, zoomPrinter) : '';
  const renderCameraView = () => (
    <div className="camera-workspace">
      {cameraFeedback ? <div className="camera-feedback" role="status">{cameraFeedback}</div> : null}
      {isCameraZoomActive ? (
        <CameraZoom key={cameraZoomKey} zoomState={zoomState} imageKey={cameraZoomKey} imageState={cameraImageStates[cameraZoomKey]} customUrl={zoomCustomUrl} onClose={closeCameraZoom} onImageStateChange={setCameraImageStates} />
      ) : (
        <CameraWorkspace printers={displayPrinters} streams={cameraStreams} imageStates={cameraImageStates} cameraConfig={cameraConfig} onRetry={retryCamera} onZoom={openCameraZoom} onImageStateChange={setCameraImageStates} />
      )}
    </div>
  );
  const shellMode = cameraOpen ? 'full' : viewMode;
  const identityCopy = printers.length > 0
    ? `${onlineCount}/${printers.length} 台在线${reconnectingCount > 0 ? ` · ${reconnectingCount} 台重连中` : ''}`
    : '正在同步设备';

  return (
    <MonitorShell
      mode={shellMode}
      activeTab={cameraOpen ? 'cameras' : 'devices'}
      identityCopy={identityCopy}
      syncCopy={deviceSyncCopy}
      isAlwaysOnTop={isAlwaysOnTop}
      isLocked={isLocked}
      onTabChange={changeWorkspaceTab}
      onRefresh={() => onRefreshDevices?.()}
      onToggleTop={toggleAlwaysOnTop}
      onOpenSettings={() => setSettingsOpen(true)}
      onChangeMode={changeViewMode}
      onToggleLock={toggleMousePassthrough}
      onResetSize={resetCurrentWindowSize}
      onQuit={() => electronWindow.quit()}
    >
      <div
        className="monitor-legacy-surface"
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          maxHeight: '100%',
          padding: isMini ? '2px 6px' : (isCompact ? '12px 14px' : '18px 18px 14px'),
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 0,
          background: 'transparent',
          boxShadow: 'none',
          color: '#fff',
          cursor: 'default',
          WebkitAppRegion: 'no-drag',
          overflow: settingsOpen || ipDialog || isFullPanel || isMini ? 'hidden' : 'auto',
        }}
      >
      {cameraOpen ? renderCameraView() : isMini ? (
        <MiniMonitor finishedPrinters={finishedPrinters} activePrinter={rotatingMiniPrinter} presentation={{ infoLine, progressPalette, safeProgress, statusText }} isAlwaysOnTop={isAlwaysOnTop} onToggleTop={toggleAlwaysOnTop} onReturnFull={() => changeViewMode('full')} />
      ) : isCompact ? (
        <CompactMonitor printers={displayPrinters} summary={summary} presentation={{ amsInfo, infoLine, progressPalette, safeProgress, statusText, temperatureText }} renderAction={renderAction} />
      ) : (
        <DeviceWorkspace
          printers={displayPrinters}
          summary={summary}
          cloudOverviewCount={cloudOverviewCount}
          renderAction={renderAction}
          presentation={{ amsInfo, infoLine, progressPalette, safeProgress, statusStyle, statusText, temperatureText }}
        />
      )}


      {settingsOpen ? (
        <SettingsSheet
          dialogRef={settingsDialogRef}
          printers={displayPrinters}
          baseline={{ isAlwaysOnTop, windowOpacity, startupEnabled, cameraConfig, notificationConfig }}
          testingTargetId={testingTargetId}
          externalFeedback={notificationFeedback || startupFeedback || cameraFeedback}
          onClose={() => setSettingsOpen(false)}
          onSignOut={onSignOut}
          onCopyIntegration={copyIntegrationCode}
          onTestNotification={testNotificationTarget}
          onSave={applySettingsDraft}
        />
      ) : null}

      {ipDialog ? (
        <div ref={ipDialogRef} className="monitor-modal-backdrop monitor-ip-backdrop" role="dialog" aria-modal="true" aria-label="设置打印机 IP" tabIndex={-1}>
          <form className="monitor-ip-dialog" onSubmit={submitIpDialog}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#f7fbff' }}>设置打印机 IP</div>
            <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(203,217,239,0.68)', lineHeight: 1.5 }}>
              {ipDialog.name || '当前设备'}
              <br />
              实时监控走打印机本地 MQTT，需要这台电脑能访问到打印机。
              <br />
              在外面使用时，请先通过 Tailscale、ZeroTier 或 VPN 连回同一网络，再填写对应 IP。
            </div>

            <input
              type="text"
              value={ipDialog.value}
              onChange={(event) => {
                setIpDialog((prev) => (prev ? { ...prev, value: event.target.value } : prev));
                if (ipDialogError) setIpDialogError('');
              }}
              placeholder="192.168.1.100 或 VPN/Tailscale IP"
              className="monitor-ip-dialog__input"
            />

            {ipDialogError ? (
              <div style={{ marginTop: 10, fontSize: 12, color: '#ffaeae', lineHeight: 1.5 }}>{ipDialogError}</div>
            ) : null}

            <div className="monitor-ip-dialog__actions">
              <button
                type="button"
                aria-label="取消设置打印机 IP"
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
    </MonitorShell>
  );
}
