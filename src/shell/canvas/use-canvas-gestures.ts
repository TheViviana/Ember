import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { CanvasNode, CanvasPoint, CanvasRect, CanvasScene, Viewport } from '#canvas-engine';
import { createUlid } from '#doc-model';
import type { CanvasId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { shouldOpenAnchorMenu } from './anchor-menu.ts';
import { planConnection } from './commands.ts';
import { useDragProbe } from './dev-probe.ts';
import {
  changedRectOps,
  dragDrafts,
  snapDrafts,
  type ConnectDraft,
  type Gesture,
} from './gestures.ts';
import {
  anchorHitRadius,
  edgeGeometry,
  hitTestNodeWithAnchors,
  nodesInRect,
  normalizeRect,
  resizeRect,
  screenToWorld,
} from './geometry.ts';
import { nodeIdAt, resolveResizeCorner, isTypingTarget } from './surface-hit.ts';
import type { AnchorMenuState } from './use-canvas-commands.ts';

/** 直接写节点元素上的几何变量：拖动 / 缩放的每帧路径，不经过 React */
const applyNodeRect = (element: HTMLElement, rect: CanvasRect): void => {
  element.style.setProperty('--node-x', `${rect.x}px`);
  element.style.setProperty('--node-y', `${rect.y}px`);
  element.style.setProperty('--node-w', `${rect.w}px`);
  element.style.setProperty('--node-h', `${rect.h}px`);
};

export interface CanvasGestureOptions {
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
  readonly scene: CanvasScene | null;
  readonly canvasId: CanvasId | null;
  readonly viewportRef: RefObject<Viewport>;
  readonly commitViewport: (next: Viewport) => void;
  readonly reportError: (cause: unknown) => void;
  readonly nodeIndex: ReadonlyMap<string, CanvasNode>;
  readonly mountedRef: RefObject<boolean>;
  readonly clearMenu: () => void;
  readonly setAnchorMenu: (state: AnchorMenuState | null) => void;
}

/**
 * 画布手势与选择：指针按下 / 移动 / 松开、框选、拖动、缩放、连线草稿。
 * 只做交互期状态；场景真值始终在内核 CanvasSession。
 */
export const useCanvasGestures = (options: CanvasGestureOptions) => {
  const {
    surfaceRef,
    scene,
    canvasId,
    viewportRef,
    commitViewport,
    reportError,
    nodeIndex,
    mountedRef,
    clearMenu,
    setAnchorMenu,
  } = options;
  const kernel = useKernel();
  const probe = useDragProbe();
  const gestureRef = useRef<Gesture | null>(null);
  const marqueeRef = useRef<CanvasRect | null>(null);
  const draftRef = useRef<ReadonlyMap<string, CanvasRect>>(new Map());
  const draftRafRef = useRef<number | null>(null);
  const draftCommitAtRef = useRef<number | null>(null);
  const connectRef = useRef<ConnectDraft | null>(null);

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<CanvasRect | null>(null);
  const [draft, setDraft] = useState<ReadonlyMap<string, CanvasRect>>(() => new Map());
  /** 取消手势 / 提交失败时递增，强制 memo 的连线层按场景矩形重绘 */
  const [edgeTick, setEdgeTick] = useState(0);
  const [connect, setConnect] = useState<ConnectDraft | null>(null);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);

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

  const paintNodeRect = useCallback(
    (id: string, rect: CanvasRect): void => {
      const element = surfaceRef.current?.querySelector(`[data-node-id="${id}"]`);
      if (!(element instanceof HTMLElement)) return;
      applyNodeRect(element, rect);
    },
    [surfaceRef],
  );

  /** 只重写受影响连线的 d，不触发 EdgeLayer 重新渲染 */
  const paintEdges = useCallback(
    (rects: ReadonlyMap<string, CanvasRect>): void => {
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
    },
    [nodeIndex, scene, surfaceRef],
  );

  /** 一帧最多提交一次 setDraft；同一帧内的 pointermove 只累积在 draftRef */
  const scheduleDraftCommit = useCallback((): void => {
    if (draftRafRef.current !== null) return;
    draftRafRef.current = window.requestAnimationFrame(() => {
      draftRafRef.current = null;
      const assigned = draftCommitAtRef.current;
      setDraft(new Map(draftRef.current));
      if (assigned !== null) probe.markLatency(assigned);
    });
  }, [probe]);

  const cancelDraftCommit = useCallback((): void => {
    if (draftRafRef.current === null) return;
    window.cancelAnimationFrame(draftRafRef.current);
    draftRafRef.current = null;
  }, []);

  // 卸载时取消挂起的 rAF，避免对已关闭的画布再提交草稿
  useEffect(
    () => () => {
      if (draftRafRef.current !== null) {
        window.cancelAnimationFrame(draftRafRef.current);
        draftRafRef.current = null;
      }
    },
    [],
  );

  /** 取消拖动 / 缩放：把 DOM 上直接改过的几何还原成场景值 */
  const discardDraft = useCallback((): void => {
    cancelDraftCommit();
    draftCommitAtRef.current = null;
    draftRef.current = new Map();
    setDraft(new Map());
    setEdgeTick((value) => value + 1);
  }, [cancelDraftCommit]);

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
        // React 状态清空后 style 值没变，React 不会回写 CSS 变量，必须手动还原
        for (const [id, rect] of origins) paintNodeRect(id, rect);
        discardDraft();
        return;
      }
      if (gestureRef.current?.kind === 'resize') {
        const { nodeId, origin } = gestureRef.current;
        gestureRef.current = null;
        paintNodeRect(nodeId, origin);
        discardDraft();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [discardDraft, paintNodeRect]);

  const localPoint = (event: ReactPointerEvent<HTMLDivElement>): CanvasPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
      const side = anchorElement.getAttribute('data-anchor-side') === 'left' ? 'left' : 'right';
      setSelected(new Set([nodeId]));
      setSelectedEdgeId(null);
      setEditingId(null);
      clearMenu();
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
      const corner = resolveResizeCorner(
        node,
        cornerElement?.getAttribute('data-resize-corner') ?? null,
        world,
        viewportRef.current.zoom,
      );
      if (corner !== null && node !== undefined) {
        event.preventDefault();
        setSelectedEdgeId(null);
        setEditingId(null);
        clearMenu();
        cancelDraftCommit();
        draftCommitAtRef.current = null;
        draftRef.current = new Map([[nodeId, node.rect]]);
        startGesture(
          event,
          { kind: 'resize', pointerId: event.pointerId, nodeId, corner, origin: node.rect },
          event.target instanceof Element ? event.target.closest('[data-node-id]') : null,
        );
        probe.start();
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
      probe.start();
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
      probe.markHandler(started);
      return;
    }

    const dx = world.x - gesture.start.x;
    const dy = world.y - gesture.start.y;
    const started = import.meta.env.DEV ? performance.now() : 0;
    const next = dragDrafts(gesture.origins, dx, dy);
    draftRef.current = next;
    for (const [id, rect] of next) paintNodeRect(id, rect);
    paintEdges(next);
    if (draftRafRef.current === null) draftCommitAtRef.current = started;
    scheduleDraftCommit();
    probe.markHandler(started);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setPanning(false);
    const local = localPoint(event);
    if (gesture.kind === 'drag' || gesture.kind === 'resize') probe.stop();

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
      if (canvasId === null || changedRectOps(final, new Map([[gesture.nodeId, gesture.origin]])).length === 0) {
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
      const final = snapDrafts(draftRef.current, grid);
      draftRef.current = final;
      // 松手才吸附：先按吸附结果重画一次，再一次性提交内核
      for (const [id, rect] of final) paintNodeRect(id, rect);
      paintEdges(final);
      setDraft(final);
      const ops = changedRectOps(final, gesture.origins);
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

  const selectEdge = useCallback((id: string): void => {
    setSelected(new Set());
    setSelectedEdgeId(id);
  }, []);

  /** 切换画布时的一次性重置：清空选择与瞬时手势状态（引用稳定，供 reset effect 安全依赖） */
  const resetTransient = useCallback((): void => {
    setSelected(new Set());
    setSelectedEdgeId(null);
    setEditingId(null);
    setMarquee(null);
    setDraft(new Map());
    setConnect(null);
    setPanning(false);
    setSpace(false);
  }, []);

  return {
    resetTransient,
    selected,
    setSelected,
    selectedEdgeId,
    setSelectedEdgeId,
    editingId,
    setEditingId,
    draft,
    marquee,
    connect,
    edgeTick,
    space,
    panning,
    dragPerf: probe.dragPerf,
    refreshMs: probe.refreshMs,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    selectEdge,
  };
};
