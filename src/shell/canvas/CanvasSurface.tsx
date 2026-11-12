import { useCallback, useMemo, useState, type ReactElement } from 'react';
import type { CanvasGrid } from '#canvas-engine';
import type { DocId } from '#doc-model';
import { FloatLayer } from '../editor/FloatLayer.tsx';
import type { CursorPosition } from '../editor/cursor.ts';
import { AnchorMenu } from './AnchorMenu.tsx';
import { ContextMenu, LabelPrompt } from './ContextMenu.tsx';
import { orderedNodes } from './geometry.ts';
import {
  CanvasEmptyHint,
  CanvasEdgePass,
  CanvasGridLayer,
  CanvasHud,
  CanvasMarquee,
  CanvasNodePass,
  EMPTY_CANVAS_EDGES,
} from './render-pass.tsx';
import { useCanvasCommands, type AnchorMenuState, type MenuState } from './use-canvas-commands.ts';
import { useCanvasDocument } from './use-canvas-document.ts';
import { useCanvasGestures } from './use-canvas-gestures.ts';
import styles from './CanvasSurface.module.css';

const DEFAULT_GRID: CanvasGrid = { size: 8, snap: false };

export interface CanvasSurfaceProps {
  readonly onOpenFloat: (docId: DocId, focus: 'title' | null) => void;
  readonly onCursor: (position: CursorPosition | null) => void;
}

/**
 * 主页画布：DOM 节点 + SVG 连线，视口手势（滚轮缩放 / 空格或中键平移 / 空白拖拽框选）。
 * 场景状态唯一来源是内核 CanvasSession；本组件只负责组合文档、手势与命令三个 Hook。
 */
export const CanvasSurface = ({ onOpenFloat, onCursor }: CanvasSurfaceProps): ReactElement => {
  const doc = useCanvasDocument();
  const { scene, surfaceRef, sceneRef, canvasId, viewportRef, commitViewport, mountedRef } = doc;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [anchorMenu, setAnchorMenu] = useState<AnchorMenuState | null>(null);

  const clearMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const ordered = useMemo(() => orderedNodes(scene?.nodes ?? []), [scene]);
  const nodeIndex = useMemo(
    () => new Map((scene?.nodes ?? []).map((node) => [node.id, node])),
    [scene],
  );

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
    >
      <CanvasGridLayer grid={scene?.grid ?? DEFAULT_GRID} viewport={doc.viewport} />

      <CanvasEdgePass
        edges={scene?.edges ?? EMPTY_CANVAS_EDGES}
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
        onStartEdit={gestures.setEditingId}
        onCommitText={commands.commitText}
        onOpenDoc={commands.openDoc}
      />

      <CanvasMarquee rect={gestures.marquee} viewport={doc.viewport} />

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
