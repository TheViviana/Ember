import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { CanvasBookmark, CanvasFilters, CanvasGrid, CanvasNode, CanvasScene } from '#canvas-engine';
import type { CanvasId, DocId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { FloatLayer } from '../editor/FloatLayer.tsx';
import type { CursorPosition } from '../editor/cursor.ts';
import { AnchorMenu } from './AnchorMenu.tsx';
import { CanvasHistoryPanel } from './CanvasHistoryPanel.tsx';
import { EMPTY_FILTERS, useCanvasViewStore } from './canvas-view-store.ts';
import { buildBookmark } from './BookmarkStrip.tsx';
import { ContextMenu, LabelPrompt } from './ContextMenu.tsx';
import { boundsOfRects, fitViewport, orderedNodes } from './geometry.ts';
import {
  CanvasEmptyHint,
  CanvasEdgePass,
  CanvasGridLayer,
  CanvasHud,
  CanvasMarquee,
  CanvasNodePass,
  EMPTY_CANVAS_EDGES,
} from './render-pass.tsx';
import { resolveNodeTags } from './node-tags.ts';
import { registerCaptureProvider } from './canvas-capture.ts';
import { drainCanvasView, subscribeCanvasView } from './canvas-view-signal.ts';
import { RecentEditsLayer } from './RecentEditsLayer.tsx';
import { useMachineStore, flushMachineUiWrites } from '../../data/stores/machine-store.ts';
import { screenToWorld, snapValue } from './geometry.ts';
import { readAsset } from '../../data/tauri/asset-port.ts';
import { useCanvasCommands, type AnchorMenuState, type MenuState } from './use-canvas-commands.ts';
import { useCanvasImages } from './use-canvas-images.ts';
import { useCanvasDocument } from './use-canvas-document.ts';
import { useCanvasGestures } from './use-canvas-gestures.ts';
import styles from './CanvasSurface.module.css';

const DEFAULT_GRID: CanvasGrid = { size: 8, snap: false };
const FIT_PADDING = 80;

export interface CanvasSurfaceProps {
  /** 由画布库导航决定：总览或任一画布 */
  readonly canvasId: CanvasId;
  readonly onOpenFloat: (docId: DocId, focus: 'title' | null) => void;
  readonly onCursor: (position: CursorPosition | null) => void;
  /** Portal 双击进入 */
  readonly onEnterPortal: (target: CanvasId) => void;
  /** 画布清单索引：Portal 标题/节点数/存在性 + 工具条过滤选项 */
  readonly canvasIndex: ReadonlyMap<string, { readonly title: string; readonly nodeCount: number }>;
}

/** 过滤器是否命中节点（标签 / 类型 / 关键词） */
const nodeMatchesFilters = (
  node: CanvasNode,
  filters: CanvasFilters,
  docIndex: ReadonlyMap<string, { readonly tags: readonly string[]; readonly title: string; readonly summary: string }>,
): boolean => {
  if (filters.kinds.length > 0 && !filters.kinds.includes(node.kind)) return false;
  if (filters.tags.length > 0) {
    const doc = node.docId === null ? undefined : docIndex.get(String(node.docId));
    const tags = resolveNodeTags(node.kind, node.meta, doc?.tags);
    if (!filters.tags.every((tag) => tags.includes(tag))) return false;
  }
  const keyword = filters.text.trim().toLowerCase();
  if (keyword.length > 0) {
    const doc = node.docId === null ? undefined : docIndex.get(String(node.docId));
    const haystack = [
      node.text ?? '',
      doc?.title ?? '',
      doc?.summary ?? '',
      typeof node.meta['portalTitle'] === 'string' ? node.meta['portalTitle'] : '',
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  return true;
};

/**
 * 主页画布：DOM 节点 + SVG 连线，视口手势（滚轮缩放 / 空格或中键平移 / 空白拖拽框选）。
 * 场景状态唯一来源是内核 CanvasSession；本组件负责组合文档、手势与命令三个 Hook，
 * 并承载画布工具条（视图书签 / 过滤）。
 */
export const CanvasSurface = ({
  canvasId,
  onOpenFloat,
  onCursor,
  onEnterPortal,
  canvasIndex,
}: CanvasSurfaceProps): ReactElement => {
  const kernel = useKernel();
  const doc = useCanvasDocument(canvasId);
  const { scene, surfaceRef, sceneRef, viewportRef, commitViewport, mountedRef } = doc;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [anchorMenu, setAnchorMenu] = useState<AnchorMenuState | null>(null);
  const [filters, setFilters] = useState<CanvasFilters>(EMPTY_FILTERS);
  /** 在画布中定位：镜头飞到节点后短暂高亮 */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 双击图片节点的大图浮层 */
  const [lightboxAsset, setLightboxAsset] = useState<string | null>(null);
  /** 历史版本浮层 */
  const [historyOpen, setHistoryOpen] = useState(false);

  const closeHistory = useCallback((): void => {
    setHistoryOpen(false);
  }, []);
  const toggleHistory = useCallback((): void => {
    setHistoryOpen((value) => !value);
  }, []);
  const applyRestoredHistory = useCallback(
    (scene: CanvasScene): void => {
      commitViewport(scene.viewport);
      setHistoryOpen(false);
    },
    [commitViewport],
  );

  /** 最近编辑层（画布开关，机器本地记忆） */
  const recentEditsOpen = useMachineStore(
    (state) => state.canvasFlags[String(canvasId)]?.recentEdits === true,
  );
  const toggleRecentEdits = useCallback((): void => {
    const key = String(canvasId);
    const flags = useMachineStore.getState().canvasFlags;
    const next = !(flags[key]?.recentEdits === true);
    useMachineStore.getState().setCanvasFlag(key, { recentEdits: next });
    void flushMachineUiWrites().catch(() => undefined);
  }, [canvasId]);

  const clearMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const activeFilters = filters.tags.length + filters.kinds.length + (filters.text.trim().length > 0 ? 1 : 0);

  const orderedAll = useMemo(() => orderedNodes(scene?.nodes ?? []), [scene]);
  /** 过滤结果：dim 压暗全部节点；hide 从渲染中剔除（组随成员一起隐藏判断过重，按节点自身判定） */
  const { ordered, visibleEdges, dimmedIds } = useMemo(() => {
    if (activeFilters === 0 || scene === null) {
      return { ordered: orderedAll, visibleEdges: scene?.edges ?? EMPTY_CANVAS_EDGES, dimmedIds: new Set<string>() };
    }
    const hidden = new Set<string>();
    const dimmed = new Set<string>();
    for (const node of scene.nodes) {
      if (!nodeMatchesFilters(node, filters, doc.docIndex)) {
        (filters.mode === 'hide' ? hidden : dimmed).add(node.id);
      }
    }
    // hide 模式下两端涉及隐藏节点的连线一并隐藏，避免边画进空处
    const visibleEdges =
      filters.mode === 'hide' && hidden.size > 0
        ? scene.edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to))
        : scene.edges;
    return {
      ordered: orderedAll.filter((node) => !hidden.has(node.id)),
      visibleEdges,
      dimmedIds: filters.mode === 'hide' ? new Set<string>() : dimmed,
    };
  }, [activeFilters, filters, orderedAll, scene, doc.docIndex]);

  const nodeIndex = useMemo(
    () => new Map((scene?.nodes ?? []).map((node) => [node.id, node])),
    [scene],
  );

  /** 过滤选项里的标签：文档节点取文档标签，自由文本取 meta.tags */
  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const node of scene?.nodes ?? []) {
      const doc0 = node.docId === null ? undefined : doc.docIndex.get(String(node.docId));
      for (const tag of resolveNodeTags(node.kind, node.meta, doc0?.tags)) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [scene, doc.docIndex]);

  const gestures = useCanvasGestures({
    surfaceRef,
    scene,
    canvasId,
    viewportRef,
    commitViewport,
    reportError: doc.reportError,
    nodeIndex,
    mountedRef,
    clearMenu,
    setAnchorMenu,
  });

  const commands = useCanvasCommands({
    surfaceRef,
    scene,
    sceneRef,
    canvasId,
    viewportRef,
    selected: gestures.selected,
    setSelected: gestures.setSelected,
    setSelectedEdgeId: gestures.setSelectedEdgeId,
    setEditingId: gestures.setEditingId,
    docIndex: doc.docIndex,
    commitViewport,
    showError: doc.showError,
    reportError: doc.reportError,
    onOpenFloat,
    menu,
    setMenu,
    anchorMenu,
    setAnchorMenu,
    mountedRef,
  });

  // 切换画布时重置画布局部状态：过滤/菜单/高亮/浮层/选中集/提示框都只属于当前画布。
  // 不能给整个组件加 key 重挂载——FloatLayer 在组件内部，重挂载会杀掉全部浮窗。
  // 视图请求（书签/搜索跳转）在重置之后的 drain effect 里恢复，不会被这里清掉。
  // 全部是稳定引用：effect 只在 canvasId 变化时触发，不会清掉正在进行的框选
  const { resetTransient } = gestures;
  const { cancelArticlePrompt, cancelEdgeLabel } = commands;
  useEffect(() => {
    setMenu(null);
    setAnchorMenu(null);
    setLightboxAsset(null);
    setHighlightId(null);
    setHistoryOpen(false);
    setFilters(EMPTY_FILTERS);
    resetTransient();
    cancelArticlePrompt();
    cancelEdgeLabel();
  }, [canvasId, resetTransient, cancelArticlePrompt, cancelEdgeLabel]);

  // 请求到达（同画布跳转）时 bump 一次，让 drain effect 也能在同画布场景运行
  const [viewTick, setViewTick] = useState(0);
  useEffect(() => {
    const subscription = subscribeCanvasView(() => setViewTick((tick) => tick + 1));
    return () => {
      subscription.dispose();
    };
  }, []);

  // 排水：声明顺序在重置 effect 之后 → 跨画布请求在重置后应用
  useEffect(() => {
    const request = drainCanvasView();
    if (request === null) return;
    if (request.viewport !== undefined) commitViewport(request.viewport);
    if (request.filters !== undefined) {
      setFilters(request.filters === null ? EMPTY_FILTERS : request.filters);
    }
    if (request.highlightNodeId !== undefined) {
      setHighlightId(request.highlightNodeId);
      window.setTimeout(() => {
        setHighlightId(null);
      }, 2500);
    }
  }, [canvasId, viewTick, commitViewport]);

  /** 保存当前镜头（视口 + 过滤条件）为书签；setBookmarks 走内核原子写 */
  const saveBookmark = useCallback(
    (name: string): void => {
      if (scene === null) return;
      const bookmark = buildBookmark(name, viewportRef.current, activeFilters > 0 ? filters : null);
      const nextBookmarks: readonly CanvasBookmark[] = [...scene.bookmarks, bookmark];
      void kernel.canvas
        .apply(canvasId, [{ type: 'setBookmarks', bookmarks: nextBookmarks }])
        .catch(doc.reportError);
    },
    [activeFilters, canvasId, filters, kernel, doc.reportError, scene, viewportRef],
  );

  const jumpBookmark = useCallback(
    (bookmark: CanvasBookmark): void => {
      commitViewport(bookmark.viewport);
      if (bookmark.filters !== null) setFilters(bookmark.filters);
      else setFilters(EMPTY_FILTERS);
    },
    [commitViewport],
  );

  const deleteBookmark = useCallback(
    (id: string): void => {
      if (scene === null) return;
      const nextBookmarks = scene.bookmarks.filter((bookmark) => bookmark.id !== id);
      void kernel.canvas
        .apply(canvasId, [{ type: 'setBookmarks', bookmarks: nextBookmarks }])
        .catch(doc.reportError);
    },
    [canvasId, kernel, doc.reportError, scene],
  );

  // 快捷捕获：向命令提供「当前画布 + 镜头中心（已吸附网格）」
  useEffect(() => {
    const registration = registerCaptureProvider(() => {
      const element = surfaceRef.current;
      if (element === null || canvasId === null) return null;
      const center = screenToWorld(
        { x: element.clientWidth / 2, y: element.clientHeight / 2 },
        viewportRef.current,
      );
      const grid = sceneRef.current?.grid ?? { size: 8, snap: false };
      return {
        canvasId: String(canvasId),
        point: {
          x: snapValue(center.x, grid),
          y: snapValue(center.y, grid),
        },
        z: (sceneRef.current?.nodes.reduce((max, node) => Math.max(max, node.z), 0) ?? 0) + 1,
      };
    });
    return () => {
      registration.dispose();
    };
  }, [canvasId, surfaceRef, viewportRef, sceneRef]);

  /** 双击图片节点 → 大图浮层 */
  const openAsset = useCallback((assetPath: string): void => {
    setLightboxAsset(assetPath);
  }, []);

  // 图片拖入/粘贴入库：核心在 use-canvas-images.ts（拖放与 ⌘V 共用）
  const { onDropFiles } = useCanvasImages({
    canvasId,
    kernel,
    viewportRef,
    sceneRef,
    showError: doc.showError,
    surfaceRef,
  });

  const closeAsset = useCallback((): void => {
    setLightboxAsset(null);
  }, []);

  const fitView = useCallback((): void => {
    const element = surfaceRef.current;
    if (element === null || scene === null) return;
    const bounds = boundsOfRects(scene.nodes.map((node) => node.rect));
    if (bounds === null) {
      commitViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    commitViewport(
      fitViewport(bounds, { w: element.clientWidth, h: element.clientHeight }, FIT_PADDING),
    );
  }, [commitViewport, scene, surfaceRef]);

  const resetView = useCallback((): void => {
    commitViewport({ x: 0, y: 0, zoom: 1 });
  }, [commitViewport]);

  // 把画布视图动作注册给顶栏左侧菜单（过滤 / 书签 / 适应 / 历史）
  useEffect(() => {
    const setActions = useCanvasViewStore.getState().setActions;
    setActions({
      filters,
      availableTags,
      bookmarks: scene?.bookmarks ?? [],
      recentEditsOpen,
      historyOpen,
      setFilters,
      saveBookmark,
      jumpBookmark,
      deleteBookmark,
      fitView,
      resetView,
      toggleRecentEdits,
      toggleHistory,
    });
    return () => {
      setActions(null);
    };
  }, [
    filters,
    availableTags,
    scene,
    recentEditsOpen,
    historyOpen,
    setFilters,
    saveBookmark,
    jumpBookmark,
    deleteBookmark,
    fitView,
    resetView,
    toggleRecentEdits,
    toggleHistory,
  ]);

  const surfaceClass = [styles.canvas, gestures.space ? styles.grab : '', gestures.panning ? styles.grabbing : '']
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');

  return (
    <div
      ref={surfaceRef}
      className={surfaceClass}
      aria-label="无限画布"
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerUp}
      onContextMenu={commands.onContextMenu}
      onDragOver={(event) => {
        if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        // 拖放目标始终接管：不给浏览器留下「导航打开文件」的默认行为
        if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
        onDropFiles(event);
      }}
    >
      <CanvasGridLayer grid={scene?.grid ?? DEFAULT_GRID} viewport={doc.viewport} />

      <CanvasEdgePass
        edges={
          activeFilters > 0 && filters.mode === 'hide'
            ? visibleEdges
            : (scene?.edges ?? EMPTY_CANVAS_EDGES)
        }
        nodeIndex={nodeIndex}
        selectedEdgeId={gestures.selectedEdgeId}
        onSelectEdge={gestures.selectEdge}
        tick={gestures.edgeTick}
        viewport={doc.viewport}
        connect={gestures.connect}
        draft={gestures.draft}
      />

      <CanvasNodePass
        ordered={ordered}
        draft={gestures.draft}
        selected={gestures.selected}
        docIndex={doc.docIndex}
        editingId={gestures.editingId}
        connect={gestures.connect}
        viewport={doc.viewport}
        canvasIndex={canvasIndex}
        dimmedIds={dimmedIds}
        highlightId={highlightId}
        onStartEdit={gestures.setEditingId}
        onCommitText={commands.commitText}
        onOpenDoc={commands.openDoc}
        onEnterPortal={(target: string) => onEnterPortal(target as CanvasId)}
        onOpenAsset={openAsset}
      />

      <CanvasMarquee rect={gestures.marquee} viewport={doc.viewport} />

      {(recentEditsOpen && canvasId !== null) || historyOpen ? (
        <div className={styles.overlayRow}>
          {recentEditsOpen && canvasId !== null ? (
            <div className={styles.overlaySlot}>
              <RecentEditsLayer canvasId={String(canvasId)} onClose={toggleRecentEdits} />
            </div>
          ) : null}
          {historyOpen ? (
            <div className={styles.overlaySlot}>
              <CanvasHistoryPanel
                canvasId={canvasId}
                onClose={closeHistory}
                onRestored={applyRestoredHistory}
                onError={doc.showError}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {anchorMenu === null ? null : (
        <AnchorMenu
          x={anchorMenu.x}
          y={anchorMenu.y}
          docs={doc.documents.data ?? []}
          purpose={anchorMenu.purpose}
          onNote={commands.createAnchorNote}
          onPickDoc={commands.pickAnchorDoc}
          onNewArticle={commands.startAnchorArticle}
          onClose={commands.closeAnchorMenu}
        />
      )}

      {menu === null ? null : (
        <ContextMenu
          items={menu.items}
          x={menu.x}
          y={menu.y}
          onSelect={commands.onMenuSelect}
          onClose={commands.closeMenu}
        />
      )}

      {commands.labelPrompt === null ? null : (
        <LabelPrompt
          x={commands.labelPrompt.x}
          y={commands.labelPrompt.y}
          value={commands.labelPrompt.value}
          onSubmit={commands.submitEdgeLabel}
          onCancel={commands.cancelEdgeLabel}
        />
      )}

      {commands.articlePrompt === null ? null : (
        <LabelPrompt
          x={commands.articlePrompt.x}
          y={commands.articlePrompt.y}
          value={commands.articlePrompt.value}
          onSubmit={commands.submitArticle}
          onCancel={commands.cancelArticlePrompt}
        />
      )}

      <FloatLayer onCursor={onCursor} />

      {lightboxAsset === null ? null : (
        <div className={styles.lightbox} data-canvas-overlay="lightbox" onClick={closeAsset} role="presentation">
          <AssetLightbox assetPath={lightboxAsset} />
        </div>
      )}

      <CanvasEmptyHint visible={scene !== null && scene.nodes.length === 0} />

      <CanvasHud
        viewport={doc.viewport}
        scene={scene}
        refreshMs={gestures.refreshMs}
        dragPerf={gestures.dragPerf}
      />

      {doc.isPending ? <p className={styles.notice}>正在打开画布…</p> : null}
      {doc.failure === null ? null : <p className={styles.error}>{doc.failure}</p>}
    </div>
  );
};

/** 大图浮层：读原图（不降采样），点击遮罩关闭 */
const AssetLightbox = ({ assetPath }: { readonly assetPath: string }): ReactElement => {
  const query = useQuery({
    queryKey: ['asset', 'read', assetPath],
    queryFn: () => readAsset(assetPath),
    staleTime: 5 * 60_000,
  });
  const data = query.data;
  if (data === undefined) {
    return <p className={styles.lightboxHint}>加载中…</p>;
  }
  return (
    <img
      className={styles.lightboxImage}
      src={`data:${data.mime};base64,${data.data}`}
      alt={assetPath}
      draggable={false}
    />
  );
};
