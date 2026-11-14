import { unsafeVaultPath, type VaultPath } from '#doc-model';
import { EmberError } from './errors.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';

/**
 * 文件夹服务（kernel-contract §3.1）。
 *
 * 目录的唯一真相是磁盘：这里不维护任何 `folders.json` 之类的索引，
 * 每次列举都直接问端口。空文件夹因此天然可见，也不存在索引与磁盘漂移。
 */
export interface FolderService {
  /** 全库目录清单（含空目录，相对路径，字典序） */
  list(): Promise<readonly VaultPath[]>;
  /** 在 `parent` 下新建单层文件夹（`parent` 为空串表示库根）；返回归一化路径 */
  create(parent: string, name: string): Promise<VaultPath>;
  /** 删除空文件夹：只进系统回收站；系统回收站不可用即失败 */
  remove(path: VaultPath): Promise<void>;
}

export interface FolderServiceOptions {
  readonly port: VaultPort;
  readonly paths: PathTools;
}

/** 保留目录名：内核自管或索引不覆盖，不作为用户文件夹名。 */
const RESERVED_NAMES: readonly string[] = ['media'];

/** 控制字符（含 `\0`）在文件名里既不可见也难排查，统一拒绝。 */
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * 文件夹名校验：UI 输入即时校验、服务层、后端各跑一遍同一套规则。
 * 合法返回名称本身；非法抛 `invalid_payload`，message 直接面向用户。
 */
export const validateFolderName = (name: string): string => {
  if (name.trim().length === 0) {
    throw new EmberError('invalid_payload', '文件夹名称不能为空');
  }
  if (name !== name.trim()) {
    throw new EmberError('invalid_payload', '文件夹名称首尾不能有空白');
  }
  if (name === '.' || name === '..') {
    throw new EmberError('invalid_payload', '文件夹名称不能是 . 或 ..');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new EmberError('invalid_payload', '文件夹名称不能包含斜杠');
  }
  if (hasControlCharacter(name)) {
    throw new EmberError('invalid_payload', '文件夹名称包含非法字符');
  }
  if (name.startsWith('.')) {
    throw new EmberError('invalid_payload', '文件夹名称不能以点开头（隐藏目录）');
  }
  if (RESERVED_NAMES.some((reserved) => reserved === name.toLowerCase())) {
    throw new EmberError('invalid_payload', `${name} 是库保留目录，不能用作文件夹名`);
  }
  return name;
};

const assertWritable = (port: VaultPort): void => {
  if (port.readonlyMode) {
    throw new EmberError('vault_locked', '库处于只读模式，无法修改文件夹');
  }
};

export const createFolderService = (options: FolderServiceOptions): FolderService => {
  const { port, paths } = options;

  return {
    list: () => port.listDirs(),

    create: async (parent, name) => {
      assertWritable(port);
      const folderName = validateFolderName(name);
      const parentPath = parent === '' ? '' : String(paths.normalize(parent));
      const candidate = parentPath === '' ? folderName : `${parentPath}/${folderName}`;

      const dirs = await port.listDirs();
      if (parentPath !== '' && !dirs.some((dir) => String(dir) === parentPath)) {
        throw new EmberError('doc_not_found', `上级文件夹不存在：${parentPath}`);
      }
      if (dirs.some((dir) => String(dir) === candidate)) {
        throw new EmberError('path_exists', `同名文件夹已存在：${candidate}`);
      }
      const target = unsafeVaultPath(candidate);
      // 端口 stat 对目录也会返回元信息，所以先查目录清单，再判同名文件。
      if ((await port.stat(target)) !== null) {
        throw new EmberError('path_exists', `已有同名文件：${candidate}`);
      }
      await port.createDir(target);
      return target;
    },

    remove: async (path) => {
      assertWritable(port);
      const target = String(paths.normalize(String(path)));
      const dirs = await port.listDirs();
      if (!dirs.some((dir) => String(dir) === target)) {
        throw new EmberError('doc_not_found', `文件夹不存在：${target}`);
      }
      await port.trashDir(unsafeVaultPath(target));
    },
  };
};
