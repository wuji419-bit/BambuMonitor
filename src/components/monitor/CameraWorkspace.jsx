import React, { useEffect, useRef } from 'react';
import { Camera, Maximize2, RefreshCw } from 'lucide-react';
import { cameraCompatibilityNote, getCustomCameraUrl, getPrinterCameraKey } from '../../services/camera';
import { buildCameraFrameUrl, createVisibilityAwareCameraPoller } from '../../utils/cameraFrame';
import { buildCameraZoomState } from '../../utils/cameraZoom';
import { buildCameraCardPresentation, cameraRetryLabel } from '../../utils/cameraPresentation';
import { isPublicCaptureSearch, publicCameraAddress } from '../../utils/publicCapture';

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
    let mounted = true;
    let frame = 0;
    const markReady = () => setCameraImageStates((prev) => prev[imageKey]?.status === 'ready' ? prev : ({ ...prev, [imageKey]: { status: 'ready' } }));
    const markWaiting = () => setCameraImageStates((prev) => prev[imageKey]?.status === 'ready' ? prev : ({ ...prev, [imageKey]: { status: 'loading', message: '正在等待摄像头画面...' } }));
    const poller = createVisibilityAwareCameraPoller({
      documentVisible: document.visibilityState !== 'hidden',
      cardVisible: typeof IntersectionObserver !== 'function',
      async poll(signal) {
      const requestUrl = buildCameraFrameUrl(snapshotUrl, frame += 1);
        const response = await fetch(requestUrl, { cache: 'no-store', headers: { accept: 'image/jpeg' }, signal });
        if (!response.ok) throw new Error(`camera frame request failed: ${response.status}`);
        const blob = await response.blob();
        const image = await decodeCameraFrame(blob);
        if (mounted && canvasRef.current) { drawCameraFrame(canvasRef.current, image); markReady(); }
        if (typeof image.close === 'function') image.close();
      },
      onError(error) {
        if (mounted && error?.name !== 'AbortError') markWaiting();
      },
    });
    const handleVisibilityChange = () => {
      poller.setVisibility({ documentVisible: document.visibilityState !== 'hidden' });
    };
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => {
        poller.setVisibility({ cardVisible: Boolean(entry?.isIntersecting) });
      })
      : null;
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (canvasRef.current) observer?.observe(canvasRef.current);
    poller.start();
    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer?.disconnect();
      poller.stop();
    };
  }, [imageKey, setCameraImageStates, snapshotUrl]);
  return <canvas ref={canvasRef} role="img" aria-label={alt} className="camera-media__image" style={{ opacity: isReady ? 1 : 0.35 }} />;
}

export function CameraMedia({ zoomState, imageKey, title, imageState, customUrl, fit = 'cover', onImageStateChange }) {
  const ready = imageState?.status === 'ready';
  if (!zoomState.canZoom) return null;
  if (zoomState.isSnapshotStream) return <ChamberSnapshotCanvas snapshotUrl={zoomState.imageUrl} imageKey={imageKey} alt={`${title} 摄像头`} isReady={ready} setCameraImageStates={onImageStateChange} />;
  return <img className="camera-media__image" src={zoomState.imageUrl} alt={`${title} 摄像头`} style={{ objectFit: fit, opacity: ready ? 1 : 0.35 }} onLoad={() => onImageStateChange((prev) => ({ ...prev, [imageKey]: { status: 'ready' } }))} onError={() => onImageStateChange((prev) => ({ ...prev, [imageKey]: { status: 'error', message: customUrl ? '自定义摄像头地址无法显示' : '摄像头暂时无法打开' } }))} />;
}

export default function CameraWorkspace({ printers = [], streams = {}, imageStates = {}, cameraConfig = {}, allowCustomUrls = true, onRetry, onZoom, onImageStateChange }) {
  const isPublicCapture = typeof window !== 'undefined' && isPublicCaptureSearch(window.location.search);
  return <div className="camera-grid" data-testid="camera-grid" role="region" aria-label="摄像头列表" tabIndex={-1}>
    {!printers.length ? <div className="camera-empty" role="status">正在等待打印机列表...</div> : null}
    {printers.map((printer) => {
      const key = getPrinterCameraKey(printer); const stream = streams[key]; const state = imageStates[key];
      const customUrl = allowCustomUrls ? getCustomCameraUrl(cameraConfig, printer) : ''; const zoomState = buildCameraZoomState({ key, printer, stream, imageState: state, purpose: 'wall' });
      const ready = state?.status === 'ready';
      const presentation = buildCameraCardPresentation({ imageState: state, stream, customUrl, hasIp: Boolean(printer.ip) });
      const note = cameraCompatibilityNote(printer);
      const activate = () => { if (zoomState.canZoom) onZoom(key); };
      return <section key={`camera-${key}`} className={`camera-card${zoomState.canZoom ? ' is-ready' : ''}`} data-camera-card={key} role={zoomState.canZoom ? 'button' : undefined} tabIndex={zoomState.canZoom ? 0 : undefined} onClick={activate} onKeyDown={(event) => { if (zoomState.canZoom && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); activate(); } }}>
        <div className="camera-media">
          <CameraMedia zoomState={zoomState} imageKey={key} title={printer.name || '未命名打印机'} imageState={state} customUrl={customUrl} onImageStateChange={onImageStateChange} />
          {zoomState.canZoom && !ready ? <div className="camera-media__waiting">等待摄像头画面...</div> : null}
          {ready ? <span className="camera-media__zoom" aria-hidden="true"><Maximize2 size={14} /></span> : null}
          {!zoomState.canZoom ? <div className="camera-placeholder"><Camera size={24} /><span>{presentation.message}</span>{note ? <small>{note}</small> : null}{presentation.showRetry ? <button type="button" aria-label={cameraRetryLabel(printer)} onClick={(event) => { event.stopPropagation(); onRetry?.(printer); }}><RefreshCw size={12} />重试</button> : null}</div> : null}
        </div>
        <footer className="camera-card__footer"><div><strong>{printer.name || '未命名打印机'}</strong><span>{publicCameraAddress(printer.ip, isPublicCapture)}</span></div><b data-state={state?.status || 'idle'}>{presentation.label}</b></footer>
      </section>;
    })}
  </div>;
}
