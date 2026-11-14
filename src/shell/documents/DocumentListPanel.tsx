import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { unsafeDocId } from '#doc-model';
import type { DocMeta } from '../../kernel/types.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { isEmberError } from '../../kernel/errors.ts';
import { useEscLayer, isEscTop } from '../esc-arbiter.ts';
import { clampVisible, growVisible, SIDEBAR_INITIAL } from '../components/list-window.ts';
import { flushMachineUiWrites, useMachineStore } from '../../data/stores/machine-store.ts';
import { DUPLICATE_DOC_COMMAND } from '../commands/shell-commands.ts';
import { useKernel } from '../kernel-provider.tsx';
import { buildTree, collectFolderPaths, flattenTree, type DocTreeRow } from './doc-tree.ts';
import { DocumentItemOverlay, type ItemOverlay } from './DocumentItemOverlay.tsx';
import { DocumentTreeView } from './DocumentTreeView.tsx';
import styles from './DocumentListPanel.module.css';

export interface DocumentListPanelProps {
  readonly documents: readonly DocMeta[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly activeDocId: string | null;
  readonly onSelectDoc: (id: string) => void;
  readonly onClose: () => void;
  /** 在画布中定位：飞到该文档的文章卡片节点（App 侧接线：openCanvas + 高亮 + 关面板） */
  readonly onOpenCanvasLocation: (canvasId: string, nodeId: string) => void;
}

/** 面板宽度在机器本地 ui.json floatSizes 里的记忆键（不与文档 ULID 冲突） */
const SIDEBAR_WIDTH_KEY = 'document-list';
/** 移动后的撤销窗口 */
const UNDO_WINDOW_MS = 8000;

interface Notice {
  readonly tone: 'ok' | 'error';
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

/**
 * 可召出的文档列表浮层（过渡期入口：⌘K 统一搜索落地前，保证随时可浏览文档）。
 * 不常驻：由顶栏按钮 / 命令 `ember.panel.documents` 召出，Esc 或外点关闭。
 * 目录按 `/` 组织成树；文档行可拖进文件夹，也可拖到画布生成节点。
 */
export const DocumentListPanel = ({
  documents,
  loading,
  error,
  activeDocId,
  onSelectDoc,
  onClose,
  onOpenCanvasLocation,
}: DocumentListPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const vaultId = String(kernel.env.vaultId);
  const [query, setQuery] = useState('');
  const [visibleDocs, setVisibleDocs] = useState(SIDEBAR_INITIAL);
  const [menu, setMenu] = useState<ItemOverlay | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [width, setWidth] = useState<number | null>(
    () => useMachineStore.getState().floatSizes[SIDEBAR_WIDTH_KEY]?.width ?? null,
  );
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

  const tree = useMemo(() => buildTree(documents), [documents]);
  const folderPaths = useMemo(() => collectFolderPaths(tree), [tree]);
  const storedExpanded = useMachineStore((state) => state.docTreeExpanded[vaultId]);
  const expanded = useMemo(() => {
    if (storedExpanded === undefined) return new Set(folderPaths);
    const valid = new Set(folderPaths);
    return new Set(storedExpanded.filter((path) => valid.has(path)));
  }, [storedExpanded, folderPaths]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const persistExpanded = useCallback(
    (next: ReadonlySet<string>): void => {
      useMachineStore.getState().setDocTreeExpanded(vaultId, [...next]);
      void flushMachineUiWrites().catch(() => undefined);
    },
    [vaultId],
  );

  // 加载时丢弃已不存在的路径：与磁盘记忆不一致就写回一次收敛后的集合
  useEffect(() => {
    if (storedExpanded === undefined) return;
    const same =
      storedExpanded.length === expanded.size && [...expanded].every((path) => storedExpanded.includes(path));
    if (same) return;
    persistExpanded(expanded);
  }, [storedExpanded, expanded, persistExpanded]);

  const toggleFolder = useCallback(
    (path: string): void => {
      const next = new Set(expandedRef.current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      persistExpanded(next);
    },
    [persistExpanded],
  );

  /**
   * 可见行：查询非空时回退为扁平结果（树里搜不到的路径也能命中）；
   * 否则按展开状态把树压平，并继续沿用哨兵分批渲染。
   */
  const rows = useMemo<readonly DocTreeRow[]>(
    () =>
      keyword.length === 0
        ? flattenTree(tree, (path) => expanded.has(path))
        : filtered.map((meta) => ({ kind: 'doc' as const, name: meta.title, depth: 0, meta })),
    [keyword.length, tree, expanded, filtered],
  );

  useEffect(() => {
    setVisibleDocs((current) => clampVisible(current, rows.length));
  }, [rows.length]);

  const hasMore = rows.length > visibleDocs;
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (node === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisibleDocs((current) => growVisible(current, rows.length));
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [hasMore, rows.length, visibleDocs]);

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

  // 带撤销的提示 8 秒后自动收起
  useEffect(() => {
    if (notice?.action === undefined) return undefined;
    const timer = window.setTimeout(() => {
      setNotice(null);
    }, UNDO_WINDOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  // ---- 右键菜单动作 ----

  const closeMenu = useCallback((): void => {
    setMenu(null);
  }, []);

  const openMenu = useCallback(
    (event: React.MouseEvent, doc: DocMeta): void => {
      event.preventDefault();
      event.stopPropagation();
      // 菜单直接盖在条目上：取条目矩形，宽度与条目一致
      const target = event.currentTarget;
      const rect = target instanceof Element ? target.getBoundingClientRect() : null;
      setMenu({
        docId: String(doc.id),
        path: String(doc.path),
        title: doc.title,
        left: rect?.left ?? event.clientX,
        top: rect?.top ?? event.clientY,
        bottom: rect?.bottom ?? event.clientY,
        w: rect?.width ?? 220,
      });
    },
    [],
  );

  const copyPath = useCallback((path: string): void => {
    void navigator.clipboard
      .writeText(path)
      .then(() => setNotice({ tone: 'ok', text: '已复制文档路径' }))
      .catch(() => setNotice({ tone: 'error', text: '复制失败：剪贴板不可用' }));
  }, []);

  /** 在画布中定位：由 App 侧完成 openCanvas + 高亮 + 关面板；本面板只负责查询 */
  const locateInCanvas = useCallback(
    (item: ItemOverlay): void => {
      void (async () => {
        try {
          const locations = await kernel.canvas.locateDoc(unsafeDocId(item.docId));
          if (locations.length === 0) {
            setNotice({ tone: 'error', text: `《${item.title}》没有文章卡片节点，从库拖入即可生成` });
            return;
          }
          const first = locations[0];
          if (first !== undefined) onOpenCanvasLocation(String(first.canvasId), String(first.nodeId));
        } catch (cause) {
          setNotice({ tone: 'error', text: `画布定位失败：${toErrorText(cause)}` });
        }
      })();
    },
    [kernel, onOpenCanvasLocation],
  );

  const duplicateDoc = useCallback((item: ItemOverlay): void => {
    void kernel.commands
      .execute(DUPLICATE_DOC_COMMAND, { docId: unsafeDocId(item.docId) })
      .then((result) => {
        if (!result.ok && result.error !== null) setNotice({ tone: 'error', text: result.error });
      })
      .catch((cause) => {
        setNotice({ tone: 'error', text: `创建副本失败：${toErrorText(cause)}` });
      });
  }, [kernel]);

  /** 删除：base 取当前磁盘 revision；stale 时提示刷新重试，绝不盲删 */
  const removeDoc = useCallback((item: ItemOverlay): void => {
    setDeleting(true);
    void (async () => {
      try {
        const snapshot = await kernel.docs.read(unsafeDocId(item.docId));
        const destination = await kernel.docs.remove(unsafeDocId(item.docId), {
          base: snapshot.meta.rev,
          intent: 'user',
        });
        // 删除成功后把各画布里引用该文章的节点转为普通 note，单个画布失败不影响其它
        let canvasNote = '';
        try {
          const detached = await kernel.canvas.detachDoc(unsafeDocId(item.docId), item.title);
          if (detached.failed > 0) {
            canvasNote = `；另有 ${detached.failed} 张画布转换失败，节点仍显示为缺失文档`;
          }
        } catch (cause) {
          canvasNote = `；画布节点转换失败（文章已删除）：${toErrorText(cause)}`;
        }
        void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
        const where =
          destination === 'internal'
            ? '库内回收目录 .workbench/trash，30 天后自动清除，系统废纸篓中没有'
            : destination === 'system'
              ? '系统回收站'
              : '文件本就不存在';
        setNotice({ tone: 'ok', text: `已删除《${item.title}》文件（${where}）${canvasNote}` });
      } catch (cause) {
        if (isEmberError(cause) && cause.code === 'stale_revision') {
          setNotice({ tone: 'error', text: `《${item.title}》刚被修改过，请刷新列表后重试` });
        } else {
          setNotice({ tone: 'error', text: `删除失败：${toErrorText(cause)}` });
        }
      } finally {
        setDeleting(false);
      }
    })();
  }, [kernel, queryClient]);

  /** 双击宽度手柄：回到默认宽度并清掉记忆 */
  const onResizeReset = (): void => {
    setWidth(null);
    useMachineStore.getState().forgetFloat(SIDEBAR_WIDTH_KEY);
  };

  /**
   * 双击靠手动检测：onResizeStart 里 preventDefault 会吞掉浏览器合成的 dblclick，
   * 两次快速按下（<400ms）视为复位意图。
   */
  const lastHandleDownAtRef = useRef(0);
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const now = performance.now();
    if (now - lastHandleDownAtRef.current < 400) {
      lastHandleDownAtRef.current = 0;
      onResizeReset();
      return;
    }
    lastHandleDownAtRef.current = now;
    const startX = event.clientX;
    const startWidth = rootRef.current?.getBoundingClientRect().width ?? 320;
    const max = Math.min(560, window.innerWidth * 0.6);
    const onMove = (moveEvent: PointerEvent): void => {
      setWidth(Math.min(Math.max(startWidth + moveEvent.clientX - startX, 240), max));
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // 松手才记忆宽度；重开面板时按记忆恢复
      const current = rootRef.current?.getBoundingClientRect().width;
      if (current !== undefined) {
        useMachineStore
          .getState()
          .rememberFloatSize(SIDEBAR_WIDTH_KEY, { width: current, height: current });
      }
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

      <DocumentTreeView
        rows={rows}
        visibleDocs={visibleDocs}
        hasMore={hasMore}
        sentinelRef={sentinelRef}
        loading={loading}
        error={error}
        isEmpty={filtered.length === 0}
        expanded={expanded}
        activeDocId={activeDocId}
        onToggleFolder={toggleFolder}
        onSelectDoc={onSelectDoc}
        onClose={onClose}
        onOpenMenu={openMenu}
      />

      {notice === null ? null : (
        <div
          className={`${styles.noticeRow} ${notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}`}
          role="status"
        >
          <span
            className={styles.noticeText}
            onClick={() => {
              setNotice(null);
            }}
          >
            {notice.text}
          </span>
          {notice.action === undefined ? null : (
            <button
              type="button"
              className={styles.noticeAction}
              onClick={() => {
                const action = notice.action;
                setNotice(null);
                action?.run();
              }}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}

      <DocumentItemOverlay
        menu={menu}
        onCloseMenu={closeMenu}
        onOpenItem={(item) => {
          onSelectDoc(item.docId);
          onClose();
        }}
        onLocate={locateInCanvas}
        onDuplicate={duplicateDoc}
        onCopyPath={copyPath}
        onDelete={removeDoc}
        deleting={deleting}
        readonlyMode={kernel.env.readonlyMode}
        readonlyReason={kernel.env.readonlyReason}
      />

      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整文档面板宽度"
        title="拖动调整宽度；双击复位"
        onPointerDown={onResizeStart}
      />
    </div>
  );
};
