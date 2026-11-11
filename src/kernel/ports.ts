import type { DocId, VaultPath } from '#doc-model';
import type {
  Disposable,
  IndexEvent,
  IndexedDocument,
  IndexStats,
  LinkRecord,
  SearchResult,
  WriteIntent,
} from './types.ts';

export interface VaultFileEvent {
  readonly kind: 'created' | 'changed' | 'removed';
  readonly path: VaultPath;
}

/**
 * 文件系统端口（kernel-contract §11 第 5 步由 data 层注入）。
 * 内核只经此端口读写文件；journal、库锁、watcher 的实现在 Rust 侧。
 */
export interface VaultPort {
  readonly readonlyMode: boolean;
  /** 不存在返回 null */
  read(path: VaultPath): Promise<Uint8Array | null>;
  write(path: VaultPath, bytes: Uint8Array, intent: WriteIntent): Promise<void>;
  remove(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  /** 全库文件清单（相对路径），用于目录对账 */
  list(): Promise<readonly VaultPath[]>;
  /** 文件元信息；不存在返回 null */
  stat(path: VaultPath): Promise<{ readonly mtime: string; readonly size: number } | null>;
  watch(listener: (event: VaultFileEvent) => void): Disposable;
}

/** 索引端口：SQLite + FTS5 在 Rust 侧，内核只做编排与查询参数归一化 */
export interface IndexPort {
  readonly available: boolean;
  document(id: DocId): Promise<IndexedDocument | null>;
  search(input: {
    readonly text: string;
    readonly limit: number;
    readonly tags: readonly string[] | null;
    readonly pathPrefix: VaultPath | null;
  }): Promise<SearchResult>;
  outbound(id: DocId): Promise<readonly LinkRecord[]>;
  backlinks(id: DocId): Promise<readonly LinkRecord[]>;
  stats(): Promise<IndexStats>;
  rebuild(): Promise<IndexStats>;
  watch(listener: (event: IndexEvent) => void): Disposable;
}

/**
 * 机器本地 UI 状态端口（`~/Library/Application Support/Ember/machines/<machineId>/ui.json`）。
 * 内核不解释内容，只提供读写通道；具体字段由 data 层机器状态仓库维护。
 */
export interface MachineUiPort {
  /** 文件不存在返回 null */
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

/** AI 传输端口：提示词与模型选择在能力侧，内核只转发 */
export interface AiPort {
  complete(input: {
    readonly prompt: string;
    readonly system: string | null;
    readonly signal: AbortSignal | null;
  }): Promise<string>;
}
