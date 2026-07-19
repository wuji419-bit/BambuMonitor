import React, { useEffect, useReducer, useRef } from 'react';
import { Minimize2, Scan } from 'lucide-react';
import { CameraMedia } from './CameraWorkspace';
import { cameraFitReducer } from '../../utils/cameraPresentation';

export default function CameraZoom({ zoomState, imageKey, imageState, customUrl, showRawAddress = true, onClose, onImageStateChange }) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const [fitState, dispatchFit] = useReducer(cameraFitReducer, { imageKey, fit: 'contain' });
  useEffect(() => {
    dispatchFit({ type: 'sync', imageKey });
  }, [imageKey]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const shell = dialog.closest('.monitor-shell');
    const targets = [shell?.querySelector('.monitor-appbar'), shell?.querySelector('.monitor-tabs')].filter(Boolean);
    const previous = targets.map((element) => ({ element, inert: element.hasAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') }));
    targets.forEach((element) => { element.inert = true; element.setAttribute('inert', ''); element.setAttribute('aria-hidden', 'true'); });
    const focusFrame = requestAnimationFrame(() => (closeButtonRef.current || dialog).focus());
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button:not([disabled])')];
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', trapFocus);
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (inert) element.setAttribute('inert', ''); else element.removeAttribute('inert');
        if (ariaHidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', ariaHidden);
      });
    };
  }, []);
  const fit = fitState.imageKey === imageKey ? fitState.fit : 'contain';
  if (!zoomState?.canZoom) return null;
  return <section ref={dialogRef} className="camera-zoom" data-camera-purpose="zoom" role="dialog" aria-modal="true" aria-label={`${zoomState.title} 放大预览`} tabIndex={-1}>
    <header className="camera-zoom__titlebar">
      <div className="camera-zoom__identity"><strong>{zoomState.title}</strong><span>{showRawAddress && zoomState.ip ? `IP ${zoomState.ip}` : '实时摄像头预览'}</span></div>
      <div className="camera-zoom__actions">
        <button type="button" onClick={() => dispatchFit({ type: 'toggle' })} title={fit === 'contain' ? '铺满画面' : '完整显示'} aria-label={fit === 'contain' ? '铺满画面' : '完整显示'}><Scan size={17} /></button>
        <button ref={closeButtonRef} type="button" onClick={onClose} title="关闭放大预览" aria-label="关闭放大预览"><Minimize2 size={17} /></button>
      </div>
    </header>
    <div className="camera-zoom__body"><CameraMedia zoomState={zoomState} imageKey={imageKey} title={zoomState.title} imageState={imageState} customUrl={customUrl} fit={fit} onImageStateChange={onImageStateChange} /></div>
  </section>;
}
