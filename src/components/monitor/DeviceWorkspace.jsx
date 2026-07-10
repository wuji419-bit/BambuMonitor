import React from 'react';
import DeviceCard from './DeviceCard';

export default function DeviceWorkspace({ printers, summary, cloudOverviewCount, renderAction, presentation }) {
  const total = printers.length;
  const accessibleSummary = `总设备 ${total}，在线 ${summary.online}，打印中 ${summary.printing}，需关注 ${summary.attention}`;

  return (
    <section className="device-workspace" aria-label="设备工作区">
      <div className="device-summary" aria-label={accessibleSummary}>
        <span className="device-summary__compact-copy">{total} 台设备 · {summary.attention} 台需关注</span>
        <span className="device-summary__metric device-summary__metric--secondary"><small>总设备</small><strong>{total}</strong></span>
        <span className="device-summary__metric"><small>在线</small><strong>{summary.online}</strong></span>
        <span className="device-summary__metric"><small>打印中</small><strong>{summary.printing}</strong></span>
        <span className="device-summary__metric device-summary__metric--secondary"><small>需关注</small><strong>{summary.attention}</strong></span>
      </div>

      {cloudOverviewCount > 0 ? (
        <p className="device-cloud-notice">
          {cloudOverviewCount} 台设备由云端 MQTT 持续更新；本地 IP 仅用于摄像头和局域网直连，远程控制请使用 Bambu Connect 或 Bambu Handy。
        </p>
      ) : null}

      <div className="device-grid" data-testid="device-grid" aria-live="polite">
        {printers.length === 0 ? (
          <div className="device-empty" role="status">正在同步云端设备并等待本地遥测...</div>
        ) : printers.map((printer) => (
          <DeviceCard key={printer.dev_id} printer={printer} renderAction={renderAction} presentation={presentation} />
        ))}
      </div>
    </section>
  );
}
