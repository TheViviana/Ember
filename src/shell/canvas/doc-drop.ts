import type { CanvasGrid, CanvasPoint, CanvasRect, Viewport } from '#canvas-engine';
import { asDocId, type DocId } from '#doc-model';
import { centeredNodeRect, visibleNodeCenter } from './commands.ts';
import { DEFAULT_NODE_SIZE, screenToWorld, snapValue } from './geometry.ts';

/** 文档面板拖拽时写入的自定义类型（dragstart 里 setData） */
export const DOC_DRAG_MIME = 'application/x-ember-doc';

/** DataTransfer 的最小只读视图：浏览器对象与测试替身都满足 */
export interface DragPayload {
  readonly types: readonly string[];
  getData(type: string): string;
}

/** 这次拖放是否携带文稿载荷 */
export const hasDocPayload = (data: DragPayload): boolean => data.types.includes(DOC_DRAG_MIME);

/**
 * 读出被拖文章的 DocId。
 * dragstart 写入的是文档路径身份；drop 阶段才允许 getData，非法值一律视为没有载荷。
 */
export const readDocId = (data: DragPayload): DocId | null => asDocId(data.getData(DOC_DRAG_MIME));

export interface DocDropGeometry {
  /** 落点：画布元素左上角为原点的屏幕坐标 */
  readonly point: CanvasPoint;
  readonly viewport: Viewport;
  /** 画布可视区尺寸 */
  readonly canvas: { readonly width: number; readonly height: number };
  readonly grid: CanvasGrid;
}

/** 落点 → 卡片矩形：以落点为卡片中心，先夹进可视区再按网格吸附 */
export const docDropRect = ({ point, viewport, canvas, grid }: DocDropGeometry): CanvasRect => {
  const center = visibleNodeCenter(screenToWorld(point, viewport), viewport, canvas, DEFAULT_NODE_SIZE);
  const rect = centeredNodeRect(center, DEFAULT_NODE_SIZE);
  return {
    ...rect,
    x: snapValue(rect.x, grid),
    y: snapValue(rect.y, grid),
  };
};
