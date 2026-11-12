/** 内核错误模型（kernel-contract §10）。`code` 是稳定契约，`message` 可改。 */
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
  | 'index_unavailable'
  | 'command_not_found'
  | 'command_reentrant'
  | 'duplicate_command'
  | 'invalid_command_id'
  | 'duplicate_capability'
  | 'capability_failed'
  | 'duplicate_slot'
  | 'duplicate_extension'
  | 'canvas_invalid'
  | 'io_failed';

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

/** 保留原始错误对象与栈，供诊断使用 */
export const toEmberError = (value: unknown, fallback: EmberErrorCode = 'io_failed'): EmberError => {
  if (isEmberError(value)) return value;
  if (value instanceof Error) {
    return new EmberError(fallback, value.message, { cause: value.name });
  }
  return new EmberError(fallback, String(value));
};
