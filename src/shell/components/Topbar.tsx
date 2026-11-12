import { useEffect, useState, type ReactElement } from 'react';
import { useWindowPort } from '../kernel-provider.tsx';
import { WindowControls } from './WindowControls.tsx';
import styles from './Topbar.module.css';

export interface TopbarProps {
  readonly kernelVersion: string;
  readonly readonlyMode: boolean;
  readonly aiOpen: boolean;
  readonly onToggleAi: () => void;
  readonly onOpenSettings: () => void;
}

const formatClock = (at: Date): string => at.toLocaleTimeString('zh-CN', { hour12: false });

export const Topbar = ({
  kernelVersion,
  readonlyMode,
  aiOpen,
  onToggleAi,
  onOpenSettings,
}: TopbarProps): ReactElement => {
  const windowPort = useWindowPort();
  const [clock, setClock] = useState(() => formatClock(new Date()));

  useEffect(() => {
    const timer = window.setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 双击最大化必须自己做：Tauri 内置的 drag-region 双击走 internal_toggle_maximize，
  // 而它在无边框窗口上因 is_maximizable() 恒为 false 会静默不生效。
  return (
    <header
      className={styles.topbar}
      data-tauri-drag-region="deep"
      onDoubleClick={(event) => {
        // 按钮自身的双击（例如连点「设置」）不应该顺带最大化窗口
        if (event.target instanceof Element && event.target.closest('button') !== null) return;
        void windowPort.toggleZoom();
      }}
    >
      {/* 两簇浮层：左侧交通灯 + 品牌，右侧状态 + 时钟 + 设置。
          中间留空仍是 header 的拖拽区，所以空白处也能按住拖动整个窗口。 */}
      <div className={styles.group}>
        <WindowControls />

        <div className={styles.brand}>
          <span className={styles.logoMark}>◆</span>
          <span className={styles.logoText}>EMBER</span>
          <span className={styles.logoVersion}>{kernelVersion}</span>
        </div>
      </div>

      <div className={`${styles.group} ${styles.right}`}>
        <span
          className={`${styles.statusDot} ${readonlyMode ? styles.statusDotReadonly : ''}`}
          aria-hidden="true"
        />
        <span className={`${styles.statusText} ${readonlyMode ? styles.statusTextReadonly : ''}`}>
          {readonlyMode ? '只读模式' : '内核就绪'}
        </span>
        <span className={styles.clock}>{clock}</span>
        <button
          type="button"
          className={`${styles.settings} ${aiOpen ? styles.settingsActive : ''}`}
          aria-pressed={aiOpen}
          onClick={onToggleAi}
        >
          AI
        </button>
        <button type="button" className={styles.settings} onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </header>
  );
};
