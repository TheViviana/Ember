import { memo, type ReactElement } from 'react';
import type { CanvasEdge, CanvasNode } from '#canvas-engine';
import { edgeGeometry } from './geometry.ts';
import styles from './CanvasSurface.module.css';

export interface EdgeLayerProps {
  readonly edges: readonly CanvasEdge[];
  readonly nodes: ReadonlyMap<string, CanvasNode>;
  readonly selectedEdgeId: string | null;
  readonly onSelectEdge: (id: string) => void;
  /** 手势取消 / 提交失败时递增，用来强制按场景矩形重绘 */
  readonly tick: number;
}

/**
 * 连线层：memo 隔离拖动期间的高频提交。
 * 拖动时节点矩形在 CanvasSurface 的 rAF 里直接改本层 path 的 d，
 * 这里只依赖场景节点（拖动中不变）与选中态，不会整棵 SVG 重建。
 */
export const EdgeLayer = memo(function EdgeLayer(props: EdgeLayerProps): ReactElement {
  const { edges, nodes, selectedEdgeId, onSelectEdge } = props;
  return (
    <g>
      {edges.map((edge) => {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (from === undefined || to === undefined) return null;
        const geometry = edgeGeometry(from.rect, to.rect);
        const edgeClass = [styles.edge, selectedEdgeId === edge.id ? styles.edgeSelected : '']
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' ');
        return (
          <g key={edge.id}>
            <path
              className={edgeClass}
              data-edge-draw={edge.id}
              d={geometry.path}
              markerEnd={edge.arrow === 'none' ? undefined : 'url(#ember-canvas-arrow)'}
              markerStart={edge.arrow === 'both' ? 'url(#ember-canvas-arrow)' : undefined}
            />
            {edge.label === null ? null : (
              <text
                className={styles.edgeLabel}
                data-edge-label={edge.id}
                x={geometry.label.x}
                y={geometry.label.y}
              >
                {edge.label}
              </text>
            )}
            {/* 透明宽描边只负责命中：stroke-width 除以 zoom，保持屏幕上 14px 的手感 */}
            <path
              className={styles.edgeHit}
              data-edge-id={edge.id}
              data-edge-draw={edge.id}
              d={geometry.path}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />
          </g>
        );
      })}
    </g>
  );
});
