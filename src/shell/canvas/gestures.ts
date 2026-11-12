import type {
  CanvasGrid,
  CanvasMutation,
  CanvasPoint,
  CanvasRect,
  Viewport,
} from '#canvas-engine';
import { snapRect, worldToScreen } from './geometry.ts';
import type { AnchorSide, ResizeCorner } from './geometry.ts';

/** 画布交互手势：只描述状态与纯矩形运算，DOM 事件在 use-canvas-gestures 里 */
export type Gesture =
  | {
      readonly kind: 'pan';
      readonly pointerId: number;
      readonly start: CanvasPoint;
      readonly origin: Viewport;
    }
  | {
      readonly kind: 'marquee';
      readonly pointerId: number;
      readonly start: CanvasPoint;
      readonly additive: boolean;
    }
  | {
      readonly kind: 'drag';
      readonly pointerId: number;
      readonly start: CanvasPoint;
      readonly origins: ReadonlyMap<string, CanvasRect>;
    }
  /** 左键按住连接锚点拖拽：期间禁用平移 / 框选 / 节点拖动 */
  | {
      readonly kind: 'connect';
      readonly pointerId: number;
      readonly from: string;
      readonly side: AnchorSide;
    }
  /** 按住选中节点四角手柄缩放 */
  | {
      readonly kind: 'resize';
      readonly pointerId: number;
      readonly nodeId: string;
      readonly corner: ResizeCorner;
      readonly origin: CanvasRect;
    };

/** 连线拖拽草稿：光标世界坐标 + 当前命中的目标节点 */
export interface ConnectDraft {
  readonly from: string;
  readonly side: AnchorSide;
  readonly point: CanvasPoint;
  readonly target: string | null;
}

/** 拖动中：所有选中节点按同一位移平移（不吸附网格） */
export const dragDrafts = (
  origins: ReadonlyMap<string, CanvasRect>,
  dx: number,
  dy: number,
): Map<string, CanvasRect> => {
  const next = new Map<string, CanvasRect>();
  for (const [id, rect] of origins) {
    next.set(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
  }
  return next;
};

/** 松手时按场景网格吸附 */
export const snapDrafts = (
  drafts: ReadonlyMap<string, CanvasRect>,
  grid: CanvasGrid,
): Map<string, CanvasRect> => {
  const next = new Map<string, CanvasRect>();
  for (const [id, rect] of drafts) next.set(id, snapRect(rect, grid));
  return next;
};

/** 只提交位置真正变化的节点；拖动 / 缩放松手共用 */
export const changedRectOps = (
  final: ReadonlyMap<string, CanvasRect>,
  origins: ReadonlyMap<string, CanvasRect>,
): CanvasMutation[] => {
  const ops: CanvasMutation[] = [];
  for (const [id, rect] of final) {
    const origin = origins.get(id);
    if (origin === undefined) continue;
    if (origin.x === rect.x && origin.y === rect.y && origin.w === rect.w && origin.h === rect.h) {
      continue;
    }
    ops.push({ type: 'updateNode', id, patch: { rect } });
  }
  return ops;
};

/** 世界坐标框选 → 屏幕坐标（渲染框选矩形用） */
export const marqueeScreenRect = (
  rect: CanvasRect,
  viewport: Viewport,
): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } => {
  const at = worldToScreen({ x: rect.x, y: rect.y }, viewport);
  return { x: at.x, y: at.y, w: rect.w * viewport.zoom, h: rect.h * viewport.zoom };
};
