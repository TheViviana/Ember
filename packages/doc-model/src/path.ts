import type { VaultPath } from './ids.ts';
import { unsafeVaultPath } from './ids.ts';
import { err, ok, type Result } from './result.ts';

export type PathError =
  | 'empty'
  | 'absolute'
  | 'parent-escape'
  | 'nul-byte'
  | 'trailing-separator'
  | 'windows-drive';

export interface PathParts {
  readonly dir: string;
  readonly name: string;
  readonly stem: string;
  readonly ext: string;
}

const CONFLICT_SUFFIX = / \(conflict [0-9]{8}T[0-9]{6}Z-[0-9A-Z]{4}(?:-[0-9]+)?\)$/;

/**
 * 归一化 vault 相对路径：
 * - 反斜杠转正斜杠，折叠重复分隔符
 * - 拒绝绝对路径、盘符、`..`、NUL、尾部斜杠
 */
export const normalizePath = (input: string): Result<VaultPath, PathError> => {
  if (input.includes('\0')) return err('nul-byte');
  const replaced = input.replaceAll('\\', '/');
  if (replaced.trim() === '') return err('empty');
  if (replaced.startsWith('/')) return err('absolute');
  if (/^[A-Za-z]:/.test(replaced)) return err('windows-drive');
  if (replaced.endsWith('/')) return err('trailing-separator');

  const segments = replaced.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return err('empty');
  if (segments.includes('..')) return err('parent-escape');
  return ok(unsafeVaultPath(segments.join('/')));
};

export const splitPath = (path: VaultPath): PathParts => {
  const value = String(path);
  const slash = value.lastIndexOf('/');
  const dir = slash >= 0 ? value.slice(0, slash) : '';
  const name = slash >= 0 ? value.slice(slash + 1) : value;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  return {
    dir,
    name,
    stem: hasExt ? name.slice(0, dot) : name,
    ext: hasExt ? name.slice(dot) : '',
  };
};

export const dirname = (path: VaultPath): string => splitPath(path).dir;
export const basename = (path: VaultPath): string => splitPath(path).name;
export const stem = (path: VaultPath): string => splitPath(path).stem.replace(CONFLICT_SUFFIX, '');
export const extension = (path: VaultPath): string => splitPath(path).ext;

export const joinPath = (base: VaultPath, ...segments: readonly string[]): Result<VaultPath, PathError> =>
  normalizePath([String(base), ...segments].join('/'));

/** 兼容 Obsidian 查找：大小写折叠 + NFC */
export const pathLookupKey = (path: string): string => path.normalize('NFC').toLowerCase();

const utcStamp = (at: Date): string =>
  at
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z');

/** 冲突副本命名：<stem> (conflict <YYYYMMDDTHHMMSSZ>-<XXXX>).md（见 vault-format §10.3） */
export const conflictCopyName = (original: VaultPath, at: Date, uid: string): VaultPath => {
  const parts = splitPath(original);
  const suffix = uid.replace(/[^0-9A-Za-z]/g, '').toUpperCase().padEnd(4, '0').slice(0, 4);
  const nextName = `${parts.stem.replace(CONFLICT_SUFFIX, '')} (conflict ${utcStamp(at)}-${suffix})${parts.ext || '.md'}`;
  return unsafeVaultPath(parts.dir === '' ? nextName : `${parts.dir}/${nextName}`);
};

/** 由路径推导标题：去扩展名、去冲突后缀 */
export const titleFromPath = (path: VaultPath): string => stem(path);
