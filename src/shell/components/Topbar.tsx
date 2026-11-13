import { useEffect, useState, type ReactElement } from 'react';
import { useWindowPort } from '../kernel-provider.tsx';
import { WindowControls } from './WindowControls.tsx';
import { ShellMenu } from './ShellMenu.tsx';
import { readonlyText } from './readonly-text.ts';
import { CanvasSwitcher } from '../canvas/CanvasSwitcher.tsx';
import type { CanvasLibrary } from '../canvas/use-canvas-library.ts';
import styles from './Topbar.module.css';

export interface TopbarProps {
  readonly kernelVersion: string;
  readonly readonlyMode: boolean;
  readonly readonlyReason: string | null;
  /** 画布库导航：胶囊 + 面包屑 + 画布列表 */
  readonly library: CanvasLibrary;
  readonly onOpenDocuments: () => void;
  readonly onOpenSearch: () => void;
  readonly aiOpen: boolean;
  readonly onToggleAi: () => void;
  readonly conflictCount: number;
  readonly onOpenConflicts: () => void;
  readonly onOpenSettings: () => void;
}

const formatClock = (at: Date): string => at.toLocaleTimeString('zh-CN', { hour12: false });

export const Topbar = ({
  kernelVersion,
  readonlyMode,
  readonlyReason,
  library,
  onOpenDocuments,
  onOpenSearch,
  aiOpen,
  onToggleAi,
  conflictCount,
  onOpenConflicts,
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
      {/* 左簇：交通灯 + 品牌 + 当前画布（面包屑 + 胶囊 + 列表）。
          中间留空仍是 header 的拖拽区，所以空白处也能按住拖动整个窗口。 */}
      <div className={styles.group}>
        <WindowControls />

        <div className={styles.brand}>
          <span className={styles.logoMark}>◆</span>
          <span className={styles.logoText}>EMBER</span>
          <span className={styles.logoVersion}>{kernelVersion}</span>
        </div>

        <ShellMenu
          onOpenDocuments={onOpenDocuments}
          onOpenSearch={onOpenSearch}
          aiOpen={aiOpen}
          onToggleAi={onToggleAi}
          onOpenSettings={onOpenSettings}
        />

        <CanvasSwitcher library={library} />
      </div>

      <div className={`${styles.group} ${styles.right}`}>
        <span
          className={`${styles.statusDot} ${readonlyMode ? styles.statusDotReadonly : ''}`}
          aria-hidden="true"
        />
        <span className={`${styles.statusText} ${readonlyMode ? styles.statusTextReadonly : ''}`}>
          {readonlyMode ? readonlyText(readonlyReason) : '内核就绪'}
        </span>
        <span className={styles.clock}>{clock}</span>
        {conflictCount > 0 ? (
          <button
            type="button"
            className={`${styles.settings} ${styles.conflict}`}
            aria-label="打开冲突处理中心"
            title="存在待处理的冲突副本"
            onClick={onOpenConflicts}
          >
            冲突 {conflictCount}
          </button>
        ) : null}
      </div>
    </header>
  );
};
