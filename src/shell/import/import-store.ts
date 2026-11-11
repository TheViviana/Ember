import { create } from 'zustand';

export type ImportMode = 'files' | 'folder';

interface ImportUiState {
  /** null = 未打开；命令总线通过 request 打开对应模式 */
  readonly mode: ImportMode | null;
  readonly request: (mode: ImportMode) => void;
  readonly close: () => void;
}

/** 导入对话框的瞬时界面状态，不落盘、不进 localStorage */
export const useImportStore = create<ImportUiState>((set) => ({
  mode: null,
  request: (mode) => {
    set({ mode });
  },
  close: () => {
    set({ mode: null });
  },
}));
