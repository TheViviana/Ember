import type { CanvasId, CommandId, ContentHash, DocId, VaultId } from './brands.ts';
import { unsafeDocId } from './brands.ts';
import { normalizePath } from './path.ts';
import { isUlid } from './ulid.ts';

export type {
  CanvasId,
  CommandId,
  ContentHash,
  DocId,
  VaultId,
  VaultPath,
} from './brands.ts';
export { unsafeContentHash, unsafeDocId, unsafeVaultPath } from './brands.ts';

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * 文档路径约束（与 Rust `collect_documents` 对齐）：
 * - 归一化后必须仍以 `.md` 结尾（大小写敏感，与磁盘扫描一致）；
 * - 任何一段以 `.` 开头都跳过：隐藏文件/目录不进入文档目录；
 * - `.workbench` 与 `media` 是内核保留目录，不属于用户文档。
 */
const isDocumentPath = (path: string): boolean => {
  if (!path.endsWith('.md') || path.length <= 3) return false;
  if (path === 'media' || path.startsWith('media/')) return false;
  for (const segment of path.split('/')) {
    if (segment.startsWith('.')) return false;
  }
  return true;
};

/** 规范化后的库内相对路径 → 文档身份；非法路径返回 null */
export const asDocId = (value: string): DocId | null => {
  const normalized = normalizePath(value);
  if (!normalized.ok) return null;
  const path = String(normalized.value);
  return isDocumentPath(path) ? unsafeDocId(path) : null;
};
export const asVaultId = (value: string): VaultId | null => (isUlid(value) ? (value as VaultId) : null);
export const asCanvasId = (value: string): CanvasId | null =>
  isUlid(value) ? (value as CanvasId) : null;
export const asCommandId = (value: string): CommandId | null =>
  COMMAND_PATTERN.test(value) ? (value as CommandId) : null;
export const asContentHash = (value: string): ContentHash | null =>
  HASH_PATTERN.test(value) ? (value as ContentHash) : null;

export const isCommandId = (value: string): boolean => COMMAND_PATTERN.test(value);
