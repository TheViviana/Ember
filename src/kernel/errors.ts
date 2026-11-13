/** 内核错误模型（kernel-contract §8）。`code` 是稳定契约，`message` 可改。 */
export type EmberErrorCode =
  | 'not_implemented'
  | 'doc_not_found'
  | 'path_exists'
  | 'path_outside_vault'
  | 'stale_revision'
  | 'invalid_frontmatter'
  | 'invalid_payload'
  | 'duplicate_id'
  | 'vault_locked'
  | 'vault_uninitialized'
  | 'index_unavailable'
  | 'command_not_found'
  | 'command_reentrant'
  | 'duplicate_command'
  | 'invalid_command_id'
  | 'duplicate_extension'
  | 'canvas_invalid'
  | 'io_failed'
  | 'permission_denied'
  | 'startup_failed';

export class EmberError extends Error {
  readonly code: EmberErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: EmberErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'EmberError';
    this.code = code;
    this.details = details;
  }
}

export const isEmberError = (value: unknown): value is EmberError => value instanceof EmberError;

/** 把任意抛出物压成可展示文本；EmberError 保留 code 前缀（K2） */
export const toErrorText = (value: unknown): string => {
  if (isEmberError(value)) return `${value.code}: ${value.message}`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  // Tauri IPC 拒绝值序列化为 { code, message }，直接 String() 会变成 [object Object]
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : null;
    const code = typeof record.code === 'string' ? record.code : null;
    if (message !== null) return code === null ? message : `${code}: ${message}`;
  }
  return String(value);
};

/** 取任意抛出物的稳定错误码；Tauri IPC 的拒绝值是 `{ code, message }` 而不是 EmberError */
export const errorCodeOf = (value: unknown): string | null => {
  if (isEmberError(value)) return value.code;
  if (typeof value === 'object' && value !== null) {
    const code = (value as Record<string, unknown>).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
};

/** 权限被拒（macOS TCC 未授权「文稿」等）不能被当成空文档展示 */
export const isPermissionDenied = (value: unknown): boolean => {
  if (errorCodeOf(value) === 'permission_denied') return true;
  // 兼容旧错误码/机器上尚未重编译的后端：至少按文案兜底识别
  return /Permission denied|Operation not permitted|EPERM|EACCES/i.test(toErrorText(value));
};
