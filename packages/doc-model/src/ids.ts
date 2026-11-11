import type { Brand } from './brand.ts';
import { isUlid } from './ulid.ts';

/** 文档身份：26 字符 ULID */
export type DocId = Brand<string, 'DocId'>;
/** 库身份：ULID，写入 .workbench/settings.json */
export type VaultId = Brand<string, 'VaultId'>;
/** 画布身份：ULID */
export type CanvasId = Brand<string, 'CanvasId'>;
/** 能力身份：反向域名或 slug，如 ember.core.slash */
export type CapabilityId = Brand<string, 'CapabilityId'>;
/** 命令身份：必须 <namespace>.<verb> 形式 */
export type CommandId = Brand<string, 'CommandId'>;
/** vault 相对 POSIX 路径 */
export type VaultPath = Brand<string, 'VaultPath'>;
/** 内容摘要：sha256:<64 hex> */
export type ContentHash = Brand<string, 'ContentHash'>;

const COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]*(?:[.-][a-z0-9][a-z0-9-]*)*$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const asDocId = (value: string): DocId | null => (isUlid(value) ? (value as DocId) : null);
export const asVaultId = (value: string): VaultId | null => (isUlid(value) ? (value as VaultId) : null);
export const asCanvasId = (value: string): CanvasId | null =>
  isUlid(value) ? (value as CanvasId) : null;
export const asCapabilityId = (value: string): CapabilityId | null =>
  CAPABILITY_PATTERN.test(value) ? (value as CapabilityId) : null;
export const asCommandId = (value: string): CommandId | null =>
  COMMAND_PATTERN.test(value) ? (value as CommandId) : null;
export const asContentHash = (value: string): ContentHash | null =>
  HASH_PATTERN.test(value) ? (value as ContentHash) : null;

export const isCommandId = (value: string): boolean => COMMAND_PATTERN.test(value);
export const isCapabilityId = (value: string): boolean => CAPABILITY_PATTERN.test(value);

/** 供内核构造品牌值使用；不做校验，调用方必须已经校验过 */
export const unsafeDocId = (value: string): DocId => value as DocId;
export const unsafeVaultPath = (value: string): VaultPath => value as VaultPath;
export const unsafeContentHash = (value: string): ContentHash => value as ContentHash;
