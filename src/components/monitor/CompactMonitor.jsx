import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { getPrinterConnectionState, getPrinterJobStatus } from '../../utils/printerPresentation';
import { hasPrinterLocalAddress } from '../../utils/printerIpPrompt';

function connectionCopy(printer, showRawAddress) {
  const state = getPrinterConnectionState(printer);
  if (showRawAddress && printer.ip) return `IP ${printer.ip}`;
  if (hasPrinterLocalAddress(printer)) return '已配置本地地址';
  if (state === 'reconnecting') return '云端重连中';
  if (state === 'connecting') return '云端连接中';
  if (state === 'online') return '云端在线';
  if (state === 'error') return '连接异常';
  return '离线';
}

export default function CompactMonitor({ printers, summary, presentation, renderAction, showRawAddress = true }) {
  const [expandedPrinterId, setExpandedPrinterId] = useState('');
  const { amsInfo, infoLine, progressPalette, safeProgress, statusText, temperatureText } = presentation;
  const metrics = [['总设备', summary.total ?? printers.length], ['在线', summary.online ?? 0], ['打印中', summary.printing ?? 0], ['需关注', summary.attention ?? summary.reconnecting ?? 0]];
  return <section className="compact-monitor" aria-label="紧凑设备监控">
    <div className="compact-summary">{metrics.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>
    <div className="compact-list" data-testid="compact-printer-list">
      {printers.length === 0 ? <div className="compact-empty">正在同步设备...</div> : printers.map((printer, index) => {
        const fallbackName = String(printer.name || 'printer').replace(/[^\p{L}\p{N}_-]/gu, '-');
        const identity = String(printer.dev_id || printer.cloudId || fallbackName);
        const rowKey = `${identity}-${index}`;
        const expanded = expandedPrinterId === rowKey;
        const progress = safeProgress(printer.progress);
        const status = getPrinterJobStatus(printer) || printer.status || 'idle';
        const meta = infoLine(printer);
        const ams = amsInfo(printer);
        const hasAms = Boolean(ams.text || ams.trays.length);
        const detailsId = `compact-ams-${rowKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        const palette = progressPalette(status);
        const progressKnown = printer.progress !== null && printer.progress !== '' && Number.isFinite(Number(printer.progress));
        const progressProps = progressKnown ? { 'aria-valuenow': progress } : { 'aria-valuetext': `${statusText(printer)}，进度未知` };
        return <article className="compact-row" key={rowKey} data-connection={getPrinterConnectionState(printer)}>
          <div className="compact-row__main">
            <div className="compact-row__identity"><strong title={printer.name}>{printer.name || '未命名打印机'}</strong><span title={`${printer.model || printer.modelCode || '机型未知'} · ${connectionCopy(printer, showRawAddress)} · ${meta.left}`}>{printer.model || printer.modelCode || '机型未知'} · {connectionCopy(printer, showRawAddress)} · {meta.left}</span></div>
            <div className="compact-row__progress"><strong>{progressKnown ? `${progress}%` : statusText(printer)}</strong><span title={printer.timeLeft && printer.timeLeft !== '--' ? `剩余 ${printer.timeLeft}` : meta.right}>{printer.timeLeft && printer.timeLeft !== '--' ? printer.timeLeft : meta.right}</span><div className="compact-progress" role="progressbar" aria-label="打印进度" aria-valuemin="0" aria-valuemax="100" {...progressProps} style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill }}><span /></div></div>
            <div className="compact-row__telemetry"><span title={meta.right}>{meta.right}</span><span title={temperatureText(printer)}>{temperatureText(printer)}</span></div>
            <div className="compact-row__controls"><span className="compact-row__action">{renderAction(printer, true)}</span>{hasAms ? <button className="compact-ams-toggle" type="button" aria-label={`${printer.name || '打印机'} AMS 详情`} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedPrinterId(expanded ? '' : rowKey)}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button> : null}</div>
          </div>
          {expanded && hasAms ? <div className="compact-ams-details" id={detailsId}>{ams.text ? <span title={ams.text}>{ams.text}</span> : null}<div className="compact-trays">{ams.trays.slice(0, 8).map((tray) => <i key={tray.slotId} title={`${tray.remain ?? '--'}%`} style={{ background: tray.color }} />)}</div></div> : null}
        </article>;
      })}
    </div>
  </section>;
}
