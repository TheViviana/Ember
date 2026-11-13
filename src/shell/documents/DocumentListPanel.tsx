import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { DocMeta } from '../../kernel/types.ts';
import { useEscLayer, isEscTop } from '../esc-arbiter.ts';
import { clampVisible, growVisible, SIDEBAR_INITIAL } from '../components/list-window.ts';
import styles from './DocumentListPanel.module.css';

export interface DocumentListPanelProps {
  readonly documents: readonly DocMeta[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly activeDocId: string | null;
  readonly onSelectDoc: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * 可召出的文档列表浮层（过渡期入口：⌘K 统一搜索落地前，保证随时可浏览文档）。
 * 不常驻：由顶栏按钮 / 命令 `ember.panel.documents` 召出，Esc 或外点关闭。
 */
export const DocumentListPanel = ({
  documents,
  loading,
  error,
  activeDocId,
  onSelectDoc,
  onClose,
}: DocumentListPanelProps): ReactElement => {
  const [query, setQuery] = useState('');
  const [visibleDocs, setVisibleDocs] = useState(SIDEBAR_INITIAL);
  const [width, setWidth] = useState<number | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEscLayer('document-list', true);

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      keyword.length === 0
        ? documents
        : documents.filter(
            (meta) =>
              meta.title.toLowerCase().includes(keyword) ||
              String(meta.path).toLowerCase().includes(keyword) ||
              meta.tags.some((tag) => tag.toLowerCase().includes(keyword)),
          ),
    [documents, keyword],
  );

  useEffect(() => {
    setVisibleDocs((current) => clampVisible(current, filtered.length));
  }, [filtered]);

  const hasMore = filtered.length > visibleDocs;
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleDocs((current) => growVisible(current, filtered.length));
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasMore, filtered.length, visibleDocs]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isEscTop('document-list')) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = rootRef.current?.getBoundingClientRect().width ?? 320;
    const max = Math.min(560, window.innerWidth * 0.6);
    const onMove = (moveEvent: PointerEvent): void => {
      setWidth(Math.min(Math.max(startWidth + moveEvent.clientX - startX, 240), max));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={styles.root}
      ref={rootRef}
      style={width === null ? undefined : { width }}
      data-canvas-overlay="document-list"
    >
      <header className={styles.header}>
        <span className={styles.headerIcon}>◇</span>
        <span className={styles.headerTitle}>文档</span>
        <span className={styles.headerCount}>{filtered.length}</span>
        <button type="button" className={styles.close} onClick={onClose} title="关闭">
          ✕
        </button>
      </header>

      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          placeholder="按标题 / 路径 / 标签筛选…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
      </div>

      <div className={styles.list}>
        {loading ? <p className={styles.note}>加载中…</p> : null}
        {error === null ? null : <p className={styles.error}>{error}</p>}
        {!loading && error === null && filtered.length === 0 ? (
          <p className={styles.note}>库内还没有匹配的文档</p>
        ) : null}
        <ul className={styles.items}>
          {filtered.slice(0, visibleDocs).map((meta) => (
            <li key={String(meta.id)}>
              <button
                type="button"
                className={`${styles.item} ${activeDocId === String(meta.id) ? styles.itemActive : ''}`}
                onClick={() => {
                  onSelectDoc(String(meta.id));
                  onClose();
                }}
              >
                <span className={styles.itemHead}>
                  <span className={styles.itemTitle}>{meta.title}</span>
                  {meta.conflictOf === null ? null : (
                    <span className={styles.itemConflict}>冲突副本</span>
                  )}
                </span>
                <span className={styles.itemPath}>{String(meta.path)}</span>
              </button>
            </li>
          ))}
          {hasMore ? (
            <li className={styles.note} ref={sentinelRef} aria-hidden="true">
              滚动加载更多…
            </li>
          ) : null}
        </ul>
      </div>

      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整文档面板宽度"
        title="拖动调整宽度"
        onPointerDown={onResizeStart}
      />
    </div>
  );
};
