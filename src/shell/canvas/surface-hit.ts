import type { CanvasNode, CanvasPoint, CanvasScene } from '#canvas-engine';
import { hitTestEdge, hitTestNode, hitTestResizeCorner } from './geometry.ts';
import type { ResizeCorner } from './geometry.ts';

/** 连线右键命中半径（屏幕像素），进入世界坐标前需除以 zoom */
export const EDGE_HIT_SCREEN_PX = 10;

export const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, [contenteditable="true"]') !== null;

export const isResizeCorner = (value: string | null): value is ResizeCorner =>
  value === 'nw' || value === 'ne' || value === 'sw' || value === 'se';

/** 指针事件目标 → 最近的节点 id */
export const nodeIdAt = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) return null;
  const element = target.closest('[data-node-id]');
  if (!(element instanceof HTMLElement)) return null;
  return element.dataset.nodeId ?? null;
};

/** 指针事件目标 → 连线 id（SVG 命中描边） */
export const edgeIdAt = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) return null;
  const element = target.closest('[data-edge-id]');
  if (!(element instanceof HTMLElement)) return null;
  return element.dataset.edgeId ?? null;
};

/** 四角手柄：显式手柄优先，缩得很小时用几何热区兜底 */
export const resolveResizeCorner = (
  node: CanvasNode | undefined,
  attribute: string | null,
  world: CanvasPoint,
  zoom: number,
): ResizeCorner | null => {
  if (node === undefined) return null;
  if (isResizeCorner(attribute)) return attribute;
  return hitTestResizeCorner(node.rect, world, zoom);
};

/** 右键目标节点：优先 DOM 命中，几何命中兜底 */
export const resolveContextNode = (
  scene: CanvasScene,
  domId: string | null,
  world: CanvasPoint,
): CanvasNode | null => {
  if (domId === null) return hitTestNode(scene.nodes, world);
  return scene.nodes.find((item) => item.id === domId) ?? hitTestNode(scene.nodes, world);
};

/** 右键目标连线：SVG 透明描边在部分 WebView 收不到事件，用几何距离兜底 */
export const resolveContextEdge = (
  scene: CanvasScene,
  domEdgeId: string | null,
  world: CanvasPoint,
  zoom: number,
): string | null =>
  domEdgeId ?? hitTestEdge(scene, world, EDGE_HIT_SCREEN_PX / zoom);
