import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Pin, PinOff } from 'lucide-react';
import { createMiniPage } from '../../utils/miniLayout';
import { getPrinterJobStatus } from '../../utils/printerPresentation';
import { miniSurfaceDragStyle, noDragRegionStyle } from '../../utils/windowDragRegions';

function MiniDevice({ printer, presentation }) {
  const { infoLine, progressPalette, safeProgress, statusText } = presentation;
  const rawProgress = printer?.progress;
  const progressKnown = rawProgress !== null
    && rawProgress !== ''
    && Number.isFinite(Number(rawProgress));
  const progress = progressKnown ? safeProgress(rawProgress) : 0;
  const resolvedStatus = getPrinterJobStatus(printer);
  const palette = progressPalette(resolvedStatus || 'idle');
  const meta = infoLine(printer);
  const progressCopy = progressKnown
    ? `${progress}%${printer.timeLeft && printer.timeLeft !== '--' ? ` · ${printer.timeLeft}` : ''}`
    : `${statusText(printer)} · 进度未知`;
  const progressProps = progressKnown
    ? { 'aria-valuenow': progress }
    : { 'aria-valuetext': `${statusText(printer)}，进度未知` };

  return <article className="mini-device">
    <div className="mini-primary">
      <strong title={printer.name || '未命名设备'}>{printer.name || '未命名设备'}</strong>
      <span title={progressCopy}>{progressCopy}</span>
    </div>
    <div className="mini-status" title={`${statusText(printer)} · ${meta.left}`}>
      {statusText(printer)} · {meta.left}
    </div>
    <div
      className="mini-progress"
      role="progressbar"
      aria-label={`${printer.name || '设备'}打印进度`}
      aria-valuemin="0"
      aria-valuemax="100"
      {...progressProps}
      style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill }}
    >
      <span />
    </div>
  </article>;
}

export default function MiniMonitor({
  printers,
  pageIndex,
  onPageCountChange,
  presentation,
  isAlwaysOnTop,
  isLocked,
  isNativeWindow,
  onToggleTop,
  onReturnFull,
}) {
  const stripRef = useRef(null);
  const [stripWidth, setStripWidth] = useState(0);

  useEffect(() => {
    const node = stripRef.current;
    if (!node) return undefined;
    const update = (width) => setStripWidth((current) => (
      Math.abs(current - width) >= 1 ? width : current
    ));
    update(node.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const page = useMemo(
    () => createMiniPage(printers, stripWidth, pageIndex),
    [pageIndex, printers, stripWidth],
  );

  useEffect(() => {
    onPageCountChange(page.pageCount);
  }, [onPageCountChange, page.pageCount]);

  return <section
    className="mini-monitor"
    aria-label="超迷你监控"
    style={miniSurfaceDragStyle({ isLocked, isNativeWindow })}
  >
    <div className="mini-device-strip" ref={stripRef}>
      {page.devices.length > 0 ? page.devices.map((printer) => (
        <MiniDevice
          key={printer.serialNumber || printer.dev_id || printer.id || printer.name}
          printer={printer}
          presentation={presentation}
        />
      )) : <div className="mini-empty">暂无设备</div>}
    </div>
    <div className="mini-actions" style={noDragRegionStyle()}>
      <button
        type="button"
        aria-label={isAlwaysOnTop ? '取消置顶' : '窗口置顶'}
        title={isAlwaysOnTop ? '取消置顶' : '窗口置顶'}
        aria-pressed={isAlwaysOnTop}
        onClick={onToggleTop}
      >
        {isAlwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
      <button type="button" aria-label="返回完整模式" title="返回完整模式" onClick={onReturnFull}>
        <Maximize2 size={14} />
      </button>
    </div>
  </section>;
}
