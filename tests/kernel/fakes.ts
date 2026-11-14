import { unsafeVaultPath } from '#doc-model';
import type { KernelContext } from '../../src/kernel/context.ts';
import type { VaultFileChange, VaultFileEvent, VaultPort } from '../../src/kernel/ports.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export interface MemoryVault {
  readonly port: VaultPort;
  /** 端口 read 调用记录（按调用顺序），用于断言「没有读取」 */
  readonly reads: readonly string[];
  /** 端口 list 调用次数，用于断言全量对账只跑一次 */
  readonly listCalls: number;
  dump(): Readonly<Record<string, string>>;
  /** 模拟外部工具直接改文件（不经端口写） */
  writeRaw(path: string, text: string): void;
  /** 模拟外部工具直接删除/移走文件（不经端口写） */
  removeRaw(path: string): void;
  emitExternal(path: string, kind: VaultFileChange['kind'], from?: string): void;
  /** 模拟 watcher 单 tick 事件溢出 */
  emitOverflow(count: number): void;
}

export interface MemoryVaultOptions {
  readonly readonlyMode?: boolean;
  readonly files?: Readonly<Record<string, string>>;
  /** 原始字节文件（非 UTF-8 等无法用字符串表达的场景） */
  readonly rawFiles?: Readonly<Record<string, Uint8Array>>;
  /** 模拟符号链接：只出现在 scan 清单中，不对应可读文件 */
  readonly symlinks?: readonly string[];
  /** 覆盖 stat/scan 的大小（模拟超大文件而不分配真实字节） */
  readonly sizes?: Readonly<Record<string, number>>;
  /** 预置空目录（含多级），模拟磁盘上没有任何文档的文件夹 */
  readonly dirs?: readonly string[];
}

/** 与 Rust vault 行为对齐的内存端口：写即落「盘」，可注入外部变更事件 */
export const createMemoryVault = (options: MemoryVaultOptions = {}): MemoryVault => {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, string>();
  const symlinks = new Set(options.symlinks ?? []);
  const dirs = new Set<string>(options.dirs ?? []);
  const sizeOverrides = new Map(Object.entries(options.sizes ?? {}));
  const reads: string[] = [];
  const listeners = new Set<(event: VaultFileEvent) => void>();
  let listCalls = 0;
  let runtimeReadonly: string | null = null;
  let clock = 0;

  const tick = (): string => {
    clock += 1;
    return new Date(1_700_000_000_000 + clock).toISOString();
  };

  /** 路径的各级父目录（`a/b/c.md` → `a`、`a/b`），与磁盘语义一致：写文件即隐式建目录 */
  const parentsOf = (path: string): readonly string[] => {
    const segments = path.split('/');
    segments.pop();
    const out: string[] = [];
    let cursor = '';
    for (const segment of segments) {
      if (segment.length === 0) continue;
      cursor = cursor.length === 0 ? segment : `${cursor}/${segment}`;
      out.push(cursor);
    }
    return out;
  };
  const parentOf = (path: string): string => {
    const segments = path.split('/');
    segments.pop();
    return segments.join('/');
  };
  const rememberParents = (path: string): void => {
    for (const dir of parentsOf(path)) dirs.add(dir);
  };

  for (const [path, text] of Object.entries(options.files ?? {})) {
    files.set(path, encoder.encode(text));
    mtimes.set(path, tick());
    rememberParents(path);
  }
  for (const [path, bytes] of Object.entries(options.rawFiles ?? {})) {
    files.set(path, bytes);
    mtimes.set(path, tick());
    rememberParents(path);
  }

  const assertWritable = (): void => {
    if (options.readonlyMode === true || runtimeReadonly !== null) throw new Error('readonly port');
  };

  const port: VaultPort = {
    get readonlyMode() {
      return options.readonlyMode === true || runtimeReadonly !== null;
    },
    get readonlyReason() {
      return runtimeReadonly ?? (options.readonlyMode === true ? 'lockedByOther' : null);
    },
    setRuntimeReadonly(reason: string | null) {
      runtimeReadonly = reason;
    },
    read: (path) => {
      reads.push(String(path));
      return Promise.resolve(files.get(String(path)) ?? null);
    },
    write: (path, bytes) => {
      assertWritable();
      files.set(String(path), bytes);
      mtimes.set(String(path), tick());
      sizeOverrides.delete(String(path));
      rememberParents(String(path));
      return Promise.resolve();
    },
    remove: (path) => {
      assertWritable();
      files.delete(String(path));
      mtimes.delete(String(path));
      sizeOverrides.delete(String(path));
      return Promise.resolve('system' as const);
    },
    purge: (path) => {
      assertWritable();
      files.delete(String(path));
      mtimes.delete(String(path));
      sizeOverrides.delete(String(path));
      return Promise.resolve();
    },
    rename: (from, to) => {
      assertWritable();
      const bytes = files.get(String(from));
      if (bytes === undefined) return Promise.reject(new Error(`missing ${String(from)}`));
      files.delete(String(from));
      files.set(String(to), bytes);
      mtimes.set(String(to), tick());
      sizeOverrides.delete(String(from));
      rememberParents(String(to));
      return Promise.resolve();
    },

    createDir: (path) => {
      assertWritable();
      const target = String(path);
      const parent = parentOf(target);
      if (parent !== '' && !dirs.has(parent)) {
        return Promise.reject(new Error(`missing parent of ${target}`));
      }
      if (dirs.has(target) || files.has(target)) {
        return Promise.reject(new Error(`path exists: ${target}`));
      }
      dirs.add(target);
      return Promise.resolve();
    },

    trashDir: (path) => {
      assertWritable();
      const target = String(path);
      if (!dirs.has(target)) return Promise.reject(new Error(`missing dir ${target}`));
      // 与后端一致：整个目录连同内容一次性移走（桩里就是整段删除）。
      const prefix = `${target}/`;
      for (const file of [...files.keys()]) {
        if (file.startsWith(prefix)) {
          files.delete(file);
          mtimes.delete(file);
          sizeOverrides.delete(file);
        }
      }
      for (const dir of [...dirs]) {
        if (dir === target || dir.startsWith(prefix)) dirs.delete(dir);
      }
      return Promise.resolve();
    },

    listDirs: () => Promise.resolve([...dirs].sort().map((dir) => unsafeVaultPath(dir))),
    list: () => {
      listCalls += 1;
      return Promise.resolve([...files.keys()].map((path) => unsafeVaultPath(path)));
    },
    scan: () =>
      Promise.resolve(
        [
          ...[...files.entries()].map(([path, bytes]) => ({
            path: unsafeVaultPath(path),
            kind: 'file' as const,
            size: sizeOverrides.get(path) ?? bytes.byteLength,
          })),
          ...[...symlinks].map((path) => ({
            path: unsafeVaultPath(path),
            kind: 'symlink' as const,
            size: 0,
          })),
        ].sort((left, right) => String(left.path).localeCompare(String(right.path))),
      ),
    listCanvases: () =>
      Promise.resolve(
        [...files.keys()]
          .filter((path) => path.startsWith('.workbench/canvas/') && path.endsWith('.json'))
          .map((path) => unsafeVaultPath(path)),
      ),
    stat: (path) => {
      const mtime = mtimes.get(String(path));
      const bytes = files.get(String(path));
      if (mtime === undefined || bytes === undefined) return Promise.resolve(null);
      return Promise.resolve({
        mtime,
        size: sizeOverrides.get(String(path)) ?? bytes.byteLength,
      });
    },
    watch: (listener) => {
      listeners.add(listener);
      return {
        dispose: (): void => {
          listeners.delete(listener);
        },
      };
    },
  };

  return {
    port,
    get reads() {
      return [...reads];
    },
    get listCalls() {
      return listCalls;
    },
    dump: () => {
      const out: Record<string, string> = {};
      for (const [path, bytes] of files) out[path] = decoder.decode(bytes);
      return out;
    },
    emitExternal: (path, kind, from) => {
      const bytes = files.get(path);
      const mtime = mtimes.get(path);
      const event: VaultFileChange = {
        kind,
        path: unsafeVaultPath(path),
        ...(from === undefined ? {} : { from: unsafeVaultPath(from) }),
        ...(mtime === undefined ? {} : { mtimeMs: Date.parse(mtime) }),
        ...(bytes === undefined ? {} : { size: bytes.byteLength }),
      };
      for (const listener of [...listeners]) listener(event);
    },
    emitOverflow: (count) => {
      for (const listener of [...listeners]) listener({ kind: 'overflow', count });
    },
    writeRaw: (path, text) => {
      files.set(path, encoder.encode(text));
      mtimes.set(path, tick());
      sizeOverrides.delete(path);
    },
    removeRaw: (path) => {
      files.delete(path);
      mtimes.delete(path);
      sizeOverrides.delete(path);
    },
  };
};

/** 极简内核上下文替身：只用于不涉及具体服务的契约测试 */
export const stubContext = (commands: KernelContext['commands']): KernelContext =>
  ({ commands }) as unknown as KernelContext;
