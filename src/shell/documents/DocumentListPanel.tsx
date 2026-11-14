import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { unsafeDocId } from '#doc-model';
import type { DocMeta } from '../../kernel/types.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { isEmberError } from '../../kernel/errors.ts';
import { useEscLayer, isEscTop } from '../esc-arbiter.ts';
import { clampVisible, growVisible, SIDEBAR_INITIAL } from '../components/list-window.ts';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import { DUPLICATE_DOC_COMMAND } from '../commands/shell-commands.ts';
import { useKernel } from '../kernel-provider.tsx';
import { readonlyText } from '../components/readonly-text.ts';
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
  onOpenCanvasLocation,
}: DocumentListPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [visibleDocs, setVisibleDocs] = useState(SIDEBAR_INITIAL);
  /**
   * 右键菜单 / 删除确认共用同一个锚点：直接覆盖在条目本身之上（跟随条目矩形），
   * 视觉中心始终停在正在操作的那篇文档上，不在面板顶部与条目之间来回跳。
   * top/bottom 是条目矩形的上下缘：底部条目空间不足时浮层向上翻（底边对齐条目底边）。
   */
  interface ItemOverlay {
    readonly docId: string;
    readonly path: string;
    readonly title: string;
    readonly left: number;
    readonly top: number;
    readonly bottom: number;
    readonly w: number;
  }
  const [menu, setMenu] = useState<ItemOverlay | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemOverlay | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<{ readonly tone: 'ok' | 'error'; readonly text: string } | null>(null);
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

  // 右键菜单：Esc / 外点关闭（菜单比面板晚入栈，Esc 先关菜单）
  useEscLayer('doc-list-menu', menu !== null);
  useEffect(() => {
    if (menu === null) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-doc-menu]') !== null) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop('doc-list-menu')) return;
      event.preventDefault();
      setMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  // ---- 右键菜单动作 ----

  const openMenu = useCallback(
    (event: React.MouseEvent, doc: DocMeta): void => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmDelete(null);
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
    setMenu(null);
  }, []);

  /** 在画布中定位：由 App 侧完成 openCanvas + 高亮 + 关面板；本面板只负责查询 */
  const locateInCanvas = useCallback((): void => {
    const item = menu;
    if (item === null) return;
    setMenu(null);
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
  }, [kernel, menu, onOpenCanvasLocation]);

  const duplicateDoc = useCallback((item: { readonly docId: string; readonly title: string }): void => {
    setMenu(null);
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
  const removeDoc = useCallback((item: { readonly docId: string; readonly title: string }): void => {
    setConfirmDelete(null);
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

  /**
   * 覆盖层纵向定位：默认顶边对齐条目顶边；条目下方放不下时向上翻
   * （底边对齐条目底边）。effectiveBottom 给底部状态栏/工具横排让位。
   */
  const MENU_HEIGHT = 212;
  const CONFIRM_HEIGHT = 148;
  const EFFECTIVE_BOTTOM_MARGIN = 72;
  const anchorY = (overlay: ItemOverlay, height: number): number => {
    const effectiveBottom = window.innerHeight - EFFECTIVE_BOTTOM_MARGIN;
    if (overlay.top + height <= effectiveBottom) return overlay.top;
    const flipped = overlay.bottom - height;
    return Math.max(60, Math.min(flipped, effectiveBottom - height));
  };

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

      <div className={styles.list}>
        {loading ? <p className={styles.note}>加载中…</p> : null}
        {error === null ? null : <p className={styles.error}>{error}</p>}
        {!loading && error === null && filtered.length === 0 ? (
          <p className={styles.note}>库内还没有匹配的文档</p>
        ) : null}
        <ul className={styles.items}>
          {filtered.slice(0, visibleDocs).map((meta) => (
            <li
              key={String(meta.id)}
              onContextMenu={(event) => {
                openMenu(event, meta);
              }}
            >
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

      {confirmDelete === null ? null : (
        <div
          className={styles.deleteConfirm}
          role="alertdialog"
          aria-label="确认删除文档"
          style={{
            left: confirmDelete.left,
            top: anchorY(confirmDelete, CONFIRM_HEIGHT),
            width: confirmDelete.w,
          }}
        >
          <p className={styles.deleteText}>
            删除《{confirmDelete.title}》？文件优先移入系统回收站；系统回收站不可用时落入库内回收目录
            （.workbench/trash），30 天后自动清除。
          </p>
          <div className={styles.deleteActions}>
            <button
              type="button"
              className={styles.deleteYes}
              disabled={deleting}
              onClick={() => {
                removeDoc(confirmDelete);
              }}
            >
              {deleting ? '删除中…' : '删除'}
            </button>
            <button
              type="button"
              className={styles.deleteNo}
              onClick={() => {
                setConfirmDelete(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {notice === null ? null : (
        <p
          className={notice.tone === 'ok' ? styles.noticeOk : styles.noticeError}
          role="status"
          onClick={() => {
            setNotice(null);
          }}
        >
          {notice.text}
        </p>
      )}

      {menu === null ? null : (
        <div
          className={styles.contextMenu}
          data-doc-menu=""
          role="menu"
          aria-label={`文档操作：${menu.title}`}
          style={{ left: menu.left, top: anchorY(menu, MENU_HEIGHT), width: menu.w }}
        >
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              const item = menu;
              setMenu(null);
              onSelectDoc(item.docId);
              onClose();
            }}
          >
            打开浮窗
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              locateInCanvas();
            }}
          >
            在画布中定位
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              duplicateDoc(menu);
            }}
          >
            创建副本
          </button>
          <button
            type="button"
            className={styles.menuItem}
            role="menuitem"
            onClick={() => {
              copyPath(menu.path);
            }}
          >
            复制路径
          </button>
          <button
            type="button"
            className={`${styles.menuItem} ${styles.menuDanger}`}
            role="menuitem"
            disabled={kernel.env.readonlyMode}
            title={
              kernel.env.readonlyMode
                ? readonlyText(kernel.env.readonlyReason)
                : '优先移入系统回收站；不可用时落入库内回收目录（30 天后清除）'
            }
            onClick={() => {
              // 确认条原地替换菜单：位置、宽度都继承条目锚点，视线不跳动
              setConfirmDelete(menu);
              setMenu(null);
            }}
          >
            删除…
          </button>
        </div>
      )}

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
