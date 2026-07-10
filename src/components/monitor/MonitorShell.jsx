import { useEffect, useId, useRef, useState } from 'react';
import {
  Camera,
  Lock,
  Minimize2,
  MoreHorizontal,
  Pin,
  PinOff,
  Power,
  RefreshCw,
  RotateCcw,
  Rows3,
  Settings,
} from 'lucide-react';
import './monitor.css';

export default function MonitorShell({
  mode,
  activeTab,
  identityCopy,
  syncCopy,
  isAlwaysOnTop,
  isLocked,
  onTabChange,
  onRefresh,
  onToggleTop,
  onOpenSettings,
  onChangeMode,
  onToggleLock,
  onResetSize,
  onQuit,
  children,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuAreaRef = useRef(null);
  const menuButtonRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutsidePointer = (event) => {
      if (!menuAreaRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const choose = (callback) => {
    setMenuOpen(false);
    callback?.();
  };

  return (
    <main
      className={`monitor-shell monitor-shell--${mode}${isLocked ? ' is-locked' : ''}`}
      data-testid="monitor-shell"
    >
      <header className="monitor-appbar">
        <div className="monitor-drag-region" data-testid="monitor-drag-region">
          <div className="monitor-identity">
            <strong>BambuMonitor</strong>
            <span title={identityCopy}>{identityCopy}</span>
          </div>
        </div>

        <div className="monitor-actions" aria-label="窗口操作">
          <button type="button" aria-label="同步设备" title="同步设备" onClick={onRefresh}>
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={isAlwaysOnTop ? 'is-active' : ''}
            aria-label={isAlwaysOnTop ? '取消置顶' : '窗口置顶'}
            title={isAlwaysOnTop ? '取消置顶' : '窗口置顶'}
            aria-pressed={isAlwaysOnTop}
            onClick={onToggleTop}
          >
            {isAlwaysOnTop
              ? <PinOff size={15} aria-hidden="true" />
              : <Pin size={15} aria-hidden="true" />}
          </button>

          <div className="monitor-menu-area" ref={menuAreaRef}>
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="更多操作"
              title="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>

            {menuOpen ? (
              <div className="monitor-menu" id={menuId} role="menu" aria-label="更多操作">
                <button type="button" role="menuitem" onClick={() => choose(() => onChangeMode('compact'))}>
                  <Rows3 size={14} aria-hidden="true" />
                  <span>紧凑模式</span>
                </button>
                <button type="button" role="menuitem" onClick={() => choose(() => onChangeMode('mini'))}>
                  <Minimize2 size={14} aria-hidden="true" />
                  <span>超迷你模式</span>
                </button>
                <button type="button" role="menuitem" onClick={() => choose(onToggleLock)}>
                  <Lock size={14} aria-hidden="true" />
                  <span>{isLocked ? '解除穿透' : '锁定穿透'}</span>
                </button>
                <button type="button" role="menuitem" onClick={() => choose(onOpenSettings)}>
                  <Settings size={14} aria-hidden="true" />
                  <span>设置</span>
                </button>
                <button type="button" role="menuitem" onClick={() => choose(onResetSize)}>
                  <RotateCcw size={14} aria-hidden="true" />
                  <span>重置窗口大小</span>
                </button>
                <button type="button" role="menuitem" className="is-danger" onClick={() => choose(onQuit)}>
                  <Power size={14} aria-hidden="true" />
                  <span>退出</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {mode === 'full' ? (
        <nav className="monitor-tabs" aria-label="监控视图">
          <button
            type="button"
            className={activeTab === 'devices' ? 'is-active' : ''}
            aria-current={activeTab === 'devices' ? 'page' : undefined}
            onClick={() => onTabChange('devices')}
          >
            <Rows3 size={14} aria-hidden="true" />
            <span>设备</span>
          </button>
          <button
            type="button"
            className={activeTab === 'cameras' ? 'is-active' : ''}
            aria-current={activeTab === 'cameras' ? 'page' : undefined}
            onClick={() => onTabChange('cameras')}
          >
            <Camera size={14} aria-hidden="true" />
            <span>摄像头</span>
          </button>
          <span className="monitor-sync-copy" title={syncCopy}>{syncCopy}</span>
        </nav>
      ) : null}

      <section className="monitor-content">{children}</section>
      <span className="monitor-resize-grip" aria-hidden="true" />
    </main>
  );
}
