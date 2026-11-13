import { useState, type ReactElement } from 'react';
import type { CanvasBookmark, CanvasFilters } from '#canvas-engine';
import { createUlid } from '#doc-model';
import { useEscLayer } from '../esc-arbiter.ts';
import styles from './BookmarkStrip.module.css';

export interface BookmarkStripProps {
  readonly bookmarks: readonly CanvasBookmark[];
  /** 保存当前镜头（视口 + 过滤条件）为书签；过滤条件由外壳捕获 */
  readonly onSave: (name: string) => void;
  /** 跳转到书签（恢复镜头与过滤条件） */
  readonly onJump: (bookmark: CanvasBookmark) => void;
  readonly onDelete: (id: string) => void;
}

/** 视图书签条：保存镜头位置 + 缩放 + 过滤条件，命名，一键跳回 */
export const BookmarkStrip = ({
  bookmarks,
  onSave,
  onJump,
  onDelete,
}: BookmarkStripProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  useEscLayer('bookmark-strip', open);

  const submit = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(trimmed);
    setName('');
  };

  return (
    <span className={styles.root} data-canvas-overlay="bookmarks">
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        title="视图书签：保存镜头与过滤，一键跳回"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">◈</span>
        书签
        {bookmarks.length > 0 ? <span className={styles.count}>{bookmarks.length}</span> : null}
      </button>

      {open ? (
        <div className={styles.popover}>
          {bookmarks.length === 0 ? (
            <p className={styles.empty}>还没有书签：调整好镜头后保存一个</p>
          ) : (
            <ul className={styles.list}>
              {bookmarks.map((bookmark) => (
                <li key={bookmark.id} className={styles.item}>
                  <button
                    type="button"
                    className={styles.jump}
                    title="跳回此视角"
                    onClick={() => {
                      onJump(bookmark);
                      setOpen(false);
                    }}
                  >
                    <span className={styles.itemName}>{bookmark.name}</span>
                    <span className={styles.itemMeta}>{Math.round(bookmark.viewport.zoom * 100)}%</span>
                  </button>
                  <button
                    type="button"
                    className={styles.delete}
                    title="删除书签"
                    onClick={() => {
                      onDelete(bookmark.id);
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.saveRow}>
            <input
              className={styles.input}
              placeholder={`书签名称…（${bookmarks.length + 1}）`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
            />
            <button type="button" className={styles.saveButton} onClick={submit}>
              保存当前视角
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
};

/** 组装一条新书签的运行时对象（id 由外壳分配） */
export const buildBookmark = (
  name: string,
  viewport: { x: number; y: number; zoom: number },
  filters: CanvasFilters | null,
): CanvasBookmark => ({
  id: `bm_${createUlid()}`,
  name,
  viewport,
  filters,
});
