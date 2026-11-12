/**
 * 浮窗关闭时的落盘等待队列。
 * 关闭是同步卸载，persist() 只能异步完成；同一篇文档被立刻重开时，
 * 新实例必须先等这一次写入落盘，再读取快照，否则会读到旧快照。
 */
const pending = new Map<string, Promise<void>>();

/**
 * 已挂载编辑器的「立即落盘」回调：窗口关闭不会卸载 React 树，
 * 必须在 Tauri 的关窗请求里主动调用，否则 600ms 防抖窗口内的最后一次输入会丢。
 */
const flushers = new Set<() => Promise<void>>();

export const registerFloatFlusher = (flush: () => Promise<void>): (() => void) => {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
};

/** 关窗/隐藏前调用：并行等待所有编辑器落盘，单个失败不影响其余 */
export const flushFloatEditors = async (): Promise<void> => {
  await Promise.allSettled([...flushers].map((flush) => flush()));
};

export const trackFloatWrite = (docId: string, write: Promise<unknown>): void => {
  const previous = pending.get(docId);
  const merged: Promise<void> =
    previous === undefined
      ? write.then(
          () => undefined,
          () => undefined,
        )
      : Promise.allSettled([previous, write]).then(() => undefined);
  pending.set(docId, merged);
  void merged.then(() => {
    if (pending.get(docId) === merged) pending.delete(docId);
  });
};

/** 等待该文档关闭前的写入落盘；没有挂起写入时立即返回 */
export const settleFloatWrite = async (docId: string): Promise<void> => {
  const current = pending.get(docId);
  if (current !== undefined) await current;
};
