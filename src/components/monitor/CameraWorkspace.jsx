import React, { useEffect, useRef } from 'react';
import { Camera, Maximize2, RefreshCw } from 'lucide-react';
import { cameraCompatibilityNote, getCustomCameraUrl, getPrinterCameraKey } from '../../services/camera';
import { buildCameraFrameUrl } from '../../utils/cameraFrame';
import { buildCameraZoomState } from '../../utils/cameraZoom';

async function decodeCameraFrame(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(objectUrl); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('camera frame decode failed')); };
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
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const sourceWidth = image.width || image.naturalWidth || width;
  const sourceHeight = image.height || image.naturalHeight || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.clearRect(0, 0, width, height);
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

export function ChamberSnapshotCanvas({ snapshotUrl, imageKey, alt, isReady, setCameraImageStates }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!snapshotUrl || !imageKey) return undefined;
    let stopped = false; let frame = 0; let timer = 0; let activeController = null;
    const markReady = () => setCameraImageStates((prev) => prev[imageKey]?.status === 'ready' ? prev : ({ ...prev, [imageKey]: { status: 'ready' } }));
    const markWaiting = () => setCameraImageStates((prev) => prev[imageKey]?.status === 'ready' ? prev : ({ ...prev, [imageKey]: { status: 'loading', message: '正在等待摄像头画面...' } }));
    const paintNextFrame = async () => {
      activeController = new AbortController();
      const requestUrl = buildCameraFrameUrl(snapshotUrl, frame += 1);
      try {
        const response = await fetch(requestUrl, { cache: 'no-store', headers: { accept: 'image/jpeg' }, signal: activeController.signal });
        if (!response.ok) throw new Error(`camera frame request failed: ${response.status}`);
        const blob = await response.blob();
        const image = await decodeCameraFrame(blob);
        if (!stopped && canvasRef.current) { drawCameraFrame(canvasRef.current, image); markReady(); }
        if (typeof image.close === 'function') image.close();
      } catch (error) {
        if (!stopped && error?.name !== 'AbortError') markWaiting();
      } finally {
        activeController = null;
        if (!stopped) timer = window.setTimeout(paintNextFrame, 700);
      }
    };
    paintNextFrame();
    return () => { stopped = true; window.clearTimeout(timer); if (activeController) activeController.abort(); };
  }, [imageKey, setCameraImageStates, snapshotUrl]);
  return <canvas ref={canvasRef} role="img" aria-label={alt} className="camera-media__image" style={{ opacity: isReady ? 1 : 0.35 }} />;
}

export function CameraMedia({ zoomState, imageKey, title, imageState, customUrl, fit = 'cover', onImageStateChange }) {
  const ready = imageState?.status === 'ready';
  if (!zoomState.canZoom) return null;
  if (zoomState.isSnapshotStream) return <ChamberSnapshotCanvas snapshotUrl={zoomState.imageUrl} imageKey={imageKey} alt={`${title} 摄像头`} isReady={ready} setCameraImageStates={onImageStateChange} />;
  return <img className="camera-media__image" src={zoomState.imageUrl} alt={`${title} 摄像头`} style={{ objectFit: fit, opacity: ready ? 1 : 0.35 }} onLoad={() => onImageStateChange((prev) => ({ ...prev, [imageKey]: { status: 'ready' } }))} onError={() => onImageStateChange((prev) => ({ ...prev, [imageKey]: { status: 'error', message: customUrl ? '自定义摄像头地址无法显示' : '摄像头暂时无法打开' } }))} />;
}

export default function CameraWorkspace({ printers, streams, imageStates, cameraConfig, onRetry, onZoom, onImageStateChange }) {
  if (!printers.length) return <div className="camera-empty">正在等待打印机列表...</div>;
  return <div className="camera-grid" data-testid="camera-grid">
    {printers.map((printer) => {
      const key = getPrinterCameraKey(printer); const stream = streams[key]; const state = imageStates[key];
      const customUrl = getCustomCameraUrl(cameraConfig, printer); const zoomState = buildCameraZoomState({ key, printer, stream, imageState: state });
      const ready = state?.status === 'ready'; const pending = stream?.pending || state?.status === 'loading';
      const label = ready ? (customUrl ? '自定义' : '有画面') : state?.status === 'manual' ? '需配置' : state?.status === 'error' ? '无画面' : pending || stream?.success ? '连接中' : '待连接';
      const message = state?.message || stream?.error || (printer.ip ? '正在打开摄像头...' : '需要本地 IP 才能自动打开');
      const activate = () => { if (zoomState.canZoom) onZoom(key); };
      return <section key={`camera-${key}`} className={`camera-card${zoomState.canZoom ? ' is-ready' : ''}`} data-camera-card={key} role={zoomState.canZoom ? 'button' : undefined} tabIndex={zoomState.canZoom ? 0 : undefined} onClick={activate} onKeyDown={(event) => { if (zoomState.canZoom && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(); } }}>
        <div className="camera-media">
          <CameraMedia zoomState={zoomState} imageKey={key} title={printer.name || '未命名打印机'} imageState={state} customUrl={customUrl} onImageStateChange={onImageStateChange} />
          {zoomState.canZoom && !ready ? <div className="camera-media__waiting">等待摄像头画面...</div> : null}
          {ready ? <span className="camera-media__zoom" aria-hidden="true"><Maximize2 size={14} /></span> : null}
          {!zoomState.canZoom ? <div className="camera-placeholder"><Camera size={24} /><span>{message}</span>{cameraCompatibilityNote(printer) ? <small>{cameraCompatibilityNote(printer)}</small> : null}{state?.status === 'error' ? <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(printer); }}><RefreshCw size={12} />重试</button> : null}</div> : null}
        </div>
        <footer className="camera-card__footer"><div><strong>{printer.name || '未命名打印机'}</strong><span>{printer.ip ? `IP ${printer.ip}` : '暂无本地 IP'}</span></div><b data-state={state?.status || 'idle'}>{label}</b></footer>
      </section>;
    })}
  </div>;
}
