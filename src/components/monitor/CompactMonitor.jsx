import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { getPrinterConnectionState, getPrinterJobStatus } from '../../utils/printerPresentation';

function connectionCopy(printer) {
  const state = getPrinterConnectionState(printer);
  if (printer.ip) return `IP ${printer.ip}`;
  if (state === 'reconnecting') return '云端重连中';
  if (state === 'connecting') return '云端连接中';
  if (state === 'online') return '云端在线';
  if (state === 'error') return '连接异常';
  return '离线';
}

export default function CompactMonitor({ printers, summary, presentation, renderAction }) {
  const [expandedPrinterId, setExpandedPrinterId] = useState('');
  const { amsInfo, infoLine, progressPalette, safeProgress, statusText, temperatureText } = presentation;
  const metrics = [['总设备', summary.total ?? printers.length], ['在线', summary.online ?? 0], ['打印中', summary.printing ?? 0], ['需关注', summary.attention ?? summary.reconnecting ?? 0]];
  return <section className="compact-monitor" aria-label="紧凑设备监控">
    <div className="compact-summary">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>
    <div className="compact-list" data-testid="compact-printer-list">
      {printers.length === 0 ? <div className="compact-empty">正在同步设备...</div> : printers.map((printer) => {
        const id = String(printer.dev_id || printer.cloudId || printer.name);
        const expanded = expandedPrinterId === id;
        const progress = safeProgress(printer.progress);
        const status = getPrinterJobStatus(printer) || printer.status || 'idle';
        const meta = infoLine(printer);
        const ams = amsInfo(printer);
        const hasAms = Boolean(ams.text || ams.trays.length);
        const detailsId = `compact-ams-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const palette = progressPalette(status);
        return <article className="compact-row" key={id} data-connection={getPrinterConnectionState(printer)}>
          <div className="compact-row__head"><div className="compact-row__identity"><strong title={printer.name}>{printer.name || '未命名打印机'}</strong><span>{printer.model || printer.modelCode || '机型未知'} · {connectionCopy(printer)}</span></div><span className="compact-row__action">{renderAction(printer, true)}</span></div>
          <div className="compact-row__task"><span title={meta.left}>{meta.left}</span><strong>{Number.isFinite(Number(printer.progress)) ? `${progress}%` : statusText(printer)}</strong></div>
          <div className="compact-progress" role="progressbar" aria-label="打印进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress} style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill }}><span /></div>
          <div className="compact-row__facts"><span title={meta.right}>{meta.right}</span><span>{temperatureText(printer)}</span></div>
          {hasAms ? <button className="compact-ams-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedPrinterId(expanded ? '' : id)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}<span>AMS</span></button> : null}
          {expanded && hasAms ? <div className="compact-ams-details" id={detailsId}>{ams.text ? <span title={ams.text}>{ams.text}</span> : null}<div className="compact-trays">{ams.trays.slice(0, 8).map((tray) => <i key={tray.slotId} title={`${tray.remain ?? '--'}%`} style={{ background: tray.color }} />)}</div></div> : null}
        </article>;
      })}
    </div>
  </section>;
}
