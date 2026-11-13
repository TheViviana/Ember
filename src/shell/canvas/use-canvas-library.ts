import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { CanvasId } from '#doc-model';
import { toErrorText } from '../../kernel/errors.ts';
import type { CanvasSummary } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';

/** 空间导航位置：总览画布或某张具体画布 */
export type CanvasLocation = { readonly kind: 'overview' } | { readonly kind: 'canvas'; id: CanvasId };

export interface CanvasLibrary {
  /** 全部画布（标题字典序） */
  readonly canvases: readonly CanvasSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  /** 面包屑栈：根恒为总览，末位是当前位置 */
  readonly stack: readonly CanvasLocation[];
  readonly location: CanvasLocation;
  /** 当前画布 id（总览时为 overviewId，未就绪为 null） */
  readonly currentId: CanvasId | null;
  readonly overviewId: CanvasId | null;
  /** 主页固定（settings.ui.defaultCanvasId） */
  readonly homeCanvasId: string | null;
  /** 最近访问（settings.ui.recentCanvasIds，新在前，最多 10 条） */
  readonly recentCanvasIds: readonly string[];
  /** 画布清单索引：Portal 渲染与统一搜索用（String(id) → 标题/节点数） */
  readonly canvasIndex: ReadonlyMap<string, { readonly title: string; readonly nodeCount: number }>;
  showOverview(): void;
  openCanvas(id: CanvasId): void;
  /** Portal 双击进入：推栈 */
  enterPortal(id: CanvasId): void;
  /** 面包屑返回：回退一层；已在总览时返回 false */
  back(): boolean;
  /** 面包屑直达：截断到栈中第 index 层 */
  jumpTo(index: number): void;
  createCanvas(title: string): Promise<CanvasId | null>;
  renameCanvas(id: CanvasId, title: string): Promise<void>;
  duplicateCanvas(id: CanvasId): Promise<void>;
  removeCanvas(id: CanvasId): Promise<void>;
  /** 主页固定 / 取消固定（null = 取消） */
  pinHome(id: CanvasId | null): Promise<void>;
}

const RECENT_LIMIT = 10;

/**
 * 画布库外壳状态：多画布清单、总览导航、面包屑栈、主页固定、最近访问。
 * 画布布局数据全部在内核（.workbench/canvas/），这里只持有导航态。
 */
export const useCanvasLibrary = (): CanvasLibrary => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const [stack, setStack] = useState<readonly CanvasLocation[]>([{ kind: 'overview' }]);

  const canvasesQuery = useQuery({
    queryKey: ['canvases', 'list'],
    queryFn: () => kernel.canvas.list(),
  });
  const overviewQuery = useQuery({
    queryKey: ['canvas', 'overview'],
    queryFn: () => kernel.canvas.ensureOverview(),
  });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => kernel.settings.read() });

  const location = useMemo<CanvasLocation>(
    () => stack[stack.length - 1] ?? { kind: 'overview' },
    [stack],
  );
  const overviewId = overviewQuery.data?.id ?? null;
  const currentId = useMemo<CanvasId | null>(() => {
    if (location.kind === 'overview') return overviewId;
    return location.id;
  }, [location, overviewId]);

  const refreshLists = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['canvases', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['canvas', 'overview'] });
  }, [queryClient]);

  const rememberVisit = useCallback(
    (id: CanvasId): void => {
      // 在 patch 前重读磁盘：快速连续切换时，基于过期缓存合并会把刚记录的项抹掉
      void (async () => {
        try {
          const fresh = await kernel.settings.read();
          const current = fresh.ui.recentCanvasIds ?? [];
          const next = [String(id), ...current.filter((item) => item !== String(id))].slice(0, RECENT_LIMIT);
          if (next.join('|') === current.join('|')) return;
          await kernel.settings.patch({ ui: { recentCanvasIds: next } });
        } catch {
          // 只读库等场景静默忽略：最近访问是纯便利数据
        }
      })();
    },
    [kernel],
  );

  const showOverview = useCallback((): void => {
    setStack((current) => {
      // 面包屑栈不堆叠重复位置：栈顶已是总览时 no-op
      const top = current[current.length - 1];
      if (top !== undefined && top.kind === 'overview') return current;
      return [...current, { kind: 'overview' as const }];
    });
  }, []);

  const openCanvas = useCallback(
    (id: CanvasId): void => {
      setStack((current) => {
        const top = current[current.length - 1];
        if (top !== undefined && top.kind === 'canvas' && String(top.id) === String(id)) {
          return current;
        }
        return [...current, { kind: 'canvas', id }];
      });
      rememberVisit(id);
    },
    [rememberVisit],
  );

  const enterPortal = openCanvas;

  const back = useCallback((): boolean => {
    let popped = false;
    setStack((current) => {
      if (current.length <= 1) return current;
      popped = true;
      return current.slice(0, -1);
    });
    return popped;
  }, []);

  const jumpTo = useCallback((index: number): void => {
    setStack((current) => current.slice(0, Math.max(1, index + 1)));
  }, []);

  const createCanvas = useCallback(
    async (title: string): Promise<CanvasId | null> => {
      try {
        const created = await kernel.canvas.create({ title });
        refreshLists();
        return created.id;
      } catch (error) {
        kernel.log.error('新建画布失败', { error: toErrorText(error) });
        return null;
      }
    },
    [kernel, refreshLists],
  );

  const renameCanvas = useCallback(
    async (id: CanvasId, title: string): Promise<void> => {
      try {
        await kernel.canvas.rename(id, title);
        refreshLists();
      } catch (error) {
        kernel.log.error('重命名画布失败', { error: toErrorText(error) });
        throw error;
      }
    },
    [kernel, refreshLists],
  );

  const duplicateCanvas = useCallback(
    async (id: CanvasId): Promise<void> => {
      try {
        await kernel.canvas.duplicate(id);
        refreshLists();
      } catch (error) {
        kernel.log.error('复制画布失败', { error: toErrorText(error) });
        throw error;
      }
    },
    [kernel, refreshLists],
  );

  const removeCanvas = useCallback(
    async (id: CanvasId): Promise<void> => {
      try {
        await kernel.canvas.remove(id);
        refreshLists();
        setStack((current) => {
          const kept = current.filter(
            (item) => !(item.kind === 'canvas' && String(item.id) === String(id)),
          );
          return kept.length > 0 ? kept : [{ kind: 'overview' as const }];
        });
      } catch (error) {
        kernel.log.error('删除画布失败', { error: toErrorText(error) });
        throw error;
      }
    },
    [kernel, refreshLists],
  );

  const pinHome = useCallback(
    async (id: CanvasId | null): Promise<void> => {
      try {
        await kernel.settings.patch({ ui: { defaultCanvasId: id === null ? null : String(id) } });
        void queryClient.invalidateQueries({ queryKey: ['settings'] });
      } catch (error) {
        kernel.log.error('固定主页失败', { error: toErrorText(error) });
        throw error;
      }
    },
    [kernel, queryClient],
  );

  const error =
    canvasesQuery.isError === true
      ? toErrorText(canvasesQuery.error)
      : overviewQuery.isError === true
        ? toErrorText(overviewQuery.error)
        : null;

  const canvasIndex = useMemo(
    () =>
      new Map(
        (canvasesQuery.data ?? []).map((canvas) => [
          String(canvas.id),
          { title: canvas.title, nodeCount: canvas.nodeCount },
        ]),
      ),
    [canvasesQuery.data],
  );

  return {
    canvases: canvasesQuery.data ?? [],
    loading: canvasesQuery.isPending || overviewQuery.isPending,
    error,
    stack,
    location,
    currentId,
    overviewId,
    homeCanvasId: settingsQuery.data?.ui.defaultCanvasId ?? null,
    recentCanvasIds: settingsQuery.data?.ui.recentCanvasIds ?? [],
    canvasIndex,
    showOverview,
    openCanvas,
    enterPortal,
    back,
    jumpTo,
    createCanvas,
    renameCanvas,
    duplicateCanvas,
    removeCanvas,
    pinHome,
  };
};
