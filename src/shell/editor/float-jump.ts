import type { DocId } from '#doc-model';

/**
 * 浮窗跳转信号：⌘K 搜索结果「第 N 行」→ 浮窗打开/聚焦后滚动到该行并选中。
 * 编辑器尚未创建时（窗口刚打开）请求挂起，编辑器就绪后立即消费。
 */
const pending = new Map<string, number>();
const listeners = new Map<string, (line: number) => void>();

export const requestFloatJump = (docId: DocId | string, line: number): void => {
  const key = String(docId);
  pending.set(key, line);
  const listener = listeners.get(key);
  if (listener !== undefined) {
    listeners.delete(key);
    listener(line);
  }
};

/** 编辑器侧订阅：挂起请求立即消费，后续请求实时到达 */
export const subscribeFloatJump = (
  docId: DocId | string,
  fn: (line: number) => void,
): { dispose: () => void } => {
  const key = String(docId);
  listeners.set(key, fn);
  const queued = pending.get(key);
  if (queued !== undefined) {
    pending.delete(key);
    fn(queued);
  }
  return {
    dispose: (): void => {
      if (listeners.get(key) === fn) listeners.delete(key);
    },
  };
};
