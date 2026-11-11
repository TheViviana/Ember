import { create } from 'zustand';
import type { CursorPosition } from './cursor.ts';

interface CursorState {
  readonly cursor: CursorPosition | null;
}

/**
 * 高频、不落盘的光标状态：只让状态栏订阅。
 * 放在 App 里会让整棵树随每次输入重渲染，放在这里则画布与侧栏都不受影响。
 */
export const useCursorStore = create<CursorState>(() => ({ cursor: null }));

/** 模块级写入函数：引用稳定，可直接作为回调传递而不触发订阅组件重渲染 */
export const setCursor = (cursor: CursorPosition | null): void => {
  useCursorStore.setState({ cursor });
};
