import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasScene, Viewport } from '#canvas-engine';
import type { CanvasId } from '#doc-model';
import type { CanvasSession } from '../../kernel/canvas-host.ts';
import { toErrorText } from '../../kernel/errors.ts';
import type { Disposable } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import { ZOOM_WHEEL_SPEED, zoomAt } from './geometry.ts';

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/**
 * 画布文档会话：内核场景订阅、视口防抖落盘、错误 HUD。
 * 只持有文档级状态；选择、手势与命令菜单在各自 Hook 中。
 */
export const useCanvasDocument = () => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
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
  const [error, setError] = useState<string | null>(null);

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

  // 卸载时取消挂起的 rAF，避免对已关闭的画布再发一次 setViewport
  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    },
    [],
  );

  const docIndex = useMemo(
    () => new Map((documents.data ?? []).map((meta) => [String(meta.id), meta])),
    [documents.data],
  );

  const failure = canvasQuery.isError ? toErrorText(canvasQuery.error) : error;

  return {
    surfaceRef,
    canvasId,
    scene,
    sceneRef,
    viewport,
    viewportRef,
    commitViewport,
    documents,
    docIndex,
    mountedRef,
    failure,
    isPending: canvasQuery.isPending,
    showError,
    reportError,
  };
};
