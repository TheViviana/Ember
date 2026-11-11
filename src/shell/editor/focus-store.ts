import { create } from 'zustand';
import type { DocId } from '#doc-model';

/**
 * 专注模式：应用级会话态，只存在于内存，不写 ui.json。
 * 进入时只记录目标浮窗 id；浮窗的尺寸与位置记忆从未被改写，
 * 因此退出时不需要「恢复」动作，原几何天然还在。
 */
export interface FocusStore {
  readonly active: boolean;
  readonly docId: DocId | null;
  readonly enter: (docId: DocId) => void;
  readonly exit: () => void;
}

export const useFocusStore = create<FocusStore>((set) => ({
  active: false,
  docId: null,
  enter: (docId) => {
    set({ active: true, docId });
  },
  exit: () => {
    set({ active: false, docId: null });
  },
}));
