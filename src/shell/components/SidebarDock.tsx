import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useMachineStore,
} from '../../data/stores/machine-store.ts';
import { Sidebar, type SidebarProps } from './Sidebar.tsx';
import styles from './SidebarDock.module.css';

export interface SidebarDockProps extends SidebarProps {
  /** 库内设置 ui.sidebar：auto = 左缘热区滑出；off = 完全不渲染 */
  readonly mode: 'auto' | 'off';
}

/** 收起的延迟：留出从热区移入侧栏的时间 */
const PEEK_CLOSE_DELAY_MS = 160;

const LauncherIcon = (): ReactElement => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 3v10" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8.5 6.25h3M8.5 8.25h3M8.5 10.25h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/**
 * 侧栏两态：
 * - off：热区与侧栏都不进 DOM（不是 visibility 隐藏）。
 * - auto：左缘热区 + 浮在画布上的圆角浮层，指针进入滑出，离开延迟收起；
 *   收起后在左下角保留一个图标，点击可重新展开。画布始终占满宽度。
 */
export const SidebarDock = ({ mode, ...sidebarProps }: SidebarDockProps): ReactElement | null => {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const storedWidth = useMachineStore((state) => state.sidebarWidth);
  // 通过 getState 取 action：避免把 store 方法当作未绑定成员带出（也会让选择器返回稳定引用）
  const setSidebarWidth = useCallback(
    (next: number) => useMachineStore.getState().setSidebarWidth(next),
    [],
  );
  /** 拖动中的临时宽度：只在松手时落盘，避免每帧写 ui.json */
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const width = liveWidth ?? storedWidth;

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (mode === 'off') return null;

  const cancelClose = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const openNow = (): void => {
    cancelClose();
    setOpen(true);
  };

  const closeLater = (): void => {
    // 拖动改宽时指针可能短暂离开面板，此时不能收起
    if (drag.current !== null) return;
    cancelClose();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(false);
    }, PEEK_CLOSE_DELAY_MS);
  };

  const clampWidth = (value: number): number =>
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));

  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    cancelClose();
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setLiveWidth(width);
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    setLiveWidth(clampWidth(drag.current.startWidth + (event.clientX - drag.current.startX)));
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (liveWidth !== null) setSidebarWidth(liveWidth);
    setLiveWidth(null);
  };

  /** 捕获被系统抢走（IME/辅助功能/DOM 重建）：按当前临时宽度就地收尾 */
  const onResizeCaptureLost = (): void => {
    if (drag.current === null) return;
    drag.current = null;
    if (liveWidth !== null) setSidebarWidth(liveWidth);
    setLiveWidth(null);
  };

  return (
    <div
      className={styles.dock}
      data-open={open ? 'true' : 'false'}
      data-sidebar-dock=""
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <div
        className={styles.hotzone}
        data-sidebar-hotzone=""
        aria-hidden="true"
        onPointerEnter={openNow}
        onPointerDown={openNow}
      />
      <div className={styles.panel} onPointerEnter={openNow} onPointerLeave={closeLater}>
        <Sidebar {...sidebarProps} />
        {/* 右缘改宽把手：双击回到默认宽度，给出不用拖也能复位的出口 */}
        <div
          className={styles.resizer}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={width}
          title="拖动调整宽度；双击恢复默认"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onLostPointerCapture={onResizeCaptureLost}
          onDoubleClick={() => {
            cancelClose();
            setLiveWidth(null);
            setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          }}
        />
      </div>
      {/* 启动图标始终挂载：只按展开态隐藏，占住横排第一格，
          这样侧栏开合时后面的按钮不会横向位移 */}
      <button
        type="button"
        className={styles.launcher}
        data-visible={open ? 'false' : 'true'}
        aria-label="打开资源管理器"
        title="打开资源管理器"
        tabIndex={open ? -1 : 0}
        aria-hidden={open ? 'true' : undefined}
        onClick={openNow}
      >
        <LauncherIcon />
      </button>
    </div>
  );
};
