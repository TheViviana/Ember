import { useEffect, useRef, useState, type ReactElement } from 'react';
import { splitTitleForEllipsis } from './float-layout.ts';
import styles from './FloatTitle.module.css';

export type StatusTone = 'ok' | 'pending' | 'alert';

export interface FloatTitleProps {
  readonly title: string;
  readonly statusText: string;
  readonly statusTone: StatusTone;
  /** 阅读时长（分钟）；null 表示正文为空，不展示 */
  readonly readingMinutes: number | null;
  /** 打开浮窗时直接进入标题编辑（新建文章后） */
  readonly autoFocus: boolean;
  /** 当前浮窗是否处于专注模式；决定按钮图标与提示 */
  readonly focused: boolean;
  readonly onCommit: (value: string) => void;
  readonly onToggleFocus: () => void;
  readonly onClose: () => void;
}

/**
 * 标题栏第一行：点击标题原地输入，Enter / 失焦提交，Esc 放弃；
 * 非编辑态用「前半段收缩 + 后半段固定」实现中间省略。
 */
export const FloatTitle = ({
  title,
  statusText,
  statusTone,
  readingMinutes,
  autoFocus,
  focused,
  onCommit,
  onToggleFocus,
  onClose,
}: FloatTitleProps): ReactElement => {
  const [editing, setEditing] = useState(autoFocus);
  const [draft, setDraft] = useState(title);
  const settled = useRef(false);
  const touched = useRef(false);

  // 打开时快照异步到达：用户还没输入就跟随真实标题，避免提交空值覆盖标题
  useEffect(() => {
    if (!touched.current) setDraft(title);
  }, [title]);

  const startEditing = (): void => {
    settled.current = false;
    touched.current = false;
    setDraft(title);
    setEditing(true);
  };

  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    if (commit) onCommit(draft);
    else setDraft(title);
  };

  const parts = splitTitleForEllipsis(title);

  return (
    <div className={styles.bar}>
      <div className={styles.titleSlot}>
        {editing ? (
          <input
            className={styles.input}
            value={draft}
            aria-label="文章标题"
            placeholder="未命名"
            autoFocus
            onChange={(event) => {
              touched.current = true;
              setDraft(event.target.value);
            }}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onBlur={() => {
              finish(true);
            }}
            onKeyDown={(event) => {
              // IME 组合态的 Enter/Esc 是确认候选词/取消组合，不提交标题
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className={styles.titleButton}
            title={title.length === 0 ? '未命名' : title}
            onClick={startEditing}
          >
            {title.length === 0 ? (
              <span className={styles.placeholder}>未命名</span>
            ) : (
              <>
                <span className={styles.head}>{parts.head}</span>
                <span className={styles.tail}>{parts.tail}</span>
              </>
            )}
          </button>
        )}
      </div>

      {readingMinutes === null ? null : (
        <span
          className={styles.reading}
          title="阅读时长：中文 300 字/分钟、其他 200 词/分钟，向上取整"
        >
          {readingMinutes} 分钟
        </span>
      )}

      <span className={`${styles.status} ${styles[`status_${statusTone}`] ?? ''}`}>{statusText}</span>

      <button
        type="button"
        className={styles.focus}
        data-float-focus
        aria-pressed={focused}
        title={focused ? '退出专注模式（Esc）' : '进入专注模式（⌘⇧F）'}
        aria-label={focused ? '退出专注模式' : '进入专注模式'}
        onPointerDown={(event) => {
          // 按钮上的按下不启动标题栏拖动
          event.stopPropagation();
        }}
        onClick={onToggleFocus}
      >
        {focused ? '⤡' : '⤢'}
      </button>

      <button type="button" className={styles.close} data-float-close onClick={onClose} aria-label="关闭浮窗">
        ×
      </button>
    </div>
  );
};
