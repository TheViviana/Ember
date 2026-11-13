/**
 * 画布视图请求：搜索结果 / 书签 → 镜头飞到节点或视角并恢复过滤、高亮。
 *
 * 请求**不直接调用**监听器，而是排队等画布组件在「画布切换重置」之后消费——
 * 否则跳转到其它画布时，重置 effect 会把请求刚设置的过滤器/高亮清掉
 * （跨画布书签跳转的回归）。画布组件用 drainCanvasView 在重置 effect 之后取走请求。
 */
import type { CanvasFilters } from '#canvas-engine';

export interface CanvasViewRequest {
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number };
  /** 需要高亮的节点 id；null = 清除高亮 */
  readonly highlightNodeId?: string | null;
  /** 书签携带的过滤条件；undefined = 不动过滤，null = 清空过滤 */
  readonly filters?: CanvasFilters | null;
}

/** 同一批内的多个请求合并成挂起请求：显式字段覆盖，undefined 保留先前值 */
let pending: CanvasViewRequest | null = null;
const listeners = new Set<(request: CanvasViewRequest) => void>();

/** 订阅请求通知：画布组件用它 bump tick 驱动排水 effect（同画布跳转场景） */
export const subscribeCanvasView = (
  fn: (request: CanvasViewRequest) => void,
): { dispose: () => void } => {
  listeners.add(fn);
  return {
    dispose: (): void => {
      listeners.delete(fn);
    },
  };
};

export const requestCanvasView = (request: CanvasViewRequest): void => {
  pending = { ...(pending ?? {}), ...request };
  for (const listener of [...listeners]) listener(pending);
};

/** 仅供画布组件在「重置之后」调用：取走挂起请求（没有则 null） */
export const drainCanvasView = (): CanvasViewRequest | null => {
  const request = pending;
  pending = null;
  return request;
};
