import { unsafeVaultPath } from '#doc-model';
import type { KernelContext } from '../../src/kernel/context.ts';
import type { IndexPort, VaultFileEvent, VaultPort } from '../../src/kernel/ports.ts';
import type { IndexEvent, IndexStats, SearchResult } from '../../src/kernel/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export interface MemoryVault {
  readonly port: VaultPort;
  dump(): Readonly<Record<string, string>>;
  /** 模拟外部工具直接改文件（不经端口写） */
  writeRaw(path: string, text: string): void;
  emitExternal(path: string, kind: VaultFileEvent['kind']): void;
}

export interface MemoryVaultOptions {
  readonly readonlyMode?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

/** 与 Rust vault 行为对齐的内存端口：写即落「盘」，可注入外部变更事件 */
export const createMemoryVault = (options: MemoryVaultOptions = {}): MemoryVault => {
  const files = new Map<string, Uint8Array>();
  const mtimes = new Map<string, string>();
  const listeners = new Set<(event: VaultFileEvent) => void>();
  let clock = 0;

  const tick = (): string => {
    clock += 1;
    return new Date(1_700_000_000_000 + clock).toISOString();
  };

  for (const [path, text] of Object.entries(options.files ?? {})) {
    files.set(path, encoder.encode(text));
    mtimes.set(path, tick());
  }

  const assertWritable = (): void => {
    if (options.readonlyMode === true) throw new Error('readonly port');
  };

  const port: VaultPort = {
    readonlyMode: options.readonlyMode === true,
    read: (path) => Promise.resolve(files.get(String(path)) ?? null),
    write: (path, bytes) => {
      assertWritable();
      files.set(String(path), bytes);
      mtimes.set(String(path), tick());
      return Promise.resolve();
    },
    remove: (path) => {
      assertWritable();
      files.delete(String(path));
      mtimes.delete(String(path));
      return Promise.resolve();
    },
    rename: (from, to) => {
      assertWritable();
      const bytes = files.get(String(from));
      if (bytes === undefined) return Promise.reject(new Error(`missing ${String(from)}`));
      files.delete(String(from));
      files.set(String(to), bytes);
      mtimes.set(String(to), tick());
      return Promise.resolve();
    },
    list: () => Promise.resolve([...files.keys()].map((path) => unsafeVaultPath(path))),
    stat: (path) => {
      const mtime = mtimes.get(String(path));
      const bytes = files.get(String(path));
      if (mtime === undefined || bytes === undefined) return Promise.resolve(null);
      return Promise.resolve({ mtime, size: bytes.byteLength });
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
    dump: () => {
      const out: Record<string, string> = {};
      for (const [path, bytes] of files) out[path] = decoder.decode(bytes);
      return out;
    },
    emitExternal: (path, kind) => {
      const event: VaultFileEvent = { path: unsafeVaultPath(path), kind };
      for (const listener of [...listeners]) listener(event);
    },
    writeRaw: (path, text) => {
      files.set(path, encoder.encode(text));
      mtimes.set(path, tick());
    },
  };
};

export interface MemoryIndex {
  readonly port: IndexPort;
  emit(event: IndexEvent): void;
  rebuilds(): number;
}

export const createMemoryIndex = (options: { readonly available?: boolean } = {}): MemoryIndex => {
  const listeners = new Set<(event: IndexEvent) => void>();
  let rebuildCount = 0;
  const emptyStats: IndexStats = {
    documents: 0,
    links: 0,
    unresolved: 0,
    ambiguous: 0,
    lastBuiltAt: '1970-01-01T00:00:00Z',
    tokenizerVersion: 1,
  };
  const emptyResult: SearchResult = { hits: [], total: 0, truncated: false };

  const port: IndexPort = {
    available: options.available !== false,
    document: () => Promise.resolve(null),
    search: () => Promise.resolve(emptyResult),
    outbound: () => Promise.resolve([]),
    backlinks: () => Promise.resolve([]),
    stats: () => Promise.resolve(emptyStats),
    rebuild: () => {
      rebuildCount += 1;
      return Promise.resolve(emptyStats);
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
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    rebuilds: () => rebuildCount,
  };
};

/** 极简内核上下文替身：只用于不涉及具体服务的契约测试 */
export const stubContext = (commands: KernelContext['commands']): KernelContext =>
  ({ commands }) as unknown as KernelContext;
