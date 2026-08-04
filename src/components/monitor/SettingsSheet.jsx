import React, { useState } from 'react';
import { Camera, Copy, LogOut, Send, X } from 'lucide-react';
import { getCustomCameraUrl, getPrinterCameraKey } from '../../services/camera';

const clone = (value) => JSON.parse(JSON.stringify(value));

export default function SettingsSheet({ dialogRef, printers, baseline, capabilities = {}, testingTargetId, externalFeedback, onClose, onSignOut, onCopyIntegration, onTestNotification, onSave }) {
  const [openedBaseline] = useState(() => clone(baseline));
  const [draft, setDraft] = useState(() => clone(openedBaseline));
  const [busyAction, setBusyAction] = useState('');
  const [feedback, setFeedback] = useState('');
  const patch = (next) => setDraft((current) => ({ ...current, ...next }));
  const patchCamera = (next) => patch({ cameraConfig: { ...draft.cameraConfig, ...next } });
  const patchNotification = (next) => patch({ notificationConfig: { ...draft.notificationConfig, ...next } });
  const patchTarget = (id, next) => patchNotification({ targets: draft.notificationConfig.targets.map((target) => target.id === id ? { ...target, ...next } : target) });
  const patchCameraUrl = (printer, value) => patchCamera({ customUrls: { ...(draft.cameraConfig.customUrls || {}), [getPrinterCameraKey(printer)]: value } });
  const run = async (action, callback) => {
    if (busyAction) return;
    setBusyAction(action); setFeedback('');
    try { await callback(); if (action === 'save') setFeedback('设置已保存；还原会回到本次打开设置时的内容'); }
    catch (error) { setFeedback(error?.message || `${action === 'save' ? '保存' : '退出'}失败`); }
    finally { setBusyAction(''); }
  };
  const disabled = Boolean(busyAction);

  return <div ref={dialogRef} className="monitor-modal-backdrop monitor-settings-backdrop" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
    <div className="settings-sheet">
      <header className="settings-sheet__header"><div><strong>设置</strong><span>修改后保存才会生效</span></div><button type="button" className="settings-icon-button" aria-label="关闭设置" onClick={onClose} disabled={disabled}><X size={17} /></button></header>
      <div className="settings-sheet__body">
        {capabilities.nativeWindow ? <section className="settings-section"><h2>窗口</h2><label className="settings-toggle"><span>窗口保持最前</span><input type="checkbox" checked={draft.isAlwaysOnTop} onChange={(e) => patch({ isAlwaysOnTop: e.target.checked })} /></label><label className="settings-slider"><span>窗口透明度</span><input type="range" min="50" max="100" value={Math.round(draft.windowOpacity * 100)} onChange={(e) => patch({ windowOpacity: Number(e.target.value) / 100 })} /><b>{Math.round(draft.windowOpacity * 100)}%</b></label></section> : null}
        {capabilities.startup ? <section className="settings-section"><h2>启动</h2><label className="settings-toggle"><span>开机自动启动</span><input type="checkbox" checked={draft.startupEnabled} onChange={(e) => patch({ startupEnabled: e.target.checked })} /></label></section> : null}
        <section className="settings-section"><h2>摄像头</h2><label className="settings-toggle"><span>连接后自动打开摄像头墙</span><input type="checkbox" checked={Boolean(draft.cameraConfig.autoOpen)} onChange={(e) => patchCamera({ autoOpen: e.target.checked })} /></label>{printers.length ? <div className="settings-fields"><p><Camera size={14} />自定义摄像头地址</p>{printers.map((printer) => <label key={getPrinterCameraKey(printer)}><span>{printer.name || '打印机'}</span><input type="text" value={getCustomCameraUrl(draft.cameraConfig, printer)} onChange={(e) => patchCameraUrl(printer, e.target.value)} placeholder="可选：MJPEG 或快照 URL" /></label>)}</div> : null}</section>
        <section className="settings-section"><h2>通知与集成</h2><label className="settings-toggle"><span>启用外部通知</span><input type="checkbox" checked={draft.notificationConfig.enabled} onChange={(e) => patchNotification({ enabled: e.target.checked })} /></label><label className="settings-number"><span>同一事件冷却时间（秒）</span><input type="number" min="5" max="3600" value={Math.round((Number(draft.notificationConfig.cooldownMs) || 30000) / 1000)} onChange={(e) => patchNotification({ cooldownMs: Math.max(5, Number(e.target.value) || 30) * 1000 })} /></label>
          <div className="settings-targets">{draft.notificationConfig.targets.map((target) => <div className="settings-target" key={target.id}><div className="settings-target__header"><strong>{target.name}</strong><label><span>启用</span><input type="checkbox" checked={Boolean(target.enabled)} onChange={(e) => patchTarget(target.id, { enabled: e.target.checked })} /></label></div><input type="text" value={target.url || ''} onChange={(e) => patchTarget(target.id, { url: e.target.value })} placeholder={`${target.name} Webhook URL`} aria-label={`${target.name} Webhook URL`} /><input type="password" value={target.secret || ''} onChange={(e) => patchTarget(target.id, { secret: e.target.value })} placeholder="HMAC Secret（可选）" aria-label={`${target.name} HMAC Secret（可选）`} /><div className="settings-target__actions"><button type="button" aria-label={`复制 ${target.name} 接入代码`} onClick={() => onCopyIntegration(target)}><Copy size={13} />接入代码</button><button type="button" aria-label={`测试 ${target.name} 通知`} disabled={disabled || testingTargetId === target.id || !target.url} onClick={() => onTestNotification(target)}><Send size={13} />{testingTargetId === target.id ? '测试中' : '测试'}</button></div></div>)}</div>
        </section>
        <section className="settings-section settings-account"><h2>账号</h2><button type="button" className="settings-signout" disabled={disabled} onClick={() => run('signout', onSignOut)}><LogOut size={15} />{busyAction === 'signout' ? '退出中' : '退出账号'}</button></section>
        {feedback || externalFeedback ? <p className="settings-feedback" role={/失败/.test(feedback || externalFeedback) ? 'alert' : 'status'}>{feedback || externalFeedback}</p> : null}
      </div>
      <footer className="settings-sheet__footer"><button type="button" disabled={disabled} onClick={() => { setDraft(clone(openedBaseline)); setFeedback('已还原为打开设置时的内容'); }}>还原</button><button type="button" className="is-primary" disabled={disabled} onClick={() => run('save', () => onSave(draft))}>{busyAction === 'save' ? '保存中' : '保存设置'}</button></footer>
    </div>
  </div>;
}
