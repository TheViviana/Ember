import type { Brand } from './brand.ts';

/**
 * 品牌类型与免校验构造器集中在此，刻意不依赖任何其它模块：
 * `path.ts` 与 `ids.ts` 都需要这些值，放在任一侧都会形成循环依赖。
 */

/** 文档身份：规范化后的库内相对路径（POSIX、以 `.md` 结尾） */
export type DocId = Brand<string, 'DocId'>;
/** 库身份：ULID，写入 .workbench/settings.json */
export type VaultId = Brand<string, 'VaultId'>;
/** 画布身份：ULID */
export type CanvasId = Brand<string, 'CanvasId'>;
/** 命令身份：必须 <namespace>.<verb> 形式 */
export type CommandId = Brand<string, 'CommandId'>;
/** vault 相对 POSIX 路径 */
export type VaultPath = Brand<string, 'VaultPath'>;
/** 内容摘要：sha256:<64 hex> */
export type ContentHash = Brand<string, 'ContentHash'>;

/** 供内核构造品牌值使用；不做校验，调用方必须已经校验过 */
export const unsafeDocId = (value: string): DocId => value as DocId;
export const unsafeVaultPath = (value: string): VaultPath => value as VaultPath;
export const unsafeContentHash = (value: string): ContentHash => value as ContentHash;
