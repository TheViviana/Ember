import { type ReactElement, type RefObject } from 'react';
import type { DocMeta } from '../../kernel/types.ts';
import type { DocTreeRow } from './doc-tree.ts';
import styles from './DocumentListPanel.module.css';

export interface DocumentTreeViewProps {
  readonly rows: readonly DocTreeRow[];
  readonly visibleDocs: number;
  readonly hasMore: boolean;
  readonly sentinelRef: RefObject<HTMLLIElement | null>;
  readonly loading: boolean;
  readonly error: string | null;
  /** 当前没有匹配文档（树与搜索共用） */
  readonly isEmpty: boolean;
  readonly expanded: ReadonlySet<string>;
  readonly activeDocId: string | null;
  readonly onToggleFolder: (path: string) => void;
  readonly onSelectDoc: (id: string) => void;
  readonly onClose: () => void;
  readonly onOpenMenu: (event: React.MouseEvent, meta: DocMeta) => void;
}

/**
 * 文档树的可见列表：文件夹行与文档行。
 * 查询非空时由调用方传入扁平行（depth 恒为 0），这里不做区分。
 */
export const DocumentTreeView = ({
  rows,
  visibleDocs,
  hasMore,
  sentinelRef,
  loading,
  error,
  isEmpty,
  expanded,
  activeDocId,
  onToggleFolder,
  onSelectDoc,
  onClose,
  onOpenMenu,
}: DocumentTreeViewProps): ReactElement => (
  <div className={styles.list}>
    {loading ? <p className={styles.note}>加载中…</p> : null}
    {error === null ? null : <p className={styles.error}>{error}</p>}
    {!loading && error === null && isEmpty ? <p className={styles.note}>库内还没有匹配的文档</p> : null}
    <ul className={styles.items}>
      {rows.slice(0, visibleDocs).map((row) => {
        if (row.kind === 'doc') {
          const id = String(row.meta.id);
          const path = String(row.meta.path);
          return (
            <li key={`doc:${id}`}>
              <button
                type="button"
                className={`${styles.item} ${activeDocId === id ? styles.itemActive : ''}`}
                style={{ paddingLeft: `calc(var(--space-sm) + ${row.depth * 14}px)` }}
                title={path}
                onClick={() => {
                  onSelectDoc(id);
                  onClose();
                }}
                onContextMenu={(event) => {
                  onOpenMenu(event, row.meta);
                }}
              >
                <span className={styles.itemHead}>
                  <span className={styles.itemTitle}>{row.meta.title}</span>
                  {row.meta.conflictOf === null ? null : <span className={styles.itemConflict}>冲突副本</span>}
                </span>
              </button>
            </li>
          );
        }
        const isOpen = expanded.has(row.path);
        return (
          <li key={`folder:${row.path}`}>
            <button
              type="button"
              className={styles.folder}
              style={{ paddingLeft: `calc(var(--space-xs) + ${row.depth * 14}px)` }}
              aria-expanded={isOpen}
              title={row.path}
              onClick={() => {
                onToggleFolder(row.path);
              }}
            >
              <span className={styles.chevron}>{isOpen ? '▾' : '▸'}</span>
              <span className={styles.folderName}>{row.name}</span>
            </button>
          </li>
        );
      })}
      {hasMore ? (
        <li className={styles.note} ref={sentinelRef} aria-hidden="true">
          滚动加载更多…
        </li>
      ) : null}
    </ul>
  </div>
);
