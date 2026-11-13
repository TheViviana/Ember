import { create } from 'zustand';
import type { CanvasBookmark, CanvasFilters } from '#canvas-engine';

export const EMPTY_FILTERS: CanvasFilters = { tags: [], kinds: [], text: '', mode: 'dim' };

export const NODE_KINDS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'doc', label: '文章' },
  { id: 'note', label: '自由文本' },
  { id: 'group', label: '分组' },
  { id: 'portal', label: '画布' },
  { id: 'image', label: '图片' },
];

/**
 * 画布视图动作总线：顶栏左侧菜单需要触发画布内状态（过滤/书签/适应/历史），
 * 但两者不在同一棵组件树里。CanvasSurface 在挂载期间把动作注册进来，
 * 菜单只读消费；离开画布（actions = null）时菜单隐藏画布分区。
 */
export interface CanvasViewActions {
  readonly filters: CanvasFilters;
  readonly availableTags: readonly string[];
  readonly bookmarks: readonly CanvasBookmark[];
  readonly recentEditsOpen: boolean;
  readonly historyOpen: boolean;
  readonly setFilters: (filters: CanvasFilters) => void;
  readonly saveBookmark: (name: string) => void;
  readonly jumpBookmark: (bookmark: CanvasBookmark) => void;
  readonly deleteBookmark: (id: string) => void;
  readonly fitView: () => void;
  readonly resetView: () => void;
  readonly toggleRecentEdits: () => void;
  readonly toggleHistory: () => void;
}

interface CanvasViewState {
  readonly actions: CanvasViewActions | null;
  readonly setActions: (actions: CanvasViewActions | null) => void;
}

export const useCanvasViewStore = create<CanvasViewState>((set) => ({
  actions: null,
  setActions: (actions) => {
    set({ actions });
  },
}));
