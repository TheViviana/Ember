import type {
  CanvasGrid,
  CanvasNode,
  CanvasPoint,
  CanvasRect,
  CanvasScene,
  Viewport,
} from '#canvas-engine';

/** 与 canvas-engine 的 ZOOM_RANGE 保持一致：内核校验与 UI 手势共用同一区间 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;

/** 新建节点的默认尺寸（DESIGN.md「节点默认 320 × 200」） */
export const DEFAULT_NODE_SIZE = { w: 320, h: 200 } as const;

/** 滚轮缩放手感：deltaY 每 1000 约放大 e^1.5 ≈ 4.48 倍 */
export const ZOOM_WHEEL_SPEED = 0.0015;

const round = (value: number): number => Math.round(value * 100) / 100;

export const clampZoom = (zoom: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** 屏幕坐标（画布元素左上角为原点）→ 世界坐标 */
export const screenToWorld = (point: CanvasPoint, viewport: Viewport): CanvasPoint => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
});

/** 世界坐标 → 屏幕坐标 */
export const worldToScreen = (point: CanvasPoint, viewport: Viewport): CanvasPoint => ({
  x: point.x * viewport.zoom + viewport.x,
  y: point.y * viewport.zoom + viewport.y,
});

/**
 * 以屏幕上的 anchor 为锚点缩放：锚点下的世界坐标保持不动。
 * 缩放被夹紧到 [ZOOM_MIN, ZOOM_MAX]，已到边界时原样返回同一对象引用。
 */
export const zoomAt = (viewport: Viewport, anchor: CanvasPoint, factor: number): Viewport => {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const world = screenToWorld(anchor, viewport);
  return {
    zoom,
    x: anchor.x - world.x * zoom,
    y: anchor.y - world.y * zoom,
  };
};

/** 网格吸附：关闭时原值返回；开启时把单个坐标对齐到最近的网格点 */
export const snapValue = (value: number, grid: CanvasGrid): number =>
  grid.snap ? Math.round(value / grid.size) * grid.size : value;

/** 只吸附位置，不改尺寸：拖动时尺寸由用户上一次的调整决定 */
export const snapRect = (rect: CanvasRect, grid: CanvasGrid): CanvasRect => {
  if (!grid.snap) return rect;
  return {
    ...rect,
    x: snapValue(rect.x, grid),
    y: snapValue(rect.y, grid),
  };
};

/** 两个对角点 → 左上角为原点、宽高非负的矩形（框选与拖动都用它） */
export const normalizeRect = (a: CanvasPoint, b: CanvasPoint): CanvasRect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
});

export const containsPoint = (rect: CanvasRect, point: CanvasPoint): boolean =>
  point.x >= rect.x &&
  point.x <= rect.x + rect.w &&
  point.y >= rect.y &&
  point.y <= rect.y + rect.h;

/** 相交即命中（框选碰到节点边缘也算选中） */
export const rectsIntersect = (a: CanvasRect, b: CanvasRect): boolean =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

/**
 * 框选命中：排除组节点。组通常覆盖大片区域，若参与框选会导致每次框选都带上组；
 * 组的选择走点击（命中测试仍包含组）。
 */
export const nodesInRect = (
  nodes: readonly CanvasNode[],
  rect: CanvasRect,
): readonly CanvasNode[] =>
  nodes.filter((node) => node.kind !== 'group' && rectsIntersect(node.rect, rect));

/** 绘制顺序：组永远在所有非组节点之下（vault-format §8.2），同层按 z 升序 */
export const orderedNodes = (nodes: readonly CanvasNode[]): readonly CanvasNode[] =>
  [...nodes].sort((left, right) => {
    const leftLayer = left.kind === 'group' ? 0 : 1;
    const rightLayer = right.kind === 'group' ? 0 : 1;
    if (leftLayer !== rightLayer) return leftLayer - rightLayer;
    return left.z - right.z;
  });

/** 点击命中：取绘制顺序里最靠上的节点；组在非组之下，因此重叠时永远先命中成员 */
export const hitTestNode = (
  nodes: readonly CanvasNode[],
  point: CanvasPoint,
): CanvasNode | null => {
  const ordered = orderedNodes(nodes);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const node = ordered[index];
    if (node !== undefined && containsPoint(node.rect, point)) return node;
  }
  return null;
};

/** 多个矩形的包围盒；空数组返回 null */
export const boundsOfRects = (rects: readonly CanvasRect[]): CanvasRect | null => {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

/** 视口适配：把内容包围盒居中放进画布，四周留 padding，缩放不超过 100% */
export const fitViewport = (
  bounds: CanvasRect,
  size: { readonly w: number; readonly h: number },
  padding: number,
): Viewport => {
  const availableW = Math.max(1, size.w - padding * 2);
  const availableH = Math.max(1, size.h - padding * 2);
  const zoom = clampZoom(Math.min(availableW / Math.max(bounds.w, 1), availableH / Math.max(bounds.h, 1), 1));
  return {
    zoom,
    x: (size.w - bounds.w * zoom) / 2 - bounds.x * zoom,
    y: (size.h - bounds.h * zoom) / 2 - bounds.y * zoom,
  };
};

/** 两个矩形的中心点，连线标签定位用 */
export const rectCenter = (rect: CanvasRect): CanvasPoint => ({
  x: rect.x + rect.w / 2,
  y: rect.y + rect.h / 2,
});

/** 连接锚点：屏幕尺寸常量，世界坐标按 1 / zoom 换算，保证任何缩放下都点得到 */
export const ANCHOR_SIZE_PX = 10;
export const ANCHOR_SIZE_HOVER_PX = 12;
export const ANCHOR_HIT_PX = 16;
export const ANCHOR_INSET_PX = 4;

export type AnchorSide = 'left' | 'right';

const safeZoom = (zoom: number): number => (zoom > 0 ? zoom : 1);

/** 锚点中心的世界坐标；inset / 尺寸都是屏幕像素，除以 zoom 回到世界坐标 */
export const anchorPoint = (rect: CanvasRect, side: AnchorSide, zoom: number): CanvasPoint => {
  const inset = ANCHOR_INSET_PX / safeZoom(zoom);
  return {
    x: side === 'left' ? rect.x - inset : rect.x + rect.w + inset,
    y: rect.y + rect.h / 2,
  };
};

/** 锚点命中半径（世界坐标）：屏幕热区的一半 / zoom，缩放变小热区反而变大，不会点不到 */
export const anchorHitRadius = (zoom: number): number => ANCHOR_HIT_PX / 2 / safeZoom(zoom);

/**
 * 命中节点时额外把锚点的外伸部分算进去（锚点比节点边缘多出约 10px 屏幕像素）。
 * 组不参与连线，直接跳过。
 */
export const hitTestNodeWithAnchors = (
  nodes: readonly CanvasNode[],
  point: CanvasPoint,
  pad: number,
): CanvasNode | null => {
  const direct = hitTestNode(nodes, point);
  if (direct !== null) return direct;
  const ordered = orderedNodes(nodes);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const node = ordered[index];
    if (
      node !== undefined &&
      node.kind !== 'group' &&
      containsPoint(
        { x: node.rect.x - pad, y: node.rect.y - pad, w: node.rect.w + pad * 2, h: node.rect.h + pad * 2 },
        point,
      )
    ) {
      return node;
    }
  }
  return null;
};

/** 四角缩放手柄：视觉 10px、热区 16px（屏幕像素，渲染时用 1/zoom 换算到世界坐标） */
export const RESIZE_HANDLE_PX = 10;
export const RESIZE_HIT_PX = 16;

/** 节点尺寸上下限（世界像素）；与 canvas-engine 的校验共同兜底 */
export const NODE_MIN = { w: 160, h: 100 } as const;
export const NODE_MAX = { w: 2000, h: 2000 } as const;

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export const RESIZE_CORNERS: readonly ResizeCorner[] = ['nw', 'ne', 'sw', 'se'];

export interface ResizeOptions {
  /** Shift 时保持原宽高比 */
  readonly keepAspect: boolean;
}

const clampSize = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isLeftCorner = (corner: ResizeCorner): boolean => corner === 'nw' || corner === 'sw';
const isTopCorner = (corner: ResizeCorner): boolean => corner === 'nw' || corner === 'ne';

const oppositeCorner = (rect: CanvasRect, corner: ResizeCorner): CanvasPoint => ({
  x: isLeftCorner(corner) ? rect.x + rect.w : rect.x,
  y: isTopCorner(corner) ? rect.y + rect.h : rect.y,
});

/**
 * 四角缩放：对角固定，宽高夹紧到 [NODE_MIN, NODE_MAX]。
 * keepAspect 时按原宽高比取宽（以相对变化更大的轴为准），再换算高度。
 */
export const resizeRect = (
  origin: CanvasRect,
  corner: ResizeCorner,
  worldPoint: CanvasPoint,
  options: ResizeOptions,
): CanvasRect => {
  const anchor = oppositeCorner(origin, corner);
  const rawW = Math.abs(worldPoint.x - anchor.x);
  const rawH = Math.abs(worldPoint.y - anchor.y);

  let width: number;
  let height: number;
  if (options.keepAspect) {
    const aspect = origin.w / Math.max(1, origin.h);
    const scaleX = rawW / Math.max(1, origin.w);
    const scaleY = rawH / Math.max(1, origin.h);
    const proposed = scaleX >= scaleY ? rawW : rawH * aspect;
    const minW = Math.max(NODE_MIN.w, NODE_MIN.h * aspect);
    const maxW = Math.min(NODE_MAX.w, NODE_MAX.h * aspect);
    width = clampSize(proposed, minW, maxW);
    height = width / aspect;
  } else {
    width = clampSize(rawW, NODE_MIN.w, NODE_MAX.w);
    height = clampSize(rawH, NODE_MIN.h, NODE_MAX.h);
  }

  const w = round(width);
  const h = round(height);
  return {
    x: isLeftCorner(corner) ? round(anchor.x - w) : anchor.x,
    y: isTopCorner(corner) ? round(anchor.y - h) : anchor.y,
    w,
    h,
  };
};

/** 手柄热区半径（世界坐标）：屏幕热区的一半 / zoom，缩到 0.25 仍是 16px 的可点范围 */
export const resizeHitRadius = (zoom: number): number => RESIZE_HIT_PX / 2 / safeZoom(zoom);

/** 命中选中节点四角：返回最近的手柄，超出热区返回 null */
export const hitTestResizeCorner = (
  rect: CanvasRect,
  point: CanvasPoint,
  zoom: number,
): ResizeCorner | null => {
  const radius = resizeHitRadius(zoom);
  const corners: readonly { readonly corner: ResizeCorner; readonly at: CanvasPoint }[] = [
    { corner: 'nw', at: { x: rect.x, y: rect.y } },
    { corner: 'ne', at: { x: rect.x + rect.w, y: rect.y } },
    { corner: 'sw', at: { x: rect.x, y: rect.y + rect.h } },
    { corner: 'se', at: { x: rect.x + rect.w, y: rect.y + rect.h } },
  ];
  let found: { readonly corner: ResizeCorner; readonly distance: number } | null = null;
  for (const item of corners) {
    const distance = Math.hypot(point.x - item.at.x, point.y - item.at.y);
    if (distance <= radius && (found === null || distance < found.distance)) {
      found = { corner: item.corner, distance };
    }
  }
  return found?.corner ?? null;
};

/** 拖动锚点时的预览曲线：两端点在同一坐标系（这里用屏幕坐标） */
export const previewPath = (from: CanvasPoint, to: CanvasPoint): string => {
  const direction = to.x >= from.x ? 1 : -1;
  const handle = Math.max(48, Math.abs(to.x - from.x) / 2) * direction;
  return `M ${round(from.x)} ${round(from.y)} C ${round(from.x + handle)} ${round(from.y)}, ${round(to.x - handle)} ${round(to.y)}, ${round(to.x)} ${round(to.y)}`;
};

export interface EdgeGeometry {
  /** SVG path 的 d 属性 */
  readonly path: string;
  /** 连线标签的锚点（两端中心的中点） */
  readonly label: CanvasPoint;
}

interface EdgeCurve {
  readonly start: CanvasPoint;
  readonly c1: CanvasPoint;
  readonly c2: CanvasPoint;
  readonly end: CanvasPoint;
}

const edgeCurve = (from: CanvasRect, to: CanvasRect): EdgeCurve => {
  const fromCenter = rectCenter(from);
  const toCenter = rectCenter(to);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const forward = dx >= 0;
    const startX = forward ? from.x + from.w : from.x;
    const endX = forward ? to.x : to.x + to.w;
    const control = Math.max(48, Math.abs(endX - startX) / 2) * (forward ? 1 : -1);
    const y1 = round(fromCenter.y);
    const y2 = round(toCenter.y);
    return {
      start: { x: round(startX), y: y1 },
      c1: { x: round(startX + control), y: y1 },
      c2: { x: round(endX - control), y: y2 },
      end: { x: round(endX), y: y2 },
    };
  }

  const downward = dy >= 0;
  const startY = downward ? from.y + from.h : from.y;
  const endY = downward ? to.y : to.y + to.h;
  const control = Math.max(48, Math.abs(endY - startY) / 2) * (downward ? 1 : -1);
  const x1 = round(fromCenter.x);
  const x2 = round(toCenter.x);
  return {
    start: { x: x1, y: round(startY) },
    c1: { x: x1, y: round(startY + control) },
    c2: { x: x2, y: round(endY - control) },
    end: { x: x2, y: round(endY) },
  };
};

const bezierPoint = (curve: EdgeCurve, t: number): CanvasPoint => {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * curve.start.x + b * curve.c1.x + c * curve.c2.x + d * curve.end.x,
    y: a * curve.start.y + b * curve.c1.y + c * curve.c2.y + d * curve.end.y,
  };
};

const distanceToSegment = (point: CanvasPoint, from: CanvasPoint, to: CanvasPoint): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq),
  );
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
};

const HIT_SEGMENTS = 32;

/** 点到连线路径的最短距离（世界坐标），用于右键命中判定 */
export const distanceToEdge = (from: CanvasRect, to: CanvasRect, point: CanvasPoint): number => {
  const curve = edgeCurve(from, to);
  let best = Number.POSITIVE_INFINITY;
  let previous = curve.start;
  for (let step = 1; step <= HIT_SEGMENTS; step += 1) {
    const current = bezierPoint(curve, step / HIT_SEGMENTS);
    best = Math.min(best, distanceToSegment(point, previous, current));
    previous = current;
  }
  return best;
};

/** 在阈值内找最近的连线；SVG 的透明命中描边在部分 WebView 上收不到 contextmenu，这里做兜底 */
export const hitTestEdge = (
  scene: CanvasScene,
  point: CanvasPoint,
  threshold: number,
): string | null => {
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
  let found: { readonly id: string; readonly distance: number } | null = null;
  for (const edge of scene.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const distance = distanceToEdge(from.rect, to.rect, point);
    if (distance <= threshold && (found === null || distance < found.distance)) {
      found = { id: edge.id, distance };
    }
  }
  return found?.id ?? null;
};

/**
 * 连线走三次贝塞尔：按两矩形中心的主要轴向选择左右或上下对接，
 * 起点与终点落在面向对方的边上，避免穿过节点本体。
 */
export const edgeGeometry = (from: CanvasRect, to: CanvasRect): EdgeGeometry => {
  const curve = edgeCurve(from, to);
  const fromCenter = rectCenter(from);
  const toCenter = rectCenter(to);
  const label = {
    x: round((fromCenter.x + toCenter.x) / 2),
    y: round((fromCenter.y + toCenter.y) / 2),
  };
  return {
    path: `M ${curve.start.x} ${curve.start.y} C ${curve.c1.x} ${curve.c1.y}, ${curve.c2.x} ${curve.c2.y}, ${curve.end.x} ${curve.end.y}`,
    label,
  };
};
