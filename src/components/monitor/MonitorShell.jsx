import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
  const [menuFocusIndex, setMenuFocusIndex] = useState(0);
  const menuId = useId();
  const menuAreaRef = useRef(null);
  const menuButtonRef = useRef(null);
  const menuRef = useRef(null);

  const focusMenuItem = useCallback((requestedIndex) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    if (items.length === 0) return;
    const index = (requestedIndex + items.length) % items.length;
    setMenuFocusIndex(index);
    items[index].focus();
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnOutsidePointer = (event) => {
      if (!menuAreaRef.current?.contains(event.target)) closeMenu(false);
    };
    const handleMenuKeyDown = (event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
      const currentIndex = Math.max(0, items.indexOf(document.activeElement));
      if (event.key === 'Home') focusMenuItem(0);
      else if (event.key === 'End') focusMenuItem(items.length - 1);
      else focusMenuItem(currentIndex + (event.key === 'ArrowDown' ? 1 : -1));
    };

    const focusFrame = requestAnimationFrame(() => focusMenuItem(0));
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', handleMenuKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', handleMenuKeyDown, true);
    };
  }, [closeMenu, focusMenuItem, menuOpen]);

  const choose = (callback) => {
    closeMenu(true);
    callback?.();
  };

  const menuItems = [
    { label: '紧凑模式', icon: <Rows3 size={14} aria-hidden="true" />, action: () => onChangeMode('compact') },
    { label: '超迷你模式', icon: <Minimize2 size={14} aria-hidden="true" />, action: () => onChangeMode('mini') },
    { label: isLocked ? '解除穿透' : '锁定穿透', icon: <Lock size={14} aria-hidden="true" />, action: onToggleLock },
    { label: '设置', icon: <Settings size={14} aria-hidden="true" />, action: onOpenSettings },
    { label: '重置窗口大小', icon: <RotateCcw size={14} aria-hidden="true" />, action: onResetSize },
    { label: '退出', icon: <Power size={14} aria-hidden="true" />, action: onQuit, danger: true },
  ];

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
              onClick={() => {
                if (menuOpen) closeMenu(true);
                else {
                  setMenuFocusIndex(0);
                  setMenuOpen(true);
                }
              }}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>

            {menuOpen ? (
              <div ref={menuRef} className="monitor-menu" id={menuId} role="menu" aria-label="更多操作">
                {menuItems.map(({ label, icon, action, danger }, index) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    tabIndex={menuFocusIndex === index ? 0 : -1}
                    className={danger ? 'is-danger' : undefined}
                    onFocus={() => setMenuFocusIndex(index)}
                    onClick={() => choose(action)}
                  >
                    {icon}
                    <span>{label}</span>
                  </button>
                ))}
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
