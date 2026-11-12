import type { ReactElement } from 'react';
import type { CanvasEdge, CanvasGrid, CanvasNode, CanvasRect, Viewport } from '#canvas-engine';
import type { DocMeta } from '../../kernel/types.ts';
import type { DragPerf } from './dev-probe.ts';
import { CanvasNodeView } from './CanvasNodeView.tsx';
import { EdgeLayer } from './EdgeLayer.tsx';
import { anchorPoint, previewPath, worldToScreen } from './geometry.ts';
import type { ConnectDraft } from './gestures.ts';
import { marqueeScreenRect } from './gestures.ts';
import { cssVars } from './css-vars.ts';
import styles from './CanvasSurface.module.css';

const EMPTY_EDGES: readonly CanvasEdge[] = [];
export const EMPTY_CANVAS_EDGES = EMPTY_EDGES;

export interface CanvasEdgePassProps {
  readonly edges: readonly CanvasEdge[];
  readonly nodeIndex: ReadonlyMap<string, CanvasNode>;
  readonly selectedEdgeId: string | null;
  readonly onSelectEdge: (id: string) => void;
  readonly tick: number;
  readonly viewport: Viewport;
  readonly connect: ConnectDraft | null;
  readonly draft: ReadonlyMap<string, CanvasRect>;
}

/** 渲染 pass：屏幕空间的网格底图 */
export const CanvasGridLayer = ({
  grid,
  viewport,
}: {
  readonly grid: CanvasGrid;
  readonly viewport: Viewport;
}): ReactElement => (
  <div
    className={styles.grid}
    style={cssVars({
      '--canvas-grid-step': `${grid.size * viewport.zoom}px`,
      '--canvas-grid-x': `${viewport.x}px`,
      '--canvas-grid-y': `${viewport.y}px`,
    })}
  />
);

/** 渲染 pass：连线与连线预览放在屏幕空间 SVG 里，只有落在视口内的描边才能被命中 */
export const CanvasEdgePass = ({
  edges,
  nodeIndex,
  selectedEdgeId,
  onSelectEdge,
  tick,
  viewport,
  connect,
  draft,
}: CanvasEdgePassProps): ReactElement => {
  const preview = (() => {
    if (connect === null) return null;
    const anchorNode = nodeIndex.get(connect.from);
    if (anchorNode === undefined) return null;
    const rect = draft.get(connect.from) ?? anchorNode.rect;
    const start = worldToScreen(anchorPoint(rect, connect.side, viewport.zoom), viewport);
    const end = worldToScreen(connect.point, viewport);
    return <path className={styles.connectionPreview} d={previewPath(start, end)} />;
  })();

  return (
    <svg className={styles.edges} aria-hidden="true" style={cssVars({ '--viewport-zoom': viewport.zoom })}>
      <defs>
        <marker
          id="ember-canvas-arrow"
          markerWidth="10"
          markerHeight="8"
          refX="9"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path className={styles.arrow} d="M 0 0 L 10 4 L 0 8 Z" />
        </marker>
      </defs>
      <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
        <EdgeLayer
          edges={edges}
          nodes={nodeIndex}
          selectedEdgeId={selectedEdgeId}
          onSelectEdge={onSelectEdge}
          tick={tick}
        />
      </g>
      {preview}
    </svg>
  );
};

export interface CanvasNodePassProps {
  readonly ordered: readonly CanvasNode[];
  readonly draft: ReadonlyMap<string, CanvasRect>;
  readonly selected: ReadonlySet<string>;
  readonly docIndex: ReadonlyMap<string, DocMeta>;
  readonly editingId: string | null;
  readonly connect: ConnectDraft | null;
  readonly viewport: Viewport;
  readonly onStartEdit: (id: string) => void;
  readonly onCommitText: (id: string, text: string) => void;
  readonly onOpenDoc: (id: string) => void;
}

/** 渲染 pass：世界坐标节点层 */
export const CanvasNodePass = ({
  ordered,
  draft,
  selected,
  docIndex,
  editingId,
  connect,
  viewport,
  onStartEdit,
  onCommitText,
  onOpenDoc,
}: CanvasNodePassProps): ReactElement => (
  <div
    className={styles.world}
    style={cssVars({
      '--viewport-x': `${viewport.x}px`,
      '--viewport-y': `${viewport.y}px`,
      '--viewport-zoom': viewport.zoom,
      // 锚点尺寸 / 热区按屏幕像素换算成世界像素，缩放不影响可点性
      '--viewport-scale': 1 / viewport.zoom,
    })}
  >
    {ordered.map((node: CanvasNode) => (
      <CanvasNodeView
        key={node.id}
        node={node}
        rect={draft.get(node.id) ?? node.rect}
        selected={selected.has(node.id)}
        doc={node.docId === null ? null : (docIndex.get(String(node.docId)) ?? null)}
        editing={editingId === node.id}
        connectTarget={connect?.target === node.id}
        onStartEdit={onStartEdit}
        onCommitText={onCommitText}
        onOpenDoc={onOpenDoc}
      />
    ))}
  </div>
);

/** 渲染 pass：框选矩形 */
export const CanvasMarquee = ({
  rect,
  viewport,
}: {
  readonly rect: CanvasRect | null;
  readonly viewport: Viewport;
}): ReactElement | null => {
  if (rect === null) return null;
  const screen = marqueeScreenRect(rect, viewport);
  return (
    <div
      className={styles.marquee}
      style={cssVars({
        '--marquee-x': `${screen.x}px`,
        '--marquee-y': `${screen.y}px`,
        '--marquee-w': `${screen.w}px`,
        '--marquee-h': `${screen.h}px`,
      })}
    />
  );
};

/** 渲染 pass：空画布提示 */
export const CanvasEmptyHint = ({ visible }: { readonly visible: boolean }): ReactElement | null =>
  visible ? (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>空白画布</p>
      <p className={styles.emptyHint}>滚轮缩放 · 空格或中键拖拽平移 · 拖拽框选</p>
    </div>
  ) : null;

export interface CanvasHudProps {
  readonly viewport: Viewport;
  readonly scene: { readonly nodes: readonly CanvasNode[]; readonly edges: readonly CanvasEdge[] } | null;
  readonly refreshMs: number | null;
  readonly dragPerf: DragPerf | null;
}

/** 渲染 pass：底部 HUD（含 DEV 性能采样） */
export const CanvasHud = ({ viewport, scene, refreshMs, dragPerf }: CanvasHudProps): ReactElement => (
  <div className={styles.hud}>
    <span>缩放 {Math.round(viewport.zoom * 100)}%</span>
    {scene === null ? null : (
      <span>
        {scene.nodes.length} 节点 · {scene.edges.length} 连线
      </span>
    )}
    {!import.meta.env.DEV || refreshMs === null ? null : <span>刷新 {refreshMs.toFixed(1)}ms</span>}
    {!import.meta.env.DEV || dragPerf === null ? null : (
      <span>
        拖动 {dragPerf.frames} 帧 · 均 {dragPerf.avg.toFixed(1)}ms · P95 {dragPerf.p95.toFixed(1)}ms ·
        最长 {dragPerf.max.toFixed(1)}ms · 掉帧 {(dragPerf.dropped * 100).toFixed(0)}% · 处理{' '}
        {dragPerf.handler.toFixed(2)}ms · 响应 {dragPerf.latency.toFixed(1)}ms
      </span>
    )}
  </div>
);
