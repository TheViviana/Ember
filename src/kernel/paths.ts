import {
  basename as baseName,
  conflictCopyName,
  dirname as dirName,
  extension,
  joinPath,
  normalizePath,
  stem as stemOf,
  type VaultPath,
} from '#doc-model';
import { EmberError } from './errors.ts';

/** 路径工具：`VaultPath` 的唯一合法出口（kernel-contract §9） */
export interface PathTools {
  normalize(input: string): VaultPath;
  join(base: VaultPath, ...segments: readonly string[]): VaultPath;
  dirname(path: VaultPath): VaultPath;
  basename(path: VaultPath): string;
  stem(path: VaultPath): string;
  ext(path: VaultPath): string;
  conflictName(path: VaultPath, at: Date, uid: string): VaultPath;
}

const asVaultPath = (value: string): VaultPath => {
  const result = normalizePath(value);
  if (!result.ok) {
    throw new EmberError('path_outside_vault', `非法 vault 路径：${value}`, { reason: result.error });
  }
  return result.value;
};

export const createPathTools = (): PathTools => ({
  normalize: asVaultPath,
  join: (base, ...segments) => {
    const result = joinPath(base, ...segments);
    if (!result.ok) {
      throw new EmberError('path_outside_vault', `非法 vault 路径：${String(base)}`, { reason: result.error });
    }
    return result.value;
  },
  dirname: (path) => asVaultPath(dirName(path)),
  basename: (path) => baseName(path),
  stem: (path) => stemOf(path),
  ext: (path) => extension(path),
  conflictName: (path, at, uid) => conflictCopyName(path, at, uid),
});
