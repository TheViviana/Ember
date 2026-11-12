import { useState, type ReactElement } from 'react';
import { useCursorStore } from '../editor/cursor-store.ts';
import styles from './StatusBar.module.css';

export interface StatusBarProps {
  readonly readonlyMode: boolean;
  readonly kernelVersion: string;
  readonly documentCount: number;
  readonly activeCapabilities: number;
  readonly capabilityCount: number;
  readonly commandCount: number;
  /** 关窗落盘失败等需要常驻提示的信息；null/undefined 时不占位 */
  readonly notice?: string | null;
}

const Chevron = ({ collapsed }: { readonly collapsed: boolean }): ReactElement => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path
      d={collapsed ? 'M6 2.5 3.5 5 6 7.5' : 'M4 2.5 6.5 5 4 7.5'}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const StatusBar = ({
  readonlyMode,
  kernelVersion,
  documentCount,
  activeCapabilities,
  capabilityCount,
  commandCount,
  notice,
}: StatusBarProps): ReactElement => {
  // 只订阅光标切片：输入时只有状态栏重渲染
  const cursor = useCursorStore((state) => state.cursor);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <footer className={styles.statusbar} data-collapsed={collapsed ? 'true' : 'false'}>
      <div className={styles.leftPill}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开状态栏' : '收起状态栏'}
          title={collapsed ? '展开状态栏' : '收起状态栏'}
          onClick={() => {
            setCollapsed((value) => !value);
          }}
        >
          <Chevron collapsed={collapsed} />
        </button>

        {collapsed ? null : (
          <div className={styles.left}>
            <span className={styles.statusGroup}>
              <span className={`${styles.dot} ${readonlyMode ? styles.dotReadonly : ''}`} />
              <span>{readonlyMode ? '只读模式' : '内核运行中'}</span>
            </span>
            <span className={styles.sep}>│</span>
            <span className={styles.statusGroup}>UTF-8</span>
            <span className={styles.sep}>│</span>
            <span className={styles.statusGroup}>LF</span>
            {notice === null || notice === undefined ? null : (
              <>
                <span className={styles.sep}>│</span>
                <span className={styles.statusGroup} role="status" title={notice}>
                  <span className={`${styles.dot} ${styles.dotReadonly}`} />
                  <span>{notice}</span>
                </span>
              </>
            )}
            {cursor === null ? null : (
              <>
                <span className={styles.sep}>│</span>
                <span className={styles.statusGroup}>
                  行 {cursor.line}，列 {cursor.column}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {collapsed ? null : (
        <div className={styles.rightPill}>
          <div className={styles.right}>
            <span className={styles.metric}>
              文档 <strong>{documentCount}</strong>
            </span>
            <span className={styles.sep}>│</span>
            <span className={styles.metric}>
              能力{' '}
              <strong>
                {activeCapabilities}/{capabilityCount}
              </strong>
            </span>
            <span className={styles.sep}>│</span>
            <span className={styles.metric}>
              命令 <strong>{commandCount}</strong>
            </span>
            <span className={styles.sep}>│</span>
            <span className={styles.metric}>{kernelVersion}</span>
          </div>
        </div>
      )}
    </footer>
  );
};
