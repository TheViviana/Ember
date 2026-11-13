import { create } from 'zustand';
import type { DocId } from '#doc-model';

/** 文章浮窗上限的默认值（可在设置里调整，settings.ui.floatLimit） */
export const DEFAULT_FLOAT_LIMIT = 5;
/** 浮窗上限的合法区间（与 settings-service 的归一化一致） */
export const FLOAT_LIMIT_MIN = 1;
export const FLOAT_LIMIT_MAX = 12;

/** 单扇浮窗：只放窗口元数据，正文/光标/保存状态一律留在 FloatEditor 内部 */
export interface FloatWindow {
  readonly docId: DocId;
  /** 打开意图：title 表示希望聚焦标题（仅首次挂载与后续 props 消费） */
  readonly focus: 'title' | null;
  /** 同一篇再次打开时递增，用于把焦点还给正文 */
  readonly nonce: number;
  /** 单调递增的激活序号，越大越靠前；同时用于 LRU */
  readonly lastActiveAt: number;
}

/** 满额拒绝时的提示：谁没打开、可以挤掉谁（由用户显式确认，绝不自动挤） */
export interface FloatLimitNotice {
  readonly requestedDocId: DocId;
  readonly requestedFocus: 'title' | null;
  /** 满额时最久未激活的窗口；null 表示没有可挤掉的窗口 */
  readonly evictedDocId: DocId | null;
}

export interface FloatStoreData {
  readonly windows: readonly FloatWindow[];
  readonly activeId: DocId | null;
  /** 单调计数，代替 Date.now()，让激活顺序可预测、可测试 */
  readonly tick: number;
  /** 当前上限：来自设置，满额时拒绝新开并出提示条 */
  readonly limit: number;
  /** 满额拒绝提示；打开成功或用户关闭提示后为 null */
  readonly notice: FloatLimitNotice | null;
}

export type FloatOpenResult = 'opened' | 'focused' | 'limit';

export interface FloatStore extends FloatStoreData {
  readonly open: (docId: DocId, focus: 'title' | null) => FloatOpenResult;
  readonly close: (docId: DocId) => void;
  readonly activate: (docId: DocId) => void;
  readonly setLimit: (limit: number) => void;
  /** 用户在提示条上显式点击「关闭最久未看的一篇并打开」时调用 */
  readonly evictLeastRecentAndOpen: (docId: DocId, focus: 'title' | null) => FloatOpenResult;
  readonly dismissNotice: () => void;
}

export const initialFloatData: FloatStoreData = {
  windows: [],
  activeId: null,
  tick: 0,
  limit: DEFAULT_FLOAT_LIMIT,
  notice: null,
};

export const clampFloatLimit = (value: number): number =>
  Math.min(FLOAT_LIMIT_MAX, Math.max(FLOAT_LIMIT_MIN, Math.trunc(value)));

const sameDoc = (left: DocId, right: DocId): boolean => String(left) === String(right);

export const findWindow = (
  windows: readonly FloatWindow[],
  docId: DocId,
): FloatWindow | null => windows.find((window) => sameDoc(window.docId, docId)) ?? null;

/** 最久未激活的窗口；并列时 docId 字典序靠前者优先，保证结果确定 */
export const leastRecentWindow = (windows: readonly FloatWindow[]): FloatWindow | null =>
  windows.reduce<FloatWindow | null>((oldest, window) => {
    if (oldest === null) return window;
    if (window.lastActiveAt !== oldest.lastActiveAt) {
      return window.lastActiveAt < oldest.lastActiveAt ? window : oldest;
    }
    return String(window.docId) < String(oldest.docId) ? window : oldest;
  }, null);

const mostRecentWindow = (windows: readonly FloatWindow[]): FloatWindow | null =>
  windows.reduce<FloatWindow | null>((newest, window) => {
    if (newest === null) return window;
    if (window.lastActiveAt !== newest.lastActiveAt) {
      return window.lastActiveAt > newest.lastActiveAt ? window : newest;
    }
    return String(window.docId) > String(newest.docId) ? window : newest;
  }, null);

/** z 序派生：激活越晚 z 越大（1..n），不单独存 z，避免两处状态不同步 */
export const deriveStackOrder = (
  windows: readonly FloatWindow[],
): readonly { readonly docId: DocId; readonly z: number }[] =>
  [...windows]
    .sort(
      (left, right) =>
        left.lastActiveAt - right.lastActiveAt ||
        String(left.docId).localeCompare(String(right.docId)),
    )
    .map((window, index) => ({ docId: window.docId, z: index + 1 }));

/**
 * 打开 / 聚焦：已开只更新激活序号与 nonce；
 * 满额拒绝并记录提示（用户可显式挤掉或关闭提示），绝不静默关掉已开浮窗。
 */
export const openFloatWindow = (
  state: FloatStoreData,
  docId: DocId,
  focus: 'title' | null,
): { readonly state: FloatStoreData; readonly result: FloatOpenResult } => {
  const existing = findWindow(state.windows, docId);
  if (existing !== null) {
    const tick = state.tick + 1;
    return {
      result: 'focused',
      state: {
        windows: state.windows.map((window) =>
          sameDoc(window.docId, docId)
            ? { ...window, focus, nonce: window.nonce + 1, lastActiveAt: tick }
            : window,
        ),
        activeId: docId,
        tick,
        limit: state.limit,
        notice: null,
      },
    };
  }

  if (state.windows.length >= state.limit) {
    const oldest = leastRecentWindow(state.windows);
    return {
      result: 'limit',
      state: {
        ...state,
        notice: {
          requestedDocId: docId,
          requestedFocus: focus,
          evictedDocId: oldest === null ? null : oldest.docId,
        },
      },
    };
  }

  const tick = state.tick + 1;
  return {
    result: 'opened',
    state: {
      windows: [...state.windows, { docId, focus, nonce: 1, lastActiveAt: tick }],
      activeId: docId,
      tick,
      limit: state.limit,
      notice: null,
    },
  };
};

/** 用户显式确认挤掉：只关最久未激活的一扇并打开请求的那篇 */
export const evictLeastRecentAndOpen = (
  state: FloatStoreData,
  docId: DocId,
  focus: 'title' | null,
): { readonly state: FloatStoreData; readonly result: FloatOpenResult } => {
  const oldest = leastRecentWindow(state.windows);
  if (oldest === null) return openFloatWindow(state, docId, focus);
  const withoutOldest = closeFloatWindow(state, oldest.docId);
  const next = openFloatWindow({ ...withoutOldest, notice: null }, docId, focus);
  return next;
};

export const closeFloatWindow = (state: FloatStoreData, docId: DocId): FloatStoreData => {
  const windows = state.windows.filter((window) => !sameDoc(window.docId, docId));
  if (windows.length === state.windows.length) return state;
  const activeId =
    state.activeId !== null && sameDoc(state.activeId, docId)
      ? (mostRecentWindow(windows)?.docId ?? null)
      : state.activeId;
  // 提示里任一相关窗口被关闭（请求的或待挤掉的）都让提示失效，避免指向已不存在的窗口
  const notice =
    state.notice !== null &&
    (sameDoc(state.notice.requestedDocId, docId) ||
      (state.notice.evictedDocId !== null && sameDoc(state.notice.evictedDocId, docId)))
      ? null
      : state.notice;
  return { ...state, windows, activeId, notice };
};

export const activateFloatWindow = (state: FloatStoreData, docId: DocId): FloatStoreData => {
  if (findWindow(state.windows, docId) === null) return state;
  if (state.activeId !== null && sameDoc(state.activeId, docId)) return state;
  const tick = state.tick + 1;
  return {
    ...state,
    tick,
    activeId: docId,
    windows: state.windows.map((window) =>
      sameDoc(window.docId, docId) ? { ...window, lastActiveAt: tick } : window,
    ),
  };
};

export const useFloatStore = create<FloatStore>((set, get) => ({
  ...initialFloatData,
  open: (docId, focus) => {
    const next = openFloatWindow(get(), docId, focus);
    set(next.state);
    return next.result;
  },
  close: (docId) => {
    set(closeFloatWindow(get(), docId));
  },
  activate: (docId) => {
    set(activateFloatWindow(get(), docId));
  },
  setLimit: (limit) => {
    const next = clampFloatLimit(limit);
    // 只改上限，不裁剪已开浮窗：静默关窗就是这次要修掉的行为。
    // 已开数超过新上限时，后续打开会被拒绝并出提示条，用户可自行关闭多余的浮窗。
    set({ limit: next });
  },
  evictLeastRecentAndOpen: (docId, focus) => {
    const next = evictLeastRecentAndOpen(get(), docId, focus);
    set(next.state);
    return next.result;
  },
  dismissNotice: () => {
    set((state) => (state.notice === null ? state : { ...state, notice: null }));
  },
}));
