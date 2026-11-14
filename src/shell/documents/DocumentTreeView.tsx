import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement, type RefObject } from 'react';
import type { DocMeta } from '../../kernel/types.ts';
import { parentDirOf, type DocTreeRow } from './doc-tree.ts';
import { beginDocDrag, endDocDrag } from './doc-drag.ts';
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
  readonly onExpandFolder: (path: string) => void;
  readonly onSelectDoc: (id: string) => void;
  readonly onClose: () => void;
  readonly onOpenMenu: (event: React.MouseEvent, meta: DocMeta) => void;
  readonly onMoveDoc: (docId: string, fromPath: string, targetDir: string) => void;
}

/** 拖拽悬停多久自动展开折叠目录 */
const HOVER_EXPAND_MS = 500;
/** 列表上下边缘的自动滚动触发带 */
const EDGE_SCROLL_ZONE = 12;
const EDGE_SCROLL_STEP = 12;

interface DragSource {
  readonly docId: string;
  readonly path: string;
  readonly parentDir: string;
}

/**
 * 文档树的可见列表：文件夹行、文档行、库根落点与拖拽反馈。
 * 拖拽状态只活在这里；移动本身交给 onMoveDoc（统一走 docs.rename + 撤销）。
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
  onExpandFolder,
  onSelectDoc,
  onClose,
  onOpenMenu,
  onMoveDoc,
}: DocumentTreeViewProps): ReactElement => {
  const [dragging, setDragging] = useState<DragSource | null>(null);
  /** 当前悬停的落点目录；空串代表「库根」 */
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverPathRef = useRef<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const clearHoverExpand = useCallback((): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    hoverPathRef.current = null;
  }, []);

  useEffect(
    () => () => {
      clearHoverExpand();
    },
    [clearHoverExpand],
  );

  const finishDrag = (): void => {
    endDocDrag();
    clearHoverExpand();
    setDragging(null);
    setDragOverDir(null);
  };

  const onDocDragStart = (event: ReactDragEvent<HTMLButtonElement>, meta: DocMeta): void => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-ember-doc', String(meta.id));
    event.dataTransfer.setData('text/plain', String(meta.path));
    beginDocDrag();
    setDragging({ docId: String(meta.id), path: String(meta.path), parentDir: parentDirOf(String(meta.path)) });
    setDragOverDir(null);
  };

  const onFolderDragOver = (event: ReactDragEvent<HTMLButtonElement>, dir: string): void => {
    if (dragging === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDragOverDir(dir);
    if (expandedRef.current.has(dir) || hoverPathRef.current === dir) return;
    clearHoverExpand();
    hoverPathRef.current = dir;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      hoverPathRef.current = null;
      if (expandedRef.current.has(dir)) return;
      onExpandFolder(dir);
    }, HOVER_EXPAND_MS);
  };

  const onFolderDragLeave = (event: ReactDragEvent<HTMLButtonElement>, dir: string): void => {
    // 移入行内子元素也会触发 dragleave：目标仍在行内就不算离开
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (hoverPathRef.current === dir) clearHoverExpand();
    setDragOverDir((current) => (current === dir ? null : current));
  };

  const onFolderDrop = (event: ReactDragEvent<HTMLButtonElement>, dir: string): void => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragging;
    finishDrag();
    if (source === null) return;
    onMoveDoc(source.docId, source.path, dir);
  };

  const onRootDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragging;
    finishDrag();
    if (source === null) return;
    onMoveDoc(source.docId, source.path, '');
  };

  /** 列表上下边缘 12px 自动滚动：dragover 持续触发，按事件步进即可 */
  const onListDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (dragging === null) return;
    event.preventDefault();
    const node = listRef.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    if (event.clientY < rect.top + EDGE_SCROLL_ZONE) node.scrollTop -= EDGE_SCROLL_STEP;
    else if (event.clientY > rect.bottom - EDGE_SCROLL_ZONE) node.scrollTop += EDGE_SCROLL_STEP;
  };

  return (
    <div className={styles.list} ref={listRef} onDragOver={onListDragOver}>
      {loading ? <p className={styles.note}>加载中…</p> : null}
      {error === null ? null : <p className={styles.error}>{error}</p>}
      {!loading && error === null && isEmpty ? <p className={styles.note}>库内还没有匹配的文档</p> : null}
      <ul className={styles.items}>
        {dragging === null ? null : (
          <li>
            <div
              className={`${styles.rootDrop} ${dragOverDir === '' ? styles.rootDropActive : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                setDragOverDir('');
              }}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                setDragOverDir((current) => (current === '' ? null : current));
              }}
              onDrop={onRootDrop}
            >
              拖到这里 → 库根
            </div>
          </li>
        )}
        {rows.slice(0, visibleDocs).map((row) => {
          if (row.kind === 'doc') {
            const id = String(row.meta.id);
            const path = String(row.meta.path);
            return (
              <li key={`doc:${id}`}>
                <button
                  type="button"
                  draggable
                  className={`${styles.item} ${activeDocId === id ? styles.itemActive : ''}`}
                  style={{ paddingLeft: `calc(var(--space-sm) + ${row.depth * 14}px)` }}
                  title={path}
                  onClick={() => {
                    onSelectDoc(id);
                    onClose();
                  }}
                  onDragStart={(event) => {
                    onDocDragStart(event, row.meta);
                  }}
                  onDragEnd={finishDrag}
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
          const isCurrent = dragging !== null && dragging.parentDir === row.path;
          const isOver = dragOverDir === row.path;
          const dropClass = isOver ? (isCurrent ? styles.dropCurrent : styles.dropTarget) : '';
          return (
            <li key={`folder:${row.path}`}>
              <button
                type="button"
                className={`${styles.folder} ${dropClass}`}
                style={{ paddingLeft: `calc(var(--space-xs) + ${row.depth * 14}px)` }}
                aria-expanded={isOpen}
                title={row.path}
                onClick={() => {
                  onToggleFolder(row.path);
                }}
                onDragOver={(event) => {
                  onFolderDragOver(event, row.path);
                }}
                onDragLeave={(event) => {
                  onFolderDragLeave(event, row.path);
                }}
                onDrop={(event) => {
                  onFolderDrop(event, row.path);
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
};
