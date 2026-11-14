/**
 * IPC 拒绝时的统一文案：Tauri 命令的 `Err` 序列化成 `{ code, message }`，
 * 不是 Error，直接 String() 会得到 [object Object]。
 * 优先取 message，再退回 Error.message / String。
 */
export const describeIpcError = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as Readonly<Record<string, unknown>>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return cause instanceof Error ? cause.message : String(cause);
};
