import { GripVertical, Maximize2, Pin, PinOff } from 'lucide-react';

export default function MiniMonitor({ finishedPrinters, activePrinter, presentation, isAlwaysOnTop, onToggleTop, onReturnFull }) {
  const { infoLine, progressPalette, safeProgress, statusText } = presentation;
  const progress = activePrinter ? safeProgress(activePrinter.progress) : 0;
  const palette = progressPalette(activePrinter?.status || 'idle');
  const meta = activePrinter ? infoLine(activePrinter) : null;
  const fallback = finishedPrinters.length > 0 ? `${finishedPrinters.length} 台已完成` : '暂无活动任务';
  const progressCopy = activePrinter && Number.isFinite(Number(activePrinter.progress)) ? `${progress}%${activePrinter.timeLeft && activePrinter.timeLeft !== '--' ? ` · ${activePrinter.timeLeft}` : ''}` : (meta?.right || '空闲');
  return <section className="mini-monitor" aria-label="超迷你监控">
    <div className="mini-drag-handle" data-testid="mini-drag-handle" title="拖动窗口"><GripVertical size={14} /></div>
    <div className="mini-center"><div className="mini-primary"><strong title={activePrinter?.name || fallback}>{activePrinter?.name || fallback}</strong><span>{progressCopy}</span></div><div className="mini-status" title={activePrinter ? `${statusText(activePrinter)} · ${meta.left}` : fallback}>{activePrinter ? `${statusText(activePrinter)} · ${meta.left}` : fallback}</div><div className="mini-progress" style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill }}><span /></div></div>
    <div className="mini-actions"><button type="button" aria-label={isAlwaysOnTop ? '取消置顶' : '窗口置顶'} title={isAlwaysOnTop ? '取消置顶' : '窗口置顶'} aria-pressed={isAlwaysOnTop} onClick={onToggleTop}>{isAlwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}</button><button type="button" aria-label="返回完整模式" title="返回完整模式" onClick={onReturnFull}><Maximize2 size={14} /></button></div>
  </section>;
}
