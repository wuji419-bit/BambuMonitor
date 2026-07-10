import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Copy, Lock, Maximize2, Minimize2, Pin, PinOff, RefreshCw, Rows3, Send, Settings } from 'lucide-react';
import MonitorShell from './monitor/MonitorShell';
import DeviceWorkspace from './monitor/DeviceWorkspace';
import { electronApp, electronCamera, electronEvents, electronWindow, isElectronEnvironment } from '../services/electron';
import {
  cameraCompatibilityNote,
  createDefaultCameraConfig,
  getCameraTransport,
  getCameraConfig,
  getCustomCameraUrl,
  getPrinterCameraKey,
  isAutoCameraSupported,
  saveCameraConfig,
} from '../services/camera';
import { buildCameraFrameUrl } from '../utils/cameraFrame';
import { buildCameraZoomState } from '../utils/cameraZoom';
import { mapWithConcurrency } from '../utils/asyncPool';
import { hasCloudStatus, shouldPromptForPrinterIp } from '../utils/printerIpPrompt';
import { noDragRegionStyle } from '../utils/windowDragRegions';
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

async function decodeCameraFrame(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('camera frame decode failed'));
    };
    image.src = objectUrl;
  });
}

function drawCameraFrame(canvas, image) {
  const context = canvas.getContext('2d');
  if (!context) return;

  const rect = canvas.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round((canvas.clientWidth || rect.width || 320) * pixelRatio));
  const height = Math.max(1, Math.round((canvas.clientHeight || rect.height || 200) * pixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const sourceWidth = image.width || image.naturalWidth || width;
  const sourceHeight = image.height || image.naturalHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = (width - drawWidth) / 2;
  const drawY = (height - drawHeight) / 2;

  context.clearRect(0, 0, width, height);
  context.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

function ChamberSnapshotCanvas({ snapshotUrl, imageKey, alt, isReady, setCameraImageStates }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!snapshotUrl || !imageKey) return undefined;

    let stopped = false;
    let frame = 0;
    let timer = 0;
    let activeController = null;

    const markReady = () => {
      setCameraImageStates((prev) => {
        if (prev[imageKey]?.status === 'ready') return prev;
        return {
          ...prev,
          [imageKey]: { status: 'ready' },
        };
      });
    };

    const markWaiting = () => {
      setCameraImageStates((prev) => {
        if (prev[imageKey]?.status === 'ready') return prev;
        return {
          ...prev,
          [imageKey]: {
            status: 'loading',
            message: '正在等待摄像头画面...',
          },
        };
      });
    };

    const paintNextFrame = async () => {
      activeController = new AbortController();
      const requestUrl = buildCameraFrameUrl(snapshotUrl, frame += 1);

      try {
        const response = await fetch(requestUrl, {
          cache: 'no-store',
          headers: { accept: 'image/jpeg' },
          signal: activeController.signal,
        });

        if (!response.ok) {
          throw new Error(`camera frame request failed: ${response.status}`);
        }

        const blob = await response.blob();
        const image = await decodeCameraFrame(blob);

        if (!stopped && canvasRef.current) {
          drawCameraFrame(canvasRef.current, image);
          markReady();
        }

        if (typeof image.close === 'function') image.close();
      } catch (error) {
        if (!stopped && error?.name !== 'AbortError') {
          markWaiting();
        }
      } finally {
        activeController = null;
        if (!stopped) timer = window.setTimeout(paintNextFrame, 700);
      }
    };

    paintNextFrame();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (activeController) activeController.abort();
    };
  }, [imageKey, setCameraImageStates, snapshotUrl]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt}
      style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: isReady ? 1 : 0.35, transition: 'opacity 0.2s ease' }}
    />
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
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupFeedback, setStartupFeedback] = useState('');
  const cameraWallOpenRef = useRef(false);
  const cameraRetryAttemptsRef = useRef({});
  const cameraRetryTimersRef = useRef({});
  const restartCameraRef = useRef(null);
  const nativeModeRef = useRef(viewMode);
  const submittingIpRef = useRef(submittingIp);
  const settingsDialogRef = useRef(null);
  const ipDialogRef = useRef(null);

  const isCompact = viewMode === 'compact';
  const isMini = viewMode === 'mini';
  const nativeMode = cameraZoomKey ? 'zoom' : (cameraOpen ? 'full' : viewMode);
  const activeDialog = ipDialog ? 'ip' : (settingsOpen ? 'settings' : '');
  const isFullPanel = !cameraOpen && !settingsOpen && !ipDialog && !isMini && !isCompact;
  const displayPrinters = sortPrintersForDisplay(printers);
  const summary = getPrinterSummary(printers);
  const onlineCount = summary.online;
  const printingCount = summary.printing;
  const reconnectingCount = summary.reconnecting;
  const cloudOverviewCount = displayPrinters.filter((printer) => isCloudOverview(printer)).length;
  const finishedPrinters = displayPrinters.filter((printer) => isFinishedPrinter(printer));
  const activeMiniPrinters = displayPrinters.filter((printer) => !isFinishedPrinter(printer));
  const rotatingMiniPrinter = activeMiniPrinters.length > 0
    ? activeMiniPrinters[miniActiveIndex % activeMiniPrinters.length]
    : null;
  const miniDisplayPrinter = rotatingMiniPrinter || finishedPrinters[0] || null;
  const compactPrimaryPrinter = displayPrinters.find((printer) => (
    ['printing', 'drying', 'preparing'].includes(getPrinterJobStatus(printer))
  ));
  const compactProgress = safeProgress(compactPrimaryPrinter?.progress);
  const compactProgressStatus = getPrinterJobStatus(compactPrimaryPrinter) || 'idle';
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
    setCameraZoomKey('');
  }, [cameraOpen]);

  useEffect(() => {
    if (!cameraZoomKey || activeDialog) return undefined;

    const closeOnEscape = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setCameraZoomKey('');
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [activeDialog, cameraZoomKey]);

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

  const updateCameraConfig = (updater) => {
    setCameraFeedback('');
    setCameraConfig((prev) => {
      const base = prev || createDefaultCameraConfig();
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...updater };
      saveCameraConfig(next);
      return next;
    });
  };

  const updateCameraUrl = (printer, value) => {
    const key = getPrinterCameraKey(printer);
    updateCameraConfig((prev) => ({
      ...prev,
      customUrls: {
        ...(prev.customUrls || {}),
        [key]: value,
      },
    }));
  };

  const toggleStartup = async (enabled) => {
    setStartupBusy(true);
    setStartupFeedback('');
    try {
      const result = await electronApp.setStartupEnabled({ enabled });
      if (!result?.success) {
        throw new Error(result?.error || '设置开机启动失败');
      }
      setStartupEnabledState(Boolean(result.enabled));
      setStartupFeedback(result.enabled ? '已开启开机自启动' : '已关闭开机自启动');
    } catch (error) {
      setStartupFeedback(error?.message || '设置开机启动失败');
    } finally {
      setStartupBusy(false);
    }
  };

  const renderCloudNotice = (compact = false) => {
    if (cloudOverviewCount <= 0) return null;
    return (
      <div
        style={{
          padding: compact ? '9px 10px' : '10px 12px',
          borderRadius: 8,
          background: 'linear-gradient(135deg, rgba(102,178,255,0.12), rgba(126,240,196,0.08))',
          border: '1px solid rgba(135,195,255,0.18)',
          color: 'rgba(226,238,255,0.78)',
          fontSize: compact ? 10 : 11,
          lineHeight: 1.55,
        }}
      >
        {cloudOverviewCount} 台设备未填写本地 IP：状态与遥测会继续通过云端 MQTT 更新；摄像头和本地直连仍需局域网或 VPN IP。
        <br />
        云端数据可能有延迟；官方远程控制请使用 Bambu Connect / Bambu Handy。
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

  const toggleMousePassthrough = () => {
    const nextLocked = !isLocked;
    setIsLocked(nextLocked);
    electronWindow.setIgnoreMouseEvents(nextLocked);
  };

  const changeViewMode = (mode) => {
    setCameraZoomKey('');
    setCameraOpen(false);
    setSettingsOpen(false);
    setIpDialog(null);
    setIpDialogError('');
    setViewMode(mode);
  };

  const changeWorkspaceTab = (tab) => {
    setCameraZoomKey('');
    setViewMode('full');
    if (tab === 'cameras') {
      openCameraWorkspace();
    } else {
      setCameraOpen(false);
    }
  };

  const resetCurrentWindowSize = () => {
    const storedMode = ['full', 'compact', 'mini'].includes(viewMode) ? viewMode : 'full';
    const mode = cameraZoomKey ? 'zoom' : (cameraOpen ? 'full' : storedMode);
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

  const renderTopButton = (size = 34) => (
    <button
      type="button"
      onClick={toggleAlwaysOnTop}
      title={isAlwaysOnTop ? '取消置顶' : '窗口置顶'}
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
      {isAlwaysOnTop ? <PinOff size={size <= 24 ? 12 : (size <= 30 ? 13 : 15)} /> : <Pin size={size <= 24 ? 12 : (size <= 30 ? 13 : 15)} />}
    </button>
  );

  const renderSettingsButton = (size = 34) => (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      title="设置"
      style={{
        ...interactive,
        width: size,
        height: size,
        borderRadius: size <= 28 ? 8 : (size <= 30 ? 10 : 11),
        color: notificationConfig.enabled ? '#8df0c0' : 'rgba(246,250,255,0.88)',
        background: notificationConfig.enabled ? 'rgba(86,226,168,0.14)' : 'rgba(255,255,255,0.08)',
        border: notificationConfig.enabled ? '1px solid rgba(86,226,168,0.24)' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <Settings size={size <= 24 ? 12 : (size <= 30 ? 14 : 16)} />
    </button>
  );

  const renderCameraButton = (size = 34) => (
    <button
      type="button"
      onClick={() => {
        if (cameraOpen) setCameraOpen(false);
        else openCameraWorkspace();
      }}
      title={cameraOpen ? '返回监控面板' : '打开摄像头墙'}
      style={{
        ...interactive,
        width: size,
        height: size,
        borderRadius: size <= 28 ? 8 : (size <= 30 ? 10 : 11),
        color: cameraOpen ? '#8bc3ff' : 'rgba(246,250,255,0.88)',
        background: cameraOpen ? 'rgba(91,177,255,0.16)' : 'rgba(255,255,255,0.08)',
        border: cameraOpen ? '1px solid rgba(91,177,255,0.28)' : '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <Camera size={size <= 24 ? 12 : (size <= 30 ? 14 : 16)} />
    </button>
  );

  const renderSyncButton = (size = 34) => (
    <button
      type="button"
      onClick={onRefreshDevices}
      disabled={isRefreshingDevices || typeof onRefreshDevices !== 'function'}
      title={deviceSyncCopy}
      style={{
        ...interactive,
        width: size,
        height: size,
        borderRadius: size <= 28 ? 8 : (size <= 30 ? 10 : 11),
        color: deviceSyncError ? '#ffb1b1' : (isRefreshingDevices ? '#9ac8ff' : 'rgba(246,250,255,0.88)'),
        background: deviceSyncError ? 'rgba(255,107,107,0.12)' : 'rgba(255,255,255,0.08)',
        border: deviceSyncError ? '1px solid rgba(255,107,107,0.2)' : '1px solid rgba(255,255,255,0.1)',
        opacity: isRefreshingDevices ? 0.72 : 1,
        cursor: isRefreshingDevices ? 'wait' : 'pointer',
      }}
    >
      <RefreshCw size={size <= 24 ? 12 : (size <= 30 ? 14 : 16)} />
    </button>
  );

  const renderOpacityControl = () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
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
    const ringSize = 24;
    const ringStroke = 2.5;
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
            <span style={{ position: 'relative', zIndex: 1, color: ring.color, fontSize: ring.label.length > 5 ? 6 : (ring.label.length > 3 ? 7 : 8), lineHeight: 1, fontWeight: 900, letterSpacing: 0 }}>
              {ring.label}
            </span>
          </span>
        </div>
      </div>
    );
  };

  const renderMiniActiveSlot = () => {
    if (!miniDisplayPrinter) return null;
    const sizingPrinters = activeMiniPrinters.length > 0
      ? activeMiniPrinters
      : [miniDisplayPrinter];

    return (
      <div
        style={{
          display: 'grid',
          width: 'max-content',
          maxWidth: '100%',
          padding: '2px 6px',
          borderRadius: 8,
          background: 'linear-gradient(180deg, rgba(255,255,255,0.062), rgba(255,255,255,0.038))',
          border: '1px solid rgba(126,240,196,0.2)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        }}
      >
        {sizingPrinters.map((printer) => (
          <div key={`mini-size-${printer.dev_id}`} style={{ gridArea: '1 / 1', visibility: 'hidden' }}>
            {renderMiniRow(printer, { bare: true })}
          </div>
        ))}
        <div key={`mini-active-${miniDisplayPrinter.dev_id}`} style={{ gridArea: '1 / 1' }}>
          {renderMiniRow(miniDisplayPrinter, { bare: true })}
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

  const renderZoomOverlay = () => {
    if (!cameraZoomKey) return null;

    const zoomPrinter = printers.find((printer) => getPrinterCameraKey(printer) === cameraZoomKey);
    const zoomState = buildCameraZoomState({
      key: cameraZoomKey,
      printer: zoomPrinter,
      stream: cameraStreams[cameraZoomKey],
      imageState: cameraImageStates[cameraZoomKey],
    });

    if (!zoomState.canZoom) return null;

    return (
      <div
        role="presentation"
        onClick={() => setCameraZoomKey('')}
        style={{
          position: 'absolute',
          inset: 12,
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 14,
          borderRadius: 8,
          background: 'linear-gradient(180deg, rgba(8,12,19,0.98), rgba(3,7,13,0.98))',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.58)',
          ...noDragRegionStyle(),
        }}
      >
        <div
          className="legacy-window-drag-region legacy-zoom-drag-region"
          onClick={(event) => event.stopPropagation()}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 850, color: '#f7fbff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {zoomState.title}
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(203,217,239,0.62)' }}>
              {zoomState.ip ? `IP ${zoomState.ip}` : '实时摄像头预览'}
            </div>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setCameraZoomKey('');
            }}
            title="关闭放大预览"
            style={{ ...interactive, width: 36, height: 36, borderRadius: 10, color: 'rgba(246,250,255,0.9)', background: 'rgba(255,255,255,0.09)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <Minimize2 size={17} />
          </button>
        </div>

        <div
          onClick={(event) => event.stopPropagation()}
          style={{
            flex: 1,
            minHeight: 0,
            borderRadius: 8,
            overflow: 'hidden',
            background: 'rgba(3,8,16,0.82)',
            border: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            ...noDragRegionStyle(),
          }}
        >
          {zoomState.isSnapshotStream ? (
            <ChamberSnapshotCanvas
              snapshotUrl={zoomState.imageUrl}
              imageKey={cameraZoomKey}
              alt={`${zoomState.title} 摄像头放大预览`}
              isReady={zoomState.isReady}
              setCameraImageStates={setCameraImageStates}
            />
          ) : (
            <img
              src={zoomState.imageUrl}
              alt={`${zoomState.title} 摄像头放大预览`}
              onLoad={() => {
                setCameraImageStates((prev) => ({
                  ...prev,
                  [cameraZoomKey]: { status: 'ready' },
                }));
              }}
              onError={() => {
                setCameraImageStates((prev) => ({
                  ...prev,
                  [cameraZoomKey]: {
                    status: 'error',
                    message: '摄像头暂时无法打开',
                  },
                }));
              }}
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
            />
          )}
        </div>
      </div>
    );
  };

  const renderCameraView = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 390 }}>
      <div className="legacy-camera-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: '#f7fbff' }}>
            <Camera size={17} />
            摄像头墙
          </div>
          <div style={{ marginTop: 5, fontSize: 11, color: 'rgba(203,217,239,0.62)', lineHeight: 1.5 }}>
            H2D/X1/P2S 走 RTSPS；A1/P1/A2 会自动尝试 6000 端口 JPEG 流，统一转成浏览器可显示的 MJPEG。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, WebkitAppRegion: 'no-drag' }}>
          <button type="button" onClick={() => changeWorkspaceTab('devices')} title="返回监控面板" style={{ ...interactive, width: 34, height: 34, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <Rows3 size={16} />
          </button>
          {renderSettingsButton(34)}
          {renderTopButton(34)}
        </div>
      </div>

      {cameraFeedback ? (
        <div style={{ padding: '9px 11px', borderRadius: 8, background: 'rgba(255,183,77,0.12)', border: '1px solid rgba(255,183,77,0.18)', color: '#ffdca2', fontSize: 12, lineHeight: 1.5 }}>
          {cameraFeedback}
        </div>
      ) : null}

      {printers.length === 0 ? (
        <div style={{ padding: '24px 18px', textAlign: 'center', color: 'rgba(225,234,248,0.68)', fontSize: 13, background: 'rgba(255,255,255,0.05)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
          正在等待打印机列表...
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gridAutoRows: 'max-content', alignContent: 'start', gap: 12, overflowY: 'auto', paddingRight: 2 }}>
          {displayPrinters.map((printer) => {
            const key = getPrinterCameraKey(printer);
            const stream = cameraStreams[key];
            const customUrl = getCustomCameraUrl(cameraConfig, printer);
            const note = cameraCompatibilityNote(printer);
            const imageState = cameraImageStates[key];
            const zoomState = buildCameraZoomState({ key, printer, stream, imageState });
            const isSnapshotStream = zoomState.isSnapshotStream;
            const imageUrl = zoomState.imageUrl;
            const showImage = zoomState.canZoom;
            const isImageReady = imageState?.status === 'ready';
            const isCameraPending = stream?.pending || imageState?.status === 'loading';
            const cameraStatusLabel = isImageReady
              ? (customUrl ? '自定义' : '有画面')
              : (imageState?.status === 'manual' ? '需配置' : (imageState?.status === 'error' ? '无画面' : (isCameraPending || stream?.success ? '连接中' : '待连接')));
            const cameraStatusColor = isImageReady
              ? '#8df0c0'
              : (imageState?.status === 'manual' ? '#ffd08a' : (imageState?.status === 'error' ? '#ffd08a' : 'rgba(203,217,239,0.62)'));
            const cameraMessage = imageState?.message || stream?.error || '正在打开摄像头...';

            return (
              <section
                key={`camera-${key}`}
                role={zoomState.canZoom ? 'button' : undefined}
                tabIndex={zoomState.canZoom ? 0 : undefined}
                title={zoomState.canZoom ? '点击放大预览' : undefined}
                onClick={() => {
                  if (zoomState.canZoom) setCameraZoomKey(key);
                }}
                onKeyDown={(event) => {
                  if (!zoomState.canZoom) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setCameraZoomKey(key);
                  }
                }}
                style={{
                  overflow: 'hidden',
                  borderRadius: 8,
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.035))',
                  border: '1px solid rgba(255,255,255,0.08)',
                  cursor: zoomState.canZoom ? 'zoom-in' : 'default',
                  WebkitAppRegion: 'no-drag',
                }}
              >
                <div style={{ aspectRatio: '16 / 10', background: 'rgba(3,8,16,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
                  {showImage ? (
                    <>
                      {isSnapshotStream ? (
                        <ChamberSnapshotCanvas
                          snapshotUrl={imageUrl}
                          imageKey={key}
                          alt={`${printer.name || '打印机'} 摄像头`}
                          isReady={isImageReady}
                          setCameraImageStates={setCameraImageStates}
                        />
                      ) : (
                        <img
                          src={imageUrl}
                          alt={`${printer.name || '打印机'} 摄像头`}
                          onLoad={() => {
                            setCameraImageStates((prev) => ({
                              ...prev,
                              [key]: { status: 'ready' },
                            }));
                          }}
                          onError={() => {
                            setCameraImageStates((prev) => ({
                              ...prev,
                              [key]: {
                                status: 'error',
                                message: customUrl ? '自定义摄像头地址无法显示' : '摄像头暂时无法打开',
                              },
                            }));
                          }}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: isImageReady ? 1 : 0.35, transition: 'opacity 0.2s ease' }}
                        />
                      )}
                      {!isImageReady ? (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, background: 'rgba(3,8,16,0.48)', color: 'rgba(226,238,255,0.74)', fontSize: 12, lineHeight: 1.45, textAlign: 'center' }}>
                          等待摄像头画面...
                        </div>
                      ) : null}
                      {isImageReady ? (
                        <div style={{ position: 'absolute', top: 8, right: 8, width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, color: 'rgba(246,250,255,0.88)', background: 'rgba(3,8,16,0.42)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(10px)' }}>
                          <Maximize2 size={14} />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div style={{ padding: 14, textAlign: 'center', color: 'rgba(226,238,255,0.62)', fontSize: 12, lineHeight: 1.45 }}>
                      <Camera size={24} style={{ marginBottom: 6, opacity: 0.72 }} />
                      <div>{cameraMessage}</div>
                      {note ? <div style={{ marginTop: 6, color: 'rgba(255,220,162,0.82)' }}>{note}</div> : null}
                      {imageState?.status === 'error' ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            retryCamera(printer);
                          }}
                          style={{
                            ...interactive,
                            height: 30,
                            margin: '10px auto 0',
                            padding: '0 11px',
                            borderRadius: 9,
                            color: '#dff2ff',
                            background: 'rgba(91,177,255,0.14)',
                            border: '1px solid rgba(91,177,255,0.24)',
                            fontSize: 11,
                            fontWeight: 700,
                          }}
                        >
                          <RefreshCw size={12} />
                          重试
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
                <div style={{ padding: '10px 11px', display: 'grid', gap: 5 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div style={{ minWidth: 0, fontSize: 12, fontWeight: 800, color: '#f7fbff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {printer.name || '未命名打印机'}
                    </div>
                    <span style={{ flex: '0 0 auto', fontSize: 10, color: cameraStatusColor }}>
                      {cameraStatusLabel}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(203,217,239,0.58)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {printer.ip ? `IP ${printer.ip}` : '需要本地 IP 才能自动打开'}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
      {renderZoomOverlay()}
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
        <div className="legacy-mini-surface">
          {printers.length === 0 ? (
            <div className="legacy-mini-empty">
              正在同步设备...
            </div>
          ) : (
            renderMiniActiveSlot()
          )}
        </div>
      ) : isCompact ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '42px 1fr', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 42, height: 42, borderRadius: 8, background: 'linear-gradient(135deg, rgba(126,240,196,0.28), rgba(255,209,102,0.18))', border: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dff8ff', fontSize: 12, fontWeight: 800, letterSpacing: 0 }}>
              BM
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {printers.length > 0 ? (
                  <>
                    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, padding: '3px 7px', borderRadius: 8, background: 'rgba(255,255,255,0.075)', border: '1px solid rgba(255,255,255,0.08)', color: '#f7fbff', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      总设备 <strong style={{ fontSize: 13 }}>{printers.length}</strong>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, padding: '3px 7px', borderRadius: 8, background: 'rgba(126,240,196,0.1)', border: '1px solid rgba(126,240,196,0.14)', color: '#92f4c5', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      在线 <strong style={{ fontSize: 13 }}>{onlineCount}</strong>
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, padding: '3px 7px', borderRadius: 8, background: printingCount > 0 ? 'rgba(126,240,196,0.1)' : 'rgba(255,255,255,0.055)', border: printingCount > 0 ? '1px solid rgba(126,240,196,0.14)' : '1px solid rgba(255,255,255,0.07)', color: printingCount > 0 ? '#80f6b8' : 'rgba(203,217,239,0.62)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      打印中 <strong style={{ fontSize: 13 }}>{printingCount}</strong>
                    </span>
                  </>
                ) : (
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f7fbff' }}>Bambu Monitor</div>
                )}
              </div>
              <div style={{ marginTop: 7 }}>
                <ProgressBar progress={compactProgress} status={compactProgressStatus} compact />
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end', gap: 7, WebkitAppRegion: 'no-drag' }}>
              <button type="button" onClick={() => setViewMode('full')} title="展开监控面板" style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <Maximize2 size={14} />
              </button>
              <button type="button" onClick={() => setViewMode('mini')} title="切换为超迷你模式" style={{ ...interactive, width: 30, height: 30, borderRadius: 10, color: 'rgba(246,250,255,0.88)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <Minimize2 size={14} />
              </button>
              {renderSyncButton(30)}
              {renderCameraButton(30)}
              {renderTopButton(30)}
              {renderSettingsButton(30)}
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
            <div style={{ padding: '14px 12px', textAlign: 'center', color: 'rgba(225,234,248,0.68)', fontSize: 12, background: 'rgba(255,255,255,0.05)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
              正在同步设备...
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {displayPrinters.map((printer) => {
                const progress = safeProgress(printer.progress);
                const progressMeta = progressPalette(printer.status);
                const meta = infoLine(printer);

                return (
                  <div
                    key={printer.dev_id}
                    style={{
                      padding: '10px 11px',
                      borderRadius: 8,
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
        <DeviceWorkspace
          printers={displayPrinters}
          summary={summary}
          cloudOverviewCount={cloudOverviewCount}
          renderAction={renderAction}
          presentation={{ amsInfo, infoLine, progressPalette, safeProgress, statusStyle, statusText, temperatureText }}
        />
      )}


      {settingsOpen ? (
        <div ref={settingsDialogRef} className="monitor-modal-backdrop monitor-settings-backdrop" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} style={{ position: 'absolute', inset: 0, padding: 18, background: 'rgba(5,8,15,0.62)', backdropFilter: 'blur(14px)', borderRadius: 0, WebkitAppRegion: 'no-drag', overflowY: 'auto' }}>
          <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 14, padding: 18, borderRadius: 8, background: 'linear-gradient(180deg, rgba(18,28,44,0.98), rgba(10,16,27,0.98))', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 20px 52px rgba(0,0,0,0.38)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: '#f7fbff' }}>
                  <Settings size={16} />
                  设置
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(203,217,239,0.66)', lineHeight: 1.5 }}>
                  窗口、通知、开机启动和摄像头墙都在这里调整。
                </div>
              </div>
              <button
                type="button"
                aria-label="关闭设置"
                title="关闭设置"
                onClick={() => setSettingsOpen(false)}
                style={{ ...interactive, width: 32, height: 32, borderRadius: 10, color: 'rgba(246,250,255,0.78)', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                ×
              </button>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
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

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
              <span>窗口保持最前</span>
              <input
                type="checkbox"
                checked={isAlwaysOnTop}
                onChange={(event) => setIsAlwaysOnTop(event.target.checked)}
                style={{ width: 18, height: 18 }}
              />
            </label>

            {renderOpacityControl()}

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
              <span>开机自动启动</span>
              <input
                type="checkbox"
                checked={startupEnabled}
                disabled={startupBusy}
                onChange={(event) => toggleStartup(event.target.checked)}
                style={{ width: 18, height: 18 }}
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(235,243,255,0.9)', fontSize: 13 }}>
              <span>连接后自动打开摄像头墙</span>
              <input
                type="checkbox"
                checked={Boolean(cameraConfig.autoOpen)}
                onChange={(event) => {
                  updateCameraConfig({ autoOpen: event.target.checked });
                  if (event.target.checked) openCameraWorkspace();
                }}
                style={{ width: 18, height: 18 }}
              />
            </label>

            {printers.length > 0 ? (
              <div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(235,243,255,0.9)', fontSize: 13, fontWeight: 700 }}>
                  <Camera size={14} />
                  摄像头地址
                </div>
                <div style={{ fontSize: 11, color: 'rgba(203,217,239,0.6)', lineHeight: 1.5 }}>
                  留空会按机型自动尝试 RTSPS 或 6000 JPEG 流；外部 MJPEG/快照 URL 只作为兜底。
                </div>
                {displayPrinters.map((printer) => {
                  const key = getPrinterCameraKey(printer);
                  return (
                    <input
                      key={`camera-url-${key}`}
                      type="text"
                      value={getCustomCameraUrl(cameraConfig, printer)}
                      onChange={(event) => updateCameraUrl(printer, event.target.value)}
                      placeholder={`${printer.name || '打印机'} 自定义摄像头 URL（可选）`}
                      style={{ width: '100%', padding: '9px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.11)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none', fontSize: 11 }}
                    />
                  );
                })}
              </div>
            ) : null}

            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', paddingRight: 2 }}>
              {notificationConfig.targets.map((target) => (
                <div key={target.id} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
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

            {startupFeedback || cameraFeedback ? (
              <div style={{ fontSize: 12, color: (startupFeedback || cameraFeedback).includes('失败') ? '#ffb1b1' : '#95f0bf', lineHeight: 1.5 }}>
                {startupFeedback || cameraFeedback}
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
        <div ref={ipDialogRef} className="monitor-modal-backdrop monitor-ip-backdrop" role="dialog" aria-modal="true" aria-label="设置打印机 IP" tabIndex={-1} style={{ position: 'absolute', inset: 0, padding: 18, background: 'rgba(5,8,15,0.58)', backdropFilter: 'blur(12px)', borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', WebkitAppRegion: 'no-drag' }}>
          <form onSubmit={submitIpDialog} style={{ width: '100%', maxWidth: 320, padding: 18, borderRadius: 8, background: 'linear-gradient(180deg, rgba(18,28,44,0.98), rgba(11,18,30,0.98))', border: '1px solid rgba(255,255,255,0.08)', boxShadow: '0 18px 42px rgba(0,0,0,0.38)' }}>
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
              style={{ width: '100%', marginTop: 16, padding: '12px 14px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: '#f7fbff', outline: 'none' }}
            />

            {ipDialogError ? (
              <div style={{ marginTop: 10, fontSize: 12, color: '#ffaeae', lineHeight: 1.5 }}>{ipDialogError}</div>
            ) : null}

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
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
