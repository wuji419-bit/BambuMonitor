import React from 'react';
import { getPrinterConnectionState, getPrinterJobStatus } from '../../utils/printerPresentation';
import { hasCloudStatus } from '../../utils/printerIpPrompt';

function deviceLabel(printer) {
  const source = printer?.model || printer?.productName || printer?.printerType || printer?.name || 'BM';
  return String(source).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() || 'BM';
}

export default function DeviceCard({ printer, renderAction, presentation }) {
  const { amsInfo, infoLine, progressPalette, safeProgress, statusText, temperatureText } = presentation;
  const progress = safeProgress(printer.progress);
  const palette = progressPalette(getPrinterJobStatus(printer) || printer.status || 'idle');
  const status = getPrinterJobStatus(printer) || printer.status || 'idle';
  const connection = getPrinterConnectionState(printer);
  const meta = infoLine(printer);
  const ams = amsInfo(printer);
  const cloudOnly = !printer.ip && hasCloudStatus(printer);

  return (
    <article className={`device-card device-card--${status}`} data-printer-card data-status={status} data-connection={connection} aria-label={`${printer.name || '未命名打印机'}，${statusText(printer)}`}>
      <header className="device-card__header">
        <span className="device-card__avatar" aria-hidden="true">{deviceLabel(printer)}</span>
        <div className="device-card__identity">
          <strong title={printer.name || '未命名打印机'}>{printer.name || '未命名打印机'}</strong>
          <span title={printer.ip || ''}>{printer.ip ? `IP ${printer.ip}` : (cloudOnly ? '云端在线 · 本地 IP 可选' : '等待本地连接')}</span>
        </div>
        <div className="device-card__action">{renderAction(printer, true)}</div>
      </header>

      <div className="device-card__task">
        <span title={meta.left}>{meta.left}</span>
        <strong>{cloudOnly ? statusText(printer).replace('云端：', '') : `${progress}%`}</strong>
      </div>
      <div className="device-progress" role="progressbar" aria-label="打印进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress} style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill, '--progress-track': palette.track }}>
        <span />
      </div>

      <div className="device-card__facts">
        <span title={meta.right}>{meta.right}</span>
        <span>{printer.timeLeft && printer.timeLeft !== '--' ? `剩余 ${printer.timeLeft}` : temperatureText(printer)}</span>
        <span className="device-card__temperature">{temperatureText(printer)}</span>
      </div>

      {ams.text || ams.trays.length ? (
        <div className="device-card__ams">
          {ams.text ? <span className="device-card__ams-copy" title={ams.text}>{ams.text}</span> : null}
          {ams.trays.length ? (
            <div className="device-card__trays" aria-label="AMS 耗材">
              {ams.trays.slice(0, 8).map((tray) => (
                <span className="device-tray" key={`${printer.dev_id}-${tray.id}`} title={`料盘 ${tray.id}：${tray.remain === null ? '余量未知' : `剩余 ${tray.remain}%`}`}>
                  <i style={{ background: tray.color }} aria-hidden="true" />
                  {tray.remain === null ? '--' : `${tray.remain}%`}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {printer.errorMsg ? <p className="device-card__error">{printer.errorMsg}</p> : null}
    </article>
  );
}
