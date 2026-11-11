import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import type {
  CanvasEdge,
  CanvasMutation,
  CanvasNode,
  CanvasPoint,
  CanvasRect,
  CanvasScene,
  Viewport,
} from '#canvas-engine';
import { createUlid } from '#doc-model';
import type { CanvasId, DocId } from '#doc-model';
import { createArticleOnCanvas } from '../../kernel/article-service.ts';
import type { CanvasSession } from '../../kernel/canvas-host.ts';
import { toErrorText } from '../../kernel/errors.ts';
import type { Disposable } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import { FloatLayer } from '../editor/FloatLayer.tsx';
import type { CursorPosition } from '../editor/cursor.ts';
import { CanvasNodeView } from './CanvasNodeView.tsx';
import { AnchorMenu } from './AnchorMenu.tsx';
import { shouldOpenAnchorMenu, type AnchorDoc } from './anchor-menu.ts';
import { readClipboard, writeClipboard } from './clipboard.ts';
import {
  centeredNodeRect,
  planAnchorEdge,
  planCommand,
  planConnection,
  planEdgeLabel,
  planTextUpdate,
  type CommandPlan,
  type MenuTarget,
} from './commands.ts';
import { ContextMenu, LabelPrompt } from './ContextMenu.tsx';
import { cssVars } from './css-vars.ts';
import { EdgeLayer } from './EdgeLayer.tsx';
import { buildCanvasMenu, type CanvasMenuItem } from './menu-model.ts';
import {
  DEFAULT_NODE_SIZE,
  ZOOM_WHEEL_SPEED,
  anchorHitRadius,
  anchorPoint,
  edgeGeometry,
  hitTestEdge,
  hitTestNode,
  hitTestNodeWithAnchors,
  hitTestResizeCorner,
  nodesInRect,
  normalizeRect,
  orderedNodes,
  previewPath,
  resizeRect,
  screenToWorld,
  snapRect,
  worldToScreen,
  zoomAt,
  type AnchorSide,
  type ResizeCorner,
} from './geometry.ts';
import styles from './CanvasSurface.module.css';

type Gesture =
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

/** 一步新建文章：先在光标处问标题，再落盘建节点 */
interface ArticlePromptState {
  readonly x: number;
  readonly y: number;
  /** 世界坐标（节点左上角） */
  readonly point: CanvasPoint;
  readonly value: string;
  /** 从引线拖到空白新建时，落盘后自动补一条边 */
  readonly anchor: { readonly from: string; readonly side: AnchorSide } | null;
}

/** 引线在空白处松手 / 空白右键「从库添加」：复用同一套目录下钻菜单 */
interface AnchorMenuState {
  /** 引线起点；从空白右键进入时为 null（只落节点，不补边） */
  readonly from: string | null;
  readonly side: AnchorSide | null;
  /** 世界坐标（引线末端 / 右键点，新节点中心对齐这里） */
  readonly point: CanvasPoint;
  /** 画布内屏幕坐标（菜单定位） */
  readonly x: number;
  readonly y: number;
  readonly purpose: 'anchor' | 'insert';
}

/** 当前打开的文档浮窗；nonce 递增用于「同一篇再次打开」时把焦点还给正文 */
export interface CanvasSurfaceProps {
  readonly onOpenFloat: (docId: DocId, focus: 'title' | null) => void;
  readonly onCursor: (position: CursorPosition | null) => void;
}

interface ConnectDraft {
  readonly from: string;
  readonly side: AnchorSide;
  /** 光标所在世界坐标 */
  readonly point: CanvasPoint;
  readonly target: string | null;
}

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_EDGES: readonly CanvasEdge[] = [];

/** 连线右键命中半径（屏幕像素），进入世界坐标前需除以 zoom */
const EDGE_HIT_SCREEN_PX = 10;

interface MenuState {
  readonly target: MenuTarget;
  readonly x: number;
  readonly y: number;
  readonly items: readonly CanvasMenuItem[];
}

interface EdgeLabelState {
  readonly edgeId: string;
  readonly x: number;
  readonly y: number;
  readonly value: string;
}

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest('input, textarea, [contenteditable="true"]') !== null;

const isResizeCorner = (value: string | null): value is ResizeCorner =>
  value === 'nw' || value === 'ne' || value === 'sw' || value === 'se';

/** 直接写节点元素上的几何变量：拖动 / 缩放的每帧路径，不经过 React */
const applyNodeRect = (element: HTMLElement, rect: CanvasRect): void => {
  element.style.setProperty('--node-x', `${rect.x}px`);
  element.style.setProperty('--node-y', `${rect.y}px`);
  element.style.setProperty('--node-w', `${rect.w}px`);
  element.style.setProperty('--node-h', `${rect.h}px`);
};

/**
 * 主页画布：DOM 节点 + SVG 连线，视口手势（滚轮缩放 / 空格或中键平移 / 空白拖拽框选）。
 * 场景状态唯一来源是内核 CanvasSession，本组件只持有交互期的临时状态（框选、拖动草稿、视口）。
 */
export const CanvasSurface = ({
  onOpenFloat,
  onCursor,
}: CanvasSurfaceProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const marqueeRef = useRef<CanvasRect | null>(null);
  const draftRef = useRef<ReadonlyMap<string, CanvasRect>>(new Map());
  const draftRafRef = useRef<number | null>(null);
  const draftCommitAtRef = useRef<number | null>(null);
  const canvasIdRef = useRef<CanvasId | null>(null);
  const viewportRef = useRef<Viewport>(INITIAL_VIEWPORT);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const errorTimerRef = useRef<number | null>(null);

  const [scene, setScene] = useState<CanvasScene | null>(null);
  /** 场景最新值的 ref：commitText/openDoc 读它而不依赖 scene 身份，
   * 否则每次内核通知都会生成新回调、击穿 CanvasNodeView 的 memo。 */
  const sceneRef = useRef<CanvasScene | null>(null);
  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [marquee, setMarquee] = useState<CanvasRect | null>(null);
  const [draft, setDraft] = useState<ReadonlyMap<string, CanvasRect>>(() => new Map());
  /** 取消手势 / 提交失败时递增，强制 memo 的连线层按场景矩形重绘 */
  const [edgeTick, setEdgeTick] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectDraft | null>(null);
  const connectRef = useRef<ConnectDraft | null>(null);
  /** DEV：拖动期间的 rAF 帧间隔采样，用来量化卡顿（生产构建不启动） */
  const probeRef = useRef<{
    frames: number[];
    raf: number | null;
    last: number;
    handler: number[];
    latency: number[];
  } | null>(null);
  const [dragPerf, setDragPerf] = useState<{
    avg: number;
    p95: number;
    dropped: number;
    max: number;
    frames: number;
    latency: number;
    handler: number;
  } | null>(null);
  /** DEV：空闲时的屏幕刷新基线，用来区分「本机就是 30Hz」和「拖动掉帧」 */
  const [refreshMs, setRefreshMs] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [labelPrompt, setLabelPrompt] = useState<EdgeLabelState | null>(null);
  const [articlePrompt, setArticlePrompt] = useState<ArticlePromptState | null>(null);
  const [anchorMenu, setAnchorMenu] = useState<AnchorMenuState | null>(null);

  const startFrameProbe = (): void => {
    if (!import.meta.env.DEV) return;
    const frames: number[] = [];
    const tick = (time: number): void => {
      const current = probeRef.current;
      if (current === null) return;
      if (current.last > 0) frames.push(time - current.last);
      current.last = time;
      current.raf = requestAnimationFrame(tick);
    };
    probeRef.current = {
      frames,
      raf: requestAnimationFrame(tick),
      last: 0,
      handler: [],
      latency: [],
    };
  };

  const stopFrameProbe = (): void => {
    const current = probeRef.current;
    if (current === null) return;
    probeRef.current = null;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    if (current.frames.length === 0) return;
    const avg = current.frames.reduce((sum, value) => sum + value, 0) / current.frames.length;
    const mean = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const sorted = [...current.frames].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? avg;
    const dropped = current.frames.filter((value) => value > 40).length / current.frames.length;
    setDragPerf({
      avg,
      p95,
      dropped,
      max: Math.max(...current.frames),
      frames: current.frames.length,
      latency: mean(current.latency),
      handler: mean(current.handler),
    });
  };

  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // DEV：挂载后采样 40 帧，得到本机空闲刷新间隔作为对照基线
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    let last = 0;
    let raf = 0;
    const samples: number[] = [];
    const tick = (time: number): void => {
      if (last > 0) samples.push(time - last);
      last = time;
      if (samples.length < 40) {
        raf = requestAnimationFrame(tick);
        return;
      }
      setRefreshMs(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  const canvasQuery = useQuery({
    queryKey: ['canvas', 'default'],
    queryFn: () => kernel.canvas.ensureDefault(),
  });
  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });

  const canvasId = canvasQuery.data?.id ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  // 文档元数据变化（新建 / 外部修改 / 冲突副本）时刷新节点展示
  useEffect(() => {
    const subscription = kernel.events.on('doc:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
    });
    return () => {
      subscription.dispose();
    };
  }, [kernel, queryClient]);

  /** HUD 错误行：显示后自动衰减，避免一次操作失败把提示钉在整个会话上 */
  const showError = useCallback((message: string): void => {
    if (!mountedRef.current) return;
    setError(message);
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => {
      errorTimerRef.current = null;
      if (mountedRef.current) setError(null);
    }, 5000);
  }, []);

  const reportError = useCallback(
    (cause: unknown): void => {
      showError(toErrorText(cause));
    },
    [showError],
  );

  /** 视口先落 React 状态（每帧都跟手），再用 rAF 合并成一次内核变更 + 400ms 防抖落盘 */
  const commitViewport = useCallback(
    (next: Viewport): void => {
      viewportRef.current = next;
      setViewport(next);
      pendingViewportRef.current = next;
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const value = pendingViewportRef.current;
        pendingViewportRef.current = null;
        const id = canvasIdRef.current;
        if (value === null || id === null) return;
        void kernel.canvas
          .apply(id, [{ type: 'setViewport', viewport: value }])
          .catch(reportError);
      });
    },
    [kernel, reportError],
  );

  // 打开默认画布会话：同一画布内核返回同一 session，卸载时 close 归还引用
  useEffect(() => {
    canvasIdRef.current = canvasId;
    if (canvasId === null) return undefined;

    let cancelled = false;
    let opened: CanvasSession | null = null;
    let subscription: Disposable | null = null;

    void kernel.canvas
      .open(canvasId)
      .then((session) => {
        if (cancelled) {
          session.close();
          return;
        }
        opened = session;
        setScene(session.scene);
        viewportRef.current = session.scene.viewport;
        setViewport(session.scene.viewport);
        subscription = session.on((next) => {
          if (mountedRef.current) setScene(next);
        });
      })
      .catch(reportError);

    return () => {
      cancelled = true;
      subscription?.dispose();
      subscription = null;
      opened?.close();
      void kernel.canvas.flush();
    };
  }, [kernel, canvasId, reportError]);

  // 窗口隐藏前强制落盘挂起的视口防抖
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') void kernel.canvas.flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [kernel]);

  // 滚轮缩放必须以非 passive 监听挂载：React 的 onWheel 无法 preventDefault，会连带滚动外层
  useEffect(() => {
    const element = surfaceRef.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * ZOOM_WHEEL_SPEED);
      commitViewport(zoomAt(viewportRef.current, anchor, factor));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
    };
  }, [commitViewport]);

  // 空格按住进入平移模式；输入框内不劫持空格
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      setSpace(true);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpace(false);
    };
    const onBlur = (): void => {
      setSpace(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Esc 立即取消连线 / 框选 / 拖动（拖动中的草稿一并丢弃，不会误提交）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (gestureRef.current === null && connectRef.current === null) return;
      if (gestureRef.current?.kind === 'connect') {
        event.preventDefault();
        gestureRef.current = null;
        connectRef.current = null;
        setConnect(null);
        return;
      }
      if (gestureRef.current?.kind === 'marquee') {
        gestureRef.current = null;
        marqueeRef.current = null;
        setMarquee(null);
        return;
      }
      if (gestureRef.current?.kind === 'drag') {
        const origins = gestureRef.current.origins;
        gestureRef.current = null;
        if (draftRafRef.current !== null) {
          window.cancelAnimationFrame(draftRafRef.current);
          draftRafRef.current = null;
        }
        draftCommitAtRef.current = null;
        // React 状态清空后 style 值没变，React 不会回写 CSS 变量，必须手动还原
        for (const [id, rect] of origins) {
          const element = surfaceRef.current?.querySelector(`[data-node-id="${id}"]`);
          if (element instanceof HTMLElement) applyNodeRect(element, rect);
        }
        draftRef.current = new Map();
        setDraft(new Map());
        setEdgeTick((value) => value + 1);
      }
      if (gestureRef.current?.kind === 'resize') {
        const { nodeId, origin } = gestureRef.current;
        gestureRef.current = null;
        if (draftRafRef.current !== null) {
          window.cancelAnimationFrame(draftRafRef.current);
          draftRafRef.current = null;
        }
        draftCommitAtRef.current = null;
        const element = surfaceRef.current?.querySelector(`[data-node-id="${nodeId}"]`);
        if (element instanceof HTMLElement) applyNodeRect(element, origin);
        draftRef.current = new Map();
        setDraft(new Map());
        setEdgeTick((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // 卸载时取消挂起的 rAF，避免对已关闭的画布再发一次 setViewport
  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (draftRafRef.current !== null) {
        window.cancelAnimationFrame(draftRafRef.current);
        draftRafRef.current = null;
      }
    },
    [],
  );

  const docIndex = useMemo(
    () => new Map((documents.data ?? []).map((meta) => [String(meta.id), meta])),
    [documents.data],
  );

  const ordered = useMemo(() => orderedNodes(scene?.nodes ?? []), [scene]);

  const nodeIndex = useMemo(
    () => new Map((scene?.nodes ?? []).map((node) => [node.id, node])),
    [scene],
  );

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>): CanvasPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const selectEdge = useCallback((id: string): void => {
    setSelected(new Set());
    setSelectedEdgeId(id);
  }, []);

  const nodeIdAt = (target: EventTarget | null): string | null => {
    if (!(target instanceof Element)) return null;
    const element = target.closest('[data-node-id]');
    if (!(element instanceof HTMLElement)) return null;
    return element.dataset.nodeId ?? null;
  };

  /** 拖动 / 缩放期间直接改元素上的几何变量，绕开 React 提交，保证每帧跟手 */
  const paintNodeRect = (id: string, rect: CanvasRect): void => {
    const element = surfaceRef.current?.querySelector(`[data-node-id="${id}"]`);
    if (!(element instanceof HTMLElement)) return;
    applyNodeRect(element, rect);
  };

  /** 只重写受影响连线的 d，不触发 EdgeLayer 重新渲染 */
  const paintEdges = (rects: ReadonlyMap<string, CanvasRect>): void => {
    if (scene === null) return;
    for (const edge of scene.edges) {
      const fromDraft = rects.get(edge.from);
      const toDraft = rects.get(edge.to);
      if (fromDraft === undefined && toDraft === undefined) continue;
      const from = nodeIndex.get(edge.from);
      const to = nodeIndex.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const geometry = edgeGeometry(fromDraft ?? from.rect, toDraft ?? to.rect);
      const paths = surfaceRef.current?.querySelectorAll(`[data-edge-draw="${edge.id}"]`);
      if (paths === undefined) continue;
      for (const path of paths) path.setAttribute('d', geometry.path);
      const label = surfaceRef.current?.querySelector(`[data-edge-label="${edge.id}"]`);
      if (label !== null && label !== undefined) {
        label.setAttribute('x', String(geometry.label.x));
        label.setAttribute('y', String(geometry.label.y));
      }
    }
  };

  /** 一帧最多提交一次 setDraft；同一帧内的 pointermove 只累积在 draftRef */
  const scheduleDraftCommit = (): void => {
    if (draftRafRef.current !== null) return;
    draftRafRef.current = window.requestAnimationFrame(() => {
      draftRafRef.current = null;
      const assigned = draftCommitAtRef.current;
      setDraft(new Map(draftRef.current));
      if (import.meta.env.DEV && assigned !== null && probeRef.current !== null) {
        probeRef.current.latency.push(performance.now() - assigned);
      }
    });
  };

  const cancelDraftCommit = (): void => {
    if (draftRafRef.current === null) return;
    window.cancelAnimationFrame(draftRafRef.current);
    draftRafRef.current = null;
  };

  const startGesture = (
    event: ReactPointerEvent<HTMLDivElement>,
    gesture: Gesture,
    captureTarget: Element | null = surfaceRef.current,
  ): void => {
    // 指针捕获会把 click / dblclick 一并重定向到捕获元素：
    // 拖节点时捕获到节点自身，双击才能继续命中节点的就地编辑。
    captureTarget?.setPointerCapture(event.pointerId);
    gestureRef.current = gesture;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button === 2) return; // 右键留给上下文菜单
    // 菜单/浮层里的交互不能开启画布手势：指针捕获会把 click 从菜单项抢走
    if (event.target instanceof Element && event.target.closest('[data-canvas-overlay]') !== null) return;
    if (isTypingTarget(event.target)) return;

    setAnchorMenu(null);
    const local = localPoint(event);
    const world = screenToWorld(local, viewportRef.current);
    const nodeId = nodeIdAt(event.target);

    // 左键按住连接锚点 → 拉线；拖动期间平移 / 框选 / 节点拖动全部让位
    const anchorElement =
      event.target instanceof Element ? event.target.closest('[data-anchor-side]') : null;
    if (event.button === 0 && !space && anchorElement !== null && nodeId !== null) {
      event.preventDefault();
      const side: AnchorSide = anchorElement.getAttribute('data-anchor-side') === 'left' ? 'left' : 'right';
      setSelected(new Set([nodeId]));
      setSelectedEdgeId(null);
      setEditingId(null);
      setMenu(null);
      const next: ConnectDraft = { from: nodeId, side, point: world, target: null };
      connectRef.current = next;
      setConnect(next);
      startGesture(event, { kind: 'connect', pointerId: event.pointerId, from: nodeId, side });
      return;
    }

    // 选中节点的四角：显式手柄优先，缩得很小时再用几何热区兜底
    if (event.button === 0 && !space && nodeId !== null && selected.has(nodeId)) {
      const node = nodeIndex.get(nodeId);
      const cornerElement =
        event.target instanceof Element ? event.target.closest('[data-resize-corner]') : null;
      const attr = cornerElement?.getAttribute('data-resize-corner') ?? null;
      const corner =
        node === undefined
          ? null
          : isResizeCorner(attr)
            ? attr
            : hitTestResizeCorner(node.rect, world, viewportRef.current.zoom);
      if (corner !== null && node !== undefined) {
        event.preventDefault();
        setSelectedEdgeId(null);
        setEditingId(null);
        setMenu(null);
        cancelDraftCommit();
        draftCommitAtRef.current = null;
        draftRef.current = new Map([[nodeId, node.rect]]);
        startGesture(
          event,
          { kind: 'resize', pointerId: event.pointerId, nodeId, corner, origin: node.rect },
          event.target instanceof Element ? event.target.closest('[data-node-id]') : null,
        );
        startFrameProbe();
        return;
      }
    }

    if (event.button === 1 || space) {
      event.preventDefault();
      setPanning(true);
      startGesture(event, {
        kind: 'pan',
        pointerId: event.pointerId,
        start: local,
        origin: viewportRef.current,
      });
      return;
    }

    if (nodeId !== null) {
      const nodeElement =
        event.target instanceof Element ? event.target.closest('[data-node-id]') : null;
      const next = event.shiftKey
        ? new Set([...selected, nodeId])
        : selected.has(nodeId)
          ? new Set(selected)
          : new Set([nodeId]);
      setSelected(next);
      setSelectedEdgeId(null);
      const origins = new Map<string, CanvasRect>();
      for (const node of scene?.nodes ?? []) {
        if (next.has(node.id)) origins.set(node.id, node.rect);
      }
      if (origins.size === 0) return;
      cancelDraftCommit();
      draftCommitAtRef.current = null;
      // 这里不能 preventDefault：取消 pointerdown 会连带吞掉双击，
      // 而自由文本节点的就地编辑依赖 dblclick；拖拽期间的选中由 CSS user-select 关闭。
      startGesture(event, { kind: 'drag', pointerId: event.pointerId, start: world, origins }, nodeElement);
      startFrameProbe();
      return;
    }

    if (!event.shiftKey) setSelected(new Set());
    setSelectedEdgeId(null);
    const rect = { x: world.x, y: world.y, w: 0, h: 0 };
    marqueeRef.current = rect;
    setMarquee(rect);
    startGesture(event, {
      kind: 'marquee',
      pointerId: event.pointerId,
      start: world,
      additive: event.shiftKey,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;

    const local = localPoint(event);
    if (gesture.kind === 'pan') {
      commitViewport({
        ...gesture.origin,
        x: gesture.origin.x + (local.x - gesture.start.x),
        y: gesture.origin.y + (local.y - gesture.start.y),
      });
      return;
    }

    const world = screenToWorld(local, viewportRef.current);
    if (gesture.kind === 'marquee') {
      const rect = normalizeRect(gesture.start, world);
      marqueeRef.current = rect;
      setMarquee(rect);
      return;
    }

    if (gesture.kind === 'connect') {
      // 热区按屏幕像素换算，缩到很小也点得到目标
      const pad = anchorHitRadius(viewportRef.current.zoom);
      const hit = hitTestNodeWithAnchors(scene?.nodes ?? [], world, pad);
      const target = hit !== null && hit.kind !== 'group' && hit.id !== gesture.from ? hit.id : null;
      const next: ConnectDraft = { from: gesture.from, side: gesture.side, point: world, target };
      connectRef.current = next;
      setConnect(next);
      return;
    }

    if (gesture.kind === 'resize') {
      const started = import.meta.env.DEV ? performance.now() : 0;
      const rect = resizeRect(gesture.origin, gesture.corner, world, {
        keepAspect: event.shiftKey,
      });
      const next = new Map<string, CanvasRect>([[gesture.nodeId, rect]]);
      draftRef.current = next;
      paintNodeRect(gesture.nodeId, rect);
      paintEdges(next);
      if (draftRafRef.current === null) draftCommitAtRef.current = started;
      scheduleDraftCommit();
      if (import.meta.env.DEV && probeRef.current !== null) {
        probeRef.current.handler.push(performance.now() - started);
      }
      return;
    }

    const dx = world.x - gesture.start.x;
    const dy = world.y - gesture.start.y;
    const started = import.meta.env.DEV ? performance.now() : 0;
    const next = new Map<string, CanvasRect>();
    for (const [id, rect] of gesture.origins) {
      // 拖动过程中不吸附网格：连续位移才不会按 8px 一跳一跳
      next.set(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
    }
    draftRef.current = next;
    for (const [id, rect] of next) paintNodeRect(id, rect);
    paintEdges(next);
    if (draftRafRef.current === null) draftCommitAtRef.current = started;
    scheduleDraftCommit();
    // DEV：一次 pointermove 的同步处理耗时（提交本身在帧末，已计入响应延迟）
    if (import.meta.env.DEV && probeRef.current !== null) {
      probeRef.current.handler.push(performance.now() - started);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setPanning(false);
    const local = localPoint(event);
    if (gesture.kind === 'drag' || gesture.kind === 'resize') stopFrameProbe();

    if (gesture.kind === 'marquee') {
      const rect = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (rect !== null) {
        const hits = nodesInRect(scene?.nodes ?? [], rect).map((node) => node.id);
        setSelected((previous) => new Set(gesture.additive ? [...previous, ...hits] : hits));
      }
      return;
    }

    if (gesture.kind === 'connect') {
      const pending = connectRef.current;
      connectRef.current = null;
      setConnect(null);
      if (pending === null || scene === null || canvasId === null) return;
      const plan = planConnection(scene, pending.from, pending.side, pending.target, (prefix) => `${prefix}_${createUlid()}`);
      // 松开在空白处：在松手位置弹创建菜单；选取消则什么都不建、也无残留预览线
      if (shouldOpenAnchorMenu(pending.target, plan !== null)) {
        setAnchorMenu({
          from: pending.from,
          side: pending.side,
          point: screenToWorld(local, viewportRef.current),
          x: local.x,
          y: local.y,
          purpose: 'anchor',
        });
        return;
      }
      if (plan === null) return;
      if (plan.kind === 'duplicate') {
        // 已存在连线：高亮那一条，不新建
        setSelected(new Set());
        setSelectedEdgeId(plan.edgeId);
        return;
      }
      void kernel.canvas
        .apply(canvasId, [{ type: 'addEdge', edge: plan.edge }])
        .then(() => {
          setSelected(new Set());
          setSelectedEdgeId(plan.edge.id);
        })
        .catch(reportError);
      return;
    }

    if (gesture.kind === 'resize') {
      cancelDraftCommit();
      draftCommitAtRef.current = null;
      const rect = draftRef.current.get(gesture.nodeId) ?? gesture.origin;
      const final = new Map<string, CanvasRect>([[gesture.nodeId, rect]]);
      draftRef.current = final;
      paintNodeRect(gesture.nodeId, rect);
      paintEdges(final);
      setDraft(final);
      const unchanged =
        rect.x === gesture.origin.x &&
        rect.y === gesture.origin.y &&
        rect.w === gesture.origin.w &&
        rect.h === gesture.origin.h;
      if (unchanged || canvasId === null) {
        draftRef.current = new Map();
        setDraft(new Map());
        return;
      }
      // 松手只提交一次 updateNode；组节点缩放不带动成员（成员是独立节点）
      void kernel.canvas
        .apply(canvasId, [{ type: 'updateNode', id: gesture.nodeId, patch: { rect } }])
        .then(() => {
          draftRef.current = new Map();
          if (mountedRef.current) setDraft(new Map());
        })
        .catch((cause: unknown) => {
          paintNodeRect(gesture.nodeId, gesture.origin);
          paintEdges(new Map([[gesture.nodeId, gesture.origin]]));
          draftRef.current = new Map();
          setDraft(new Map());
          reportError(cause);
        });
      return;
    }

    if (gesture.kind === 'drag') {
      cancelDraftCommit();
      draftCommitAtRef.current = null;
      const grid = scene?.grid ?? { size: 8 as const, snap: false };
      const final = new Map<string, CanvasRect>();
      for (const [id, rect] of draftRef.current) final.set(id, snapRect(rect, grid));
      draftRef.current = final;
      // 松手才吸附：先按吸附结果重画一次，再一次性提交内核
      for (const [id, rect] of final) paintNodeRect(id, rect);
      paintEdges(final);
      setDraft(final);
      const ops = [...final.entries()]
        .filter(([id, rect]) => {
          const origin = gesture.origins.get(id);
          return origin !== undefined && (origin.x !== rect.x || origin.y !== rect.y);
        })
        .map(([id, rect]) => ({ type: 'updateNode' as const, id, patch: { rect } }));
      if (ops.length === 0 || canvasId === null) {
        draftRef.current = new Map();
        setDraft(new Map());
        return;
      }
      void kernel.canvas
        .apply(canvasId, ops)
        .then(() => {
          draftRef.current = new Map();
          if (mountedRef.current) setDraft(new Map());
        })
        .catch((cause: unknown) => {
          // 落盘失败：DOM 直接画回原位置，避免停在「未落盘」的坐标
          for (const [id, rect] of gesture.origins) paintNodeRect(id, rect);
          paintEdges(new Map(gesture.origins));
          draftRef.current = new Map();
          setDraft(new Map());
          reportError(cause);
        });
    }
  };

  const commitText = useCallback(
    (id: string, text: string): void => {
      setEditingId(null);
      const node = sceneRef.current?.nodes.find((item) => item.id === id);
      const planned = planTextUpdate(node, text);
      if (planned === null || canvasId === null) return;
      void kernel.canvas
        .apply(canvasId, [{ type: 'updateNode', id, patch: { text: planned.text } }])
        .catch(reportError);
    },
    [canvasId, kernel, reportError],
  );

  /** 引线终点新建节点：节点与边在同一批 mutation 里落盘；空白右键入口只落节点 */
  const createNodeFromAnchor = useCallback(
    (state: AnchorMenuState, node: CanvasNode, startEdit: boolean = false): void => {
      if (canvasId === null) return;
      const mutations: CanvasMutation[] = [{ type: 'addNode', node }];
      if (state.from !== null && state.side !== null) {
        mutations.push({
          type: 'addEdge',
          edge: planAnchorEdge(state.from, state.side, node.id, `e_${createUlid()}`),
        });
      }
      void kernel.canvas
        .apply(canvasId, mutations)
        .then(() => {
          setSelected(new Set([node.id]));
          setSelectedEdgeId(null);
          // 落盘进入场景后再进编辑态：过早 setEditingId 时，极快输入+失焦
          // 会让 commitText 找不到节点而静默丢弃首段文字
          if (startEdit && mountedRef.current) setEditingId(node.id);
        })
        .catch(reportError);
    },
    [canvasId, kernel, reportError],
  );

  const createAnchorNote = useCallback((): void => {
    const state = anchorMenu;
    setAnchorMenu(null);
    // 「从库添加」入口没有引线起点，不提供新建节点
    if (state === null || scene === null || state.from === null || state.side === null) return;
    const node: CanvasNode = {
      id: `n_${createUlid()}`,
      kind: 'note',
      docId: null,
      text: '',
      rect: centeredNodeRect(state.point),
      z: scene.nodes.reduce((max, item) => Math.max(max, item.z), 0) + 1,
      groupId: null,
      meta: {},
    };
    createNodeFromAnchor(state, node, true);
  }, [anchorMenu, createNodeFromAnchor, scene]);

  const pickAnchorDoc = useCallback(
    (doc: AnchorDoc): void => {
      const state = anchorMenu;
      setAnchorMenu(null);
      if (state === null || scene === null) return;
      const meta = docIndex.get(doc.id);
      if (meta === undefined) {
        showError('文档已不在库内');
        return;
      }
      const node: CanvasNode = {
        id: `n_${createUlid()}`,
        kind: 'doc',
        docId: meta.id,
        text: null,
        rect: centeredNodeRect(state.point),
        z: scene.nodes.reduce((max, item) => Math.max(max, item.z), 0) + 1,
        groupId: null,
        meta: {},
      };
      createNodeFromAnchor(state, node);
    },
    [anchorMenu, createNodeFromAnchor, docIndex, scene, showError],
  );

  const startAnchorArticle = useCallback((): void => {
    const state = anchorMenu;
    if (state === null || state.from === null || state.side === null) return;
    setAnchorMenu(null);
    const rect = centeredNodeRect(state.point);
    setArticlePrompt({
      x: state.x,
      y: state.y,
      point: { x: rect.x, y: rect.y },
      value: '未命名文章',
      anchor: { from: state.from, side: state.side },
    });
  }, [anchorMenu]);

  /** 命令计划落地：mutate 走内核，其余分支只改 UI 状态 */
  const applyPlan = useCallback(
    (plan: CommandPlan, point: CanvasPoint): void => {
      if (plan.kind === 'copy') {
        writeClipboard(plan.payload);
        return;
      }
      if (plan.kind === 'select') {
        setSelected(new Set(plan.ids));
        setSelectedEdgeId(null);
        return;
      }
      if (plan.kind === 'viewport') {
        commitViewport(plan.viewport);
        return;
      }
      if (plan.kind === 'prompt-edge-label') {
        setLabelPrompt({ edgeId: plan.edgeId, x: point.x, y: point.y, value: plan.value });
        return;
      }
      if (plan.kind === 'create-article') {
        setMenu(null);
        setArticlePrompt({ x: point.x, y: point.y, point: plan.point, value: '未命名文章', anchor: null });
        return;
      }
      if (plan.kind === 'pick-doc') {
        setMenu(null);
        setAnchorMenu({
          from: null,
          side: null,
          point: plan.point,
          x: point.x,
          y: point.y,
          purpose: 'insert',
        });
        return;
      }
      if (plan.kind === 'open-float') {
        setMenu(null);
        onOpenFloat(plan.docId, plan.focus);
        return;
      }

      const applyExtras = (): void => {
        if (plan.select !== undefined) setSelected(new Set(plan.select));
        if (plan.selectEdge !== undefined) setSelectedEdgeId(plan.selectEdge);
        if (plan.editNode !== undefined) setEditingId(plan.editNode);
      };

      if (plan.mutations.length === 0 || canvasId === null) {
        applyExtras();
        return;
      }
      void kernel.canvas
        .apply(canvasId, plan.mutations)
        .then(applyExtras)
        .catch(reportError);
    },
    [canvasId, commitViewport, kernel, onOpenFloat, reportError],
  );

  /** 菜单与快捷键共用入口：命令不可用时给出可见反馈，绝不留静默空操作 */
  const executeCommand = useCallback(
    (command: string, target: MenuTarget): void => {
      if (scene === null) return;
      const element = surfaceRef.current;
      const plan = planCommand({
        command,
        target,
        scene,
        selection: [...selected],
        clipboard: readClipboard(),
        newId: (prefix) => `${prefix}_${createUlid()}`,
        viewportSize: { w: element?.clientWidth ?? 0, h: element?.clientHeight ?? 0 },
      });
      if (plan === null) {
        showError('该命令在当前状态下不可用');
        return;
      }
      applyPlan(plan, target.point);
    },
    [applyPlan, scene, selected, showError],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  const closeAnchorMenu = useCallback(() => {
    setAnchorMenu(null);
  }, []);

  const onMenuSelect = useCallback(
    (command: string): void => {
      const current = menu;
      setMenu(null);
      if (current === null) return;
      executeCommand(command, current.target);
    },
    [executeCommand, menu],
  );

  const submitEdgeLabel = useCallback(
    (value: string): void => {
      const prompt = labelPrompt;
      setLabelPrompt(null);
      if (prompt === null || scene === null || canvasId === null) return;
      const mutation = planEdgeLabel(scene, prompt.edgeId, value);
      if (mutation === null) {
        showError('连线已不存在');
        return;
      }
      void kernel.canvas.apply(canvasId, [mutation]).catch(reportError);
    },
    [canvasId, kernel, labelPrompt, reportError, scene, showError],
  );

  const cancelEdgeLabel = useCallback(() => {
    setLabelPrompt(null);
  }, []);

  /** 一步新建文章：标题确认后落盘 + 建节点；失败由 article-service 负责回滚 */
  const submitArticle = useCallback(
    (value: string): void => {
      const prompt = articlePrompt;
      setArticlePrompt(null);
      if (prompt === null || canvasId === null || scene === null) return;
      const nodeId = `n_${createUlid()}`;
      const z = scene.nodes.reduce((max, node) => Math.max(max, node.z), 0) + 1;
      createArticleOnCanvas({
        docs: kernel.docs,
        canvas: kernel.canvas,
        canvasId,
        title: value,
        point: prompt.point,
        nodeId,
        size: { w: DEFAULT_NODE_SIZE.w, h: DEFAULT_NODE_SIZE.h },
        z,
      })
        .then((result) => {
          setSelected(new Set([nodeId]));
          setSelectedEdgeId(null);
          onOpenFloat(result.snapshot.meta.id, 'title');
          const anchor = prompt.anchor;
          if (anchor !== null && scene.nodes.some((node) => node.id === anchor.from)) {
            const edge = planAnchorEdge(anchor.from, anchor.side, nodeId, `e_${createUlid()}`);
            return kernel.canvas.apply(canvasId, [{ type: 'addEdge', edge }]);
          }
          return null;
        })
        .catch(reportError);
    },
    [articlePrompt, canvasId, kernel, onOpenFloat, reportError, scene],
  );

  const openDoc = useCallback(
    (nodeId: string): void => {
      const node = sceneRef.current?.nodes.find((item) => item.id === nodeId);
      if (node === undefined || node.docId === null) {
        showError('该节点没有可打开的文档');
        return;
      }
      onOpenFloat(node.docId, null);
    },
    [onOpenFloat, showError],
  );

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    // 浮窗 / 菜单 / 输入框内的右键走各自的原生行为，不弹画布菜单
    if (event.target instanceof Element && event.target.closest('[data-canvas-overlay]') !== null) return;
    event.preventDefault();
    setAnchorMenu(null);
    const element = surfaceRef.current;
    if (scene === null || element === null) return;
    const bounds = element.getBoundingClientRect();
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

    const openMenu = (target: MenuTarget): void => {
      setMenu({
        target,
        x: point.x,
        y: point.y,
        items: buildCanvasMenu({ target, scene, clipboard: readClipboard() }),
      });
    };

    const world = screenToWorld(point, viewportRef.current);

    const domId = nodeIdAt(event.target);
    const node =
      domId === null
        ? hitTestNode(scene.nodes, world)
        : (scene.nodes.find((item) => item.id === domId) ?? hitTestNode(scene.nodes, world));
    if (node !== null) {
      const inMultiSelection = selected.has(node.id) && selected.size > 1;
      if (!selected.has(node.id)) setSelected(new Set([node.id]));
      setSelectedEdgeId(null);
      openMenu(
        inMultiSelection
          ? { kind: 'selection', ids: [...selected], point }
          : { kind: 'node', id: node.id, point },
      );
      return;
    }

    // SVG 透明命中描边在部分 WebView 上收不到 contextmenu，用几何距离兜底
    const edgeElement = event.target instanceof Element ? event.target.closest('[data-edge-id]') : null;
    const domEdgeId = edgeElement instanceof HTMLElement ? (edgeElement.dataset.edgeId ?? null) : null;
    const edgeId =
      domEdgeId ?? hitTestEdge(scene, world, EDGE_HIT_SCREEN_PX / viewportRef.current.zoom);
    if (edgeId !== null) {
      setSelectedEdgeId(edgeId);
      setSelected(new Set());
      openMenu({ kind: 'edge', id: edgeId, point });
      return;
    }

    openMenu({ kind: 'empty', point });
  };

  // 菜单上标注的快捷键必须真的生效，否则等同于点了没反应
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || isTypingTarget(event.target)) return;
      // 有原生文本选区（AI 面板回答、阅读态正文等可选文字）时让位给系统复制/全选，
      // 只在画布节点选择生效时接管
      if ((window.getSelection()?.isCollapsed ?? true) === false) return;
      const point = { x: 0, y: 0 };
      const key = event.key.toLowerCase();
      if (key === 'a') {
        event.preventDefault();
        executeCommand('view.select-all', { kind: 'empty', point });
        return;
      }
      if (key === 'c' && selected.size > 0) {
        event.preventDefault();
        executeCommand('node.copy', { kind: 'selection', ids: [...selected], point });
        return;
      }
      if (key === 'd' && selected.size > 0) {
        event.preventDefault();
        executeCommand('node.duplicate', { kind: 'selection', ids: [...selected], point });
        return;
      }
      if (key === 'v' && readClipboard() !== null) {
        // 剪贴板为空时不弹错误：静默让位，与系统行为一致
        event.preventDefault();
        executeCommand('node.paste', { kind: 'empty', point });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [executeCommand, selected]);

  const marqueeScreen =
    marquee === null
      ? null
      : {
          ...worldToScreen({ x: marquee.x, y: marquee.y }, viewport),
          w: marquee.w * viewport.zoom,
          h: marquee.h * viewport.zoom,
        };

  const surfaceClass = [styles.canvas, space ? styles.grab : '', panning ? styles.grabbing : '']
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');

  const failure = canvasQuery.isError ? toErrorText(canvasQuery.error) : error;

  return (
    <div
      ref={surfaceRef}
      className={surfaceClass}
      aria-label="无限画布"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    >
      <div
        className={styles.grid}
        style={cssVars({
          '--canvas-grid-step': `${(scene?.grid.size ?? 8) * viewport.zoom}px`,
          '--canvas-grid-x': `${viewport.x}px`,
          '--canvas-grid-y': `${viewport.y}px`,
        })}
      />

      {/* 连线放在屏幕空间的 SVG 里：只有落在 SVG 视口内的描边才能被命中，
          1x1 的 SVG 虽然能靠 overflow 画出来，却收不到 pointer/contextmenu 事件 */}
      <svg
        className={styles.edges}
        aria-hidden="true"
        style={cssVars({ '--viewport-zoom': viewport.zoom })}
      >
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
            edges={scene?.edges ?? EMPTY_EDGES}
            nodes={nodeIndex}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={selectEdge}
            tick={edgeTick}
          />
        </g>
        {connect === null
          ? null
          : (() => {
              const anchorNode = nodeIndex.get(connect.from);
              if (anchorNode === undefined) return null;
              const rect = draft.get(connect.from) ?? anchorNode.rect;
              const start = worldToScreen(anchorPoint(rect, connect.side, viewport.zoom), viewport);
              const end = worldToScreen(connect.point, viewport);
              return <path className={styles.connectionPreview} d={previewPath(start, end)} />;
            })()}
      </svg>

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
            onStartEdit={setEditingId}
            onCommitText={commitText}
            onOpenDoc={openDoc}
          />
        ))}
      </div>

      {marqueeScreen === null ? null : (
        <div
          className={styles.marquee}
          style={cssVars({
            '--marquee-x': `${marqueeScreen.x}px`,
            '--marquee-y': `${marqueeScreen.y}px`,
            '--marquee-w': `${marqueeScreen.w}px`,
            '--marquee-h': `${marqueeScreen.h}px`,
          })}
        />
      )}

      {anchorMenu === null ? null : (
        <AnchorMenu
          x={anchorMenu.x}
          y={anchorMenu.y}
          docs={documents.data ?? []}
          purpose={anchorMenu.purpose}
          onNote={createAnchorNote}
          onPickDoc={pickAnchorDoc}
          onNewArticle={startAnchorArticle}
          onClose={closeAnchorMenu}
        />
      )}

      {menu === null ? null : (
        <ContextMenu
          items={menu.items}
          x={menu.x}
          y={menu.y}
          onSelect={onMenuSelect}
          onClose={closeMenu}
        />
      )}

      {labelPrompt === null ? null : (
        <LabelPrompt
          x={labelPrompt.x}
          y={labelPrompt.y}
          value={labelPrompt.value}
          onSubmit={submitEdgeLabel}
          onCancel={cancelEdgeLabel}
        />
      )}

      {articlePrompt === null ? null : (
        <LabelPrompt
          x={articlePrompt.x}
          y={articlePrompt.y}
          value={articlePrompt.value}
          onSubmit={submitArticle}
          onCancel={() => {
            setArticlePrompt(null);
          }}
        />
      )}

      <FloatLayer onCursor={onCursor} />

      {scene !== null && scene.nodes.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>空白画布</p>
          <p className={styles.emptyHint}>滚轮缩放 · 空格或中键拖拽平移 · 拖拽框选</p>
        </div>
      ) : null}

      <div className={styles.hud}>
        <span>缩放 {Math.round(viewport.zoom * 100)}%</span>
        {scene === null ? null : (
          <span>
            {scene.nodes.length} 节点 · {scene.edges.length} 连线
          </span>
        )}
        {!import.meta.env.DEV || refreshMs === null ? null : (
          <span>刷新 {refreshMs.toFixed(1)}ms</span>
        )}
        {!import.meta.env.DEV || dragPerf === null ? null : (
          <span>
            拖动 {dragPerf.frames} 帧 · 均 {dragPerf.avg.toFixed(1)}ms · P95 {dragPerf.p95.toFixed(1)}ms ·
            最长 {dragPerf.max.toFixed(1)}ms · 掉帧 {(dragPerf.dropped * 100).toFixed(0)}% · 处理{' '}
            {dragPerf.handler.toFixed(2)}ms · 响应 {dragPerf.latency.toFixed(1)}ms
          </span>
        )}
      </div>

      {canvasQuery.isPending ? <p className={styles.notice}>正在打开画布…</p> : null}
      {failure === null ? null : <p className={styles.error}>{failure}</p>}
    </div>
  );
};
