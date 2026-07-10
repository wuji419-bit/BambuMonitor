import React from 'react';
import { Camera, Copy, LogOut, Send, X } from 'lucide-react';
import { getCustomCameraUrl, getPrinterCameraKey } from '../../services/camera';

export default function SettingsSheet({
  dialogRef, printers, notificationConfig, notificationFeedback, testingTargetId,
  cameraConfig, cameraFeedback, startupEnabled, startupBusy, startupFeedback,
  isAlwaysOnTop, windowOpacity, onClose, onSignOut, onSetAlwaysOnTop,
  onSetOpacity, onToggleStartup, onUpdateCameraConfig, onUpdateCameraUrl,
  onUpdateNotificationConfig, onUpdateNotificationTarget, onCopyIntegration,
  onTestNotification, onRestore, onSave,
}) {
  return (
    <div ref={dialogRef} className="monitor-modal-backdrop monitor-settings-backdrop" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
      <div className="settings-sheet">
        <header className="settings-sheet__header">
          <div><strong>设置</strong><span>监控窗口与设备连接选项</span></div>
          <button type="button" className="settings-icon-button" aria-label="关闭设置" title="关闭设置" onClick={onClose}><X size={17} /></button>
        </header>

        <div className="settings-sheet__body">
          <section className="settings-section" aria-labelledby="settings-window">
            <h2 id="settings-window">窗口</h2>
            <label className="settings-toggle"><span>窗口保持最前</span><input type="checkbox" checked={isAlwaysOnTop} onChange={(event) => onSetAlwaysOnTop(event.target.checked)} /></label>
            <label className="settings-slider"><span>窗口透明度</span><input type="range" min="50" max="100" value={Math.round(windowOpacity * 100)} onChange={(event) => onSetOpacity(Number(event.target.value) / 100)} /><b>{Math.round(windowOpacity * 100)}%</b></label>
          </section>

          <section className="settings-section" aria-labelledby="settings-startup">
            <h2 id="settings-startup">启动</h2>
            <label className="settings-toggle"><span>开机自动启动</span><input type="checkbox" checked={startupEnabled} disabled={startupBusy} onChange={(event) => onToggleStartup(event.target.checked)} /></label>
            {startupFeedback ? <p className="settings-feedback">{startupFeedback}</p> : null}
          </section>

          <section className="settings-section" aria-labelledby="settings-camera">
            <h2 id="settings-camera">摄像头</h2>
            <label className="settings-toggle"><span>连接后自动打开摄像头墙</span><input type="checkbox" checked={Boolean(cameraConfig.autoOpen)} onChange={(event) => onUpdateCameraConfig({ autoOpen: event.target.checked })} /></label>
            {printers.length ? <div className="settings-fields"><p><Camera size={14} />自定义摄像头地址</p>{printers.map((printer) => { const key = getPrinterCameraKey(printer); return <label key={key}><span>{printer.name || '打印机'}</span><input type="text" value={getCustomCameraUrl(cameraConfig, printer)} onChange={(event) => onUpdateCameraUrl(printer, event.target.value)} placeholder="可选：MJPEG 或快照 URL" /></label>; })}</div> : null}
            {cameraFeedback ? <p className="settings-feedback">{cameraFeedback}</p> : null}
          </section>

          <section className="settings-section" aria-labelledby="settings-notifications">
            <h2 id="settings-notifications">通知与集成</h2>
            <label className="settings-toggle"><span>启用外部通知</span><input type="checkbox" checked={notificationConfig.enabled} onChange={(event) => onUpdateNotificationConfig({ enabled: event.target.checked })} /></label>
            <label className="settings-number"><span>同一事件冷却时间（秒）</span><input type="number" min="5" max="3600" value={Math.round((Number(notificationConfig.cooldownMs) || 30000) / 1000)} onChange={(event) => onUpdateNotificationConfig({ cooldownMs: Math.max(5, Number(event.target.value) || 30) * 1000 })} /></label>
            <div className="settings-targets">{notificationConfig.targets.map((target) => <div className="settings-target" key={target.id}>
              <div className="settings-target__header"><strong>{target.name}</strong><label><span>启用</span><input type="checkbox" checked={Boolean(target.enabled)} onChange={(event) => onUpdateNotificationTarget(target.id, { enabled: event.target.checked })} /></label></div>
              <input type="text" value={target.url || ''} onChange={(event) => onUpdateNotificationTarget(target.id, { url: event.target.value })} placeholder={`${target.name} Webhook URL`} />
              <input type="password" value={target.secret || ''} onChange={(event) => onUpdateNotificationTarget(target.id, { secret: event.target.value })} placeholder="HMAC Secret（可选）" />
              <div className="settings-target__actions"><button type="button" onClick={() => onCopyIntegration(target)}><Copy size={13} />接入代码</button><button type="button" disabled={testingTargetId === target.id || !target.url} onClick={() => onTestNotification(target)}><Send size={13} />{testingTargetId === target.id ? '测试中' : '测试'}</button></div>
            </div>)}</div>
            {notificationFeedback ? <p className="settings-feedback" role="status">{notificationFeedback}</p> : null}
          </section>

          <section className="settings-section settings-account" aria-labelledby="settings-account">
            <h2 id="settings-account">账号</h2>
            <button type="button" className="settings-signout" onClick={onSignOut}><LogOut size={15} />退出账号</button>
          </section>
        </div>

        <footer className="settings-sheet__footer"><button type="button" onClick={onRestore}>还原</button><button type="button" className="is-primary" onClick={onSave}>保存设置</button></footer>
      </div>
    </div>
  );
}
