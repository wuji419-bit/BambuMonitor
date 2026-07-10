import React, { useState } from 'react';
import { Minimize2, Scan } from 'lucide-react';
import { CameraMedia } from './CameraWorkspace';
import { nextCameraFit } from '../../utils/cameraPresentation';

export default function CameraZoom({ zoomState, imageKey, imageState, customUrl, onClose, onImageStateChange }) {
  const [fit, setFit] = useState('contain');
  if (!zoomState?.canZoom) return null;
  return <section className="camera-zoom" aria-label={`${zoomState.title} 放大预览`}>
    <header className="camera-zoom__titlebar">
      <div className="camera-zoom__identity"><strong>{zoomState.title}</strong><span>{zoomState.ip ? `IP ${zoomState.ip}` : '实时摄像头预览'}</span></div>
      <div className="camera-zoom__actions">
        <button type="button" onClick={() => setFit(nextCameraFit)} title={fit === 'contain' ? '铺满画面' : '完整显示'} aria-label={fit === 'contain' ? '铺满画面' : '完整显示'}><Scan size={17} /></button>
        <button type="button" onClick={onClose} title="关闭放大预览" aria-label="关闭放大预览"><Minimize2 size={17} /></button>
      </div>
    </header>
    <div className="camera-zoom__body"><CameraMedia zoomState={zoomState} imageKey={imageKey} title={zoomState.title} imageState={imageState} customUrl={customUrl} fit={fit} onImageStateChange={onImageStateChange} /></div>
  </section>;
}
