import React from 'react';
import { getPrinterConnectionState, getPrinterJobStatus } from '../../utils/printerPresentation';
import { hasCloudStatus } from '../../utils/printerIpPrompt';

function deviceLabel(printer) {
  const source = printer?.model || printer?.modelCode || printer?.productName || printer?.printerType || printer?.name || 'BM';
  return String(source).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() || 'BM';
}

function deviceModel(printer) {
  return String(printer?.model || printer?.modelCode || printer?.productName || printer?.printerType || '机型未知').trim();
}

function cloudConnectionCopy(connection) {
  switch (connection) {
    case 'online': return '云端在线 · 本地 IP 可选';
    case 'connecting': return '云端连接中 · 本地 IP 可选';
    case 'reconnecting': return '云端重连中 · 本地 IP 可选';
    case 'offline': return '云端离线 · 本地 IP 可选';
    case 'error': return '云端连接异常 · 本地 IP 可选';
    default: return '云端状态未知 · 本地 IP 可选';
  }
}

export default function DeviceCard({ printer, renderAction, presentation }) {
  const { amsInfo, infoLine, progressPalette, safeProgress, statusText, temperatureText } = presentation;
  const rawProgress = printer.progress;
  const progressKnown = rawProgress !== null && rawProgress !== '' && Number.isFinite(Number(rawProgress));
  const progress = safeProgress(rawProgress);
  const palette = progressPalette(getPrinterJobStatus(printer) || printer.status || 'idle');
  const status = getPrinterJobStatus(printer) || printer.status || 'idle';
  const connection = getPrinterConnectionState(printer);
  const meta = infoLine(printer);
  const ams = amsInfo(printer);
  const cloudOnly = !printer.ip && hasCloudStatus(printer);
  const model = deviceModel(printer);
  const connectionCopy = printer.ip ? `IP ${printer.ip}` : (cloudOnly ? cloudConnectionCopy(connection) : '等待本地连接');
  const hasRemainingTime = Boolean(printer.timeLeft && printer.timeLeft !== '--');
  const metaHasRemainingTime = /剩余|预计/.test(String(meta.right || ''));
  const showRemainingTime = hasRemainingTime && !metaHasRemainingTime;
  const progressValueProps = progressKnown
    ? { 'aria-valuenow': progress }
    : { 'aria-valuetext': `${statusText(printer)}，进度未知` };

  return (
    <article className={`device-card device-card--${status}`} data-printer-card data-status={status} data-connection={connection} aria-label={`${printer.name || '未命名打印机'}，${model}，${statusText(printer)}`}>
      <header className="device-card__header">
        <span className="device-card__avatar" aria-hidden="true">{deviceLabel(printer)}</span>
        <div className="device-card__identity">
          <strong title={printer.name || '未命名打印机'}>{printer.name || '未命名打印机'}</strong>
          <span title={`${model} · ${connectionCopy}`}>{model} · {connectionCopy}</span>
        </div>
        <div className="device-card__action">{renderAction(printer, true)}</div>
      </header>

      <div className="device-card__task">
        <span title={meta.left}>{meta.left}</span>
        <strong>{cloudOnly ? statusText(printer).replace('云端：', '') : (progressKnown ? `${progress}%` : '--')}</strong>
      </div>
      <div className="device-progress" role="progressbar" aria-label="打印进度" aria-valuemin="0" aria-valuemax="100" {...progressValueProps} style={{ '--progress': `${progress}%`, '--progress-fill': palette.fill, '--progress-track': palette.track }}>
        <span />
      </div>

      <div className="device-card__facts">
        <span title={meta.right}>{meta.right}</span>
        {showRemainingTime ? <span>剩余 {printer.timeLeft}</span> : null}
        <span className="device-card__temperature">{temperatureText(printer)}</span>
      </div>

      {ams.text || ams.trays.length ? (
        <div className="device-card__ams">
          {ams.text ? <span className="device-card__ams-copy" title={ams.text}>{ams.text}</span> : null}
          {ams.trays.length ? (
            <div className="device-card__trays" aria-label="AMS 耗材">
              {ams.trays.slice(0, 8).map((tray) => (
                <span className="device-tray" key={`${printer.dev_id}-${tray.slotId}`} title={`AMS 单元 ${tray.unitIndex} · 槽位 ${tray.id}：${tray.remain === null ? '余量未知' : `剩余 ${tray.remain}%`}`}>
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
