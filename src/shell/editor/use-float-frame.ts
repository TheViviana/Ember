import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { DocId } from '#doc-model';
import { useMachineStore, type FloatPosition } from '../../data/stores/machine-store.ts';
import { cssVars } from '../canvas/css-vars.ts';
import { layout, space } from '../theme/tokens.ts';
import {
  cascadeFloatFrame,
  clampFloatSize,
  initialFloatFrame,
  moveFloatFrame,
  resolveFloatResize,
  FLOAT_ZONES,
  type FloatBounds,
  type FloatContainer,
  type FloatFrame,
  type FloatSize,
  type FloatZone,
} from './float-layout.ts';
import { focusedFloatFrame } from './focus-layout.ts';
import { useFocusStore } from './focus-store.ts';

interface ResizeDrag {
  readonly zone: FloatZone;
  readonly start: FloatFrame;
  readonly bounds: FloatBounds;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** 标题栏拖动：超过阈值才接管，未超过时把点击留给标题（原地改名） */
interface MoveDrag {
  readonly start: FloatFrame;
  readonly container: FloatContainer;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  engaged: boolean;
}

/** 拖窗判定阈值：小于它算点击（标题原地改名），不小于它才算拖动 */
const MOVE_THRESHOLD_PX = 3;

const SPACE_XL = Number.parseFloat(space.xl);
const FLOAT_INSET_RIGHT = SPACE_XL;
const FLOAT_INSET_BOTTOM = SPACE_XL + layout.statusbarHeight;

const readBounds = (): FloatBounds => {
  const width = typeof window === 'undefined' ? 0 : (window.screen?.availWidth ?? 0);
  const height = typeof window === 'undefined' ? 0 : (window.screen?.availHeight ?? 0);
  return {
    maxWidth: width > 0 ? width : layout.floatWidth,
    maxHeight: height > 0 ? height : layout.floatHeight,
  };
};

export interface FloatFrameOptions {
  readonly docId: DocId;
  readonly defaultSlot: number;
  readonly panelRef: RefObject<HTMLElement | null>;
}

/** 浮窗定位：记忆尺寸 / 位置、拖动、四角缩放、专注几何与容器夹紧 */
export const useFloatFrame = ({ docId, defaultSlot, panelRef }: FloatFrameOptions) => {
  const [frame, setFrame] = useState<FloatFrame | null>(null);
  const frameRef = useRef<FloatFrame | null>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  const resizedRef = useRef(false);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const initializedSizeRef = useRef<FloatSize | undefined>(undefined);
  const initializedPositionRef = useRef<FloatPosition | undefined>(undefined);
  const [resizing, setResizing] = useState(false);
  const [moving, setMoving] = useState(false);
  const bounds = useMemo(readBounds, []);
  /** 专注模式只对当前目标浮窗生效；几何在渲染时临时计算，不写回 frame */
  const focusActive = useFocusStore((state) => state.active);
  const focusDocId = useFocusStore((state) => state.docId);
  const focused = focusActive && focusDocId !== null && String(focusDocId) === String(docId);
  /** 容器实测尺寸：专注几何需要随窗口缩放实时居中放大 */
  const [containerSize, setContainerSize] = useState<FloatContainer | null>(null);

  const savedSize = useMachineStore((state) => state.floatSizes[String(docId)]);
  const savedPosition = useMachineStore((state) => state.floatPositions[String(docId)]);
  const rememberFloatSize = (id: string, size: FloatSize): void => {
    useMachineStore.getState().rememberFloatSize(id, size);
  };
  const rememberFloatPosition = (id: string, position: FloatPosition): void => {
    useMachineStore.getState().rememberFloatPosition(id, position);
  };

  const applyFrame = useCallback((next: FloatFrame): void => {
    frameRef.current = next;
    setFrame(next);
  }, []);

  // 右侧 AI 面板开合会缩窄画布：只按新容器重新夹取当前帧，绝不写回位置记忆
  useEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement ?? null;
    if (container === null) return;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
      const area = { width: container.clientWidth, height: container.clientHeight };
      // 专注几何依赖容器实测尺寸；与下面的普通帧夹紧共用同一次观测
      setContainerSize(area);
      const current = frameRef.current;
      if (current === null) return;
      const sized = clampFloatSize({ width: current.width, height: current.height }, bounds);
      const next = moveFloatFrame({ ...current, width: sized.width, height: sized.height }, 0, 0, area);
      if (
        next.left !== current.left ||
        next.top !== current.top ||
        next.width !== current.width ||
        next.height !== current.height
      ) {
        applyFrame(next);
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [applyFrame, bounds, panelRef]);

  // 首次打开（或水合完成）时按记忆尺寸与位置摆放；用户拖动/缩放过后不再被存储更新覆盖
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement ?? null;
    if (container === null) return;
    if (
      frameRef.current !== null &&
      (resizedRef.current ||
        movedRef.current ||
        (savedSize === initializedSizeRef.current && savedPosition === initializedPositionRef.current))
    ) {
      return;
    }
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    const target = clampFloatSize(
      savedSize ?? { width: layout.floatWidth, height: layout.floatHeight },
      bounds,
    );
    const area = { width: container.clientWidth, height: container.clientHeight };
    initializedSizeRef.current = savedSize;
    initializedPositionRef.current = savedPosition;
    const base =
      savedPosition === undefined
        ? cascadeFloatFrame(
            area,
            target,
            { right: FLOAT_INSET_RIGHT, bottom: FLOAT_INSET_BOTTOM },
            defaultSlot,
          )
        : initialFloatFrame(area, target, { right: FLOAT_INSET_RIGHT, bottom: FLOAT_INSET_BOTTOM });
    // 记忆位置可能来自更宽的窗口/另一块屏，恢复时按当前容器夹紧
    applyFrame(
      savedPosition === undefined
        ? base
        : moveFloatFrame({ ...base, left: savedPosition.left, top: savedPosition.top }, 0, 0, area),
    );
  }, [applyFrame, bounds, defaultSlot, panelRef, savedPosition, savedSize]);

  const beginMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    // 专注模式下位置由临时几何决定，标题栏不再承担拖动
    if (focused) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, [contenteditable="true"], [data-float-close], [data-float-focus]',
      ) !== null
    ) {
      return;
    }
    const start = frameRef.current;
    const container = panelRef.current?.parentElement ?? null;
    if (start === null || container === null) return;
    suppressClickRef.current = false;
    moveRef.current = {
      start,
      container: { width: container.clientWidth, height: container.clientHeight },
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      engaged: false,
    };
  };

  const moveMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = moveRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.engaged) {
      if (Math.abs(deltaX) < MOVE_THRESHOLD_PX && Math.abs(deltaY) < MOVE_THRESHOLD_PX) return;
      drag.engaged = true;
      // 拖动一旦成立就吃掉随后的 click，避免松手顺带把标题切进编辑态
      suppressClickRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMoving(true);
    }
    event.preventDefault();
    applyFrame(moveFloatFrame(drag.start, deltaX, deltaY, drag.container));
  };

  const endMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = moveRef.current;
    if (drag === null) return;
    moveRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.engaged) return;
    setMoving(false);
    movedRef.current = true;
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆位置；拖动期间不写文档、也不写机器状态
      rememberFloatPosition(String(docId), { left: current.left, top: current.top });
    }
  };

  const suppressDraggedClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const beginResize = (zone: FloatZone, event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const start = frameRef.current;
    if (start === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      zone,
      start,
      // 每次拖动重新读取工作区，换显示器后夹紧范围仍然正确
      bounds: readBounds(),
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    resizedRef.current = true;
    setResizing(true);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    applyFrame(
      resolveFloatResize(drag.zone, drag.start, event.clientX - drag.x, event.clientY - drag.y, drag.bounds),
    );
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆；拖动期间不写文档、也不写机器状态
      rememberFloatSize(String(docId), { width: current.width, height: current.height });
    }
  };

  // 浮窗内的滚轮只作用于编辑器/大纲，不冒泡到画布触发缩放。
  // 用原生监听而非 React onWheel：画布的 wheel 监听挂在浮窗的祖先节点上，
  // React 的合成事件在根节点才派发，拦不住祖先的原生监听。
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return undefined;
    const stopWheel = (event: WheelEvent): void => {
      event.stopPropagation();
    };
    node.addEventListener('wheel', stopWheel, { passive: true });
    return () => {
      node.removeEventListener('wheel', stopWheel);
    };
  }, [panelRef]);

  /** 专注几何只覆盖渲染值；底层 frame 保持原样，退出后原位置尺寸立即回来 */
  const focusFrame = useMemo(
    () => (focused && containerSize !== null ? focusedFloatFrame(containerSize) : null),
    [containerSize, focused],
  );
  const renderedFrame = focusFrame ?? frame;

  const geometry =
    renderedFrame === null
      ? undefined
      : cssVars({
          '--float-left': `${renderedFrame.left}px`,
          '--float-top': `${renderedFrame.top}px`,
          '--float-right': 'auto',
          '--float-bottom': 'auto',
          '--float-w': `${renderedFrame.width}px`,
          '--float-h': `${renderedFrame.height}px`,
        });

  return {
    focused,
    moving,
    resizing,
    geometry,
    zones: FLOAT_ZONES,
    beginMove,
    moveMove,
    endMove,
    suppressDraggedClick,
    beginResize,
    moveResize,
    endResize,
  };
};
