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
  readonly kind: 'created' | 'changed' | 'removed' | 'renamed';
  readonly path: VaultPath;
  /** 仅 kind === 'renamed' 携带：重命名前的原路径 */
  readonly from?: VaultPath;
}

/**
 * 文件系统端口（kernel-contract §11 第 5 步由 data 层注入）。
 * 内核只经此端口读写文件；journal、库锁、watcher 的实现在 Rust 侧。
 */
export interface VaultPort {
  readonly readonlyMode: boolean;
  /** 只读原因（启动时由 Rust 判定，运行期固定 lockLost）；可写时为 null */
  readonly readonlyReason: string | null;
  /** 不存在返回 null */
  read(path: VaultPath): Promise<Uint8Array | null>;
  write(path: VaultPath, bytes: Uint8Array, intent: WriteIntent): Promise<void>;
  /** 用户删除：移入操作系统回收站（非 macOS 明确失败，不回退为永久删除） */
  remove(path: VaultPath): Promise<void>;
  /** 永久删除：仅供内核回滚内部使用，不是用户删除入口 */
  purge(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  /** 全库文件清单（相对路径），用于目录对账 */
  list(): Promise<readonly VaultPath[]>;
  /** 文件元信息；不存在返回 null */
  stat(path: VaultPath): Promise<{ readonly mtime: string; readonly size: number } | null>;
  watch(listener: (event: VaultFileEvent) => void): Disposable;
  /** 运行期只读状态变化（库锁被接管/心跳失败）；不支持该能力的端口可省略 */
  watchMode?(listener: (state: { readonly readonly: boolean; readonly reason: string | null }) => void): Disposable;
}

/** 索引端口：SQLite + FTS5 计划由 Rust 侧实现；v1 仍是占位端口（见 data/tauri/index-port.ts） */
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

/** 窗口逻辑坐标与尺寸（无边框窗口自绘缩放用） */
export interface WindowFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 窗口能力端口：宿主窗口的原生操作由 data 层适配，外壳只经此接口调用。
 * 浏览器 dev 下 `native` 为 false，所有操作退化为 no-op。
 */
export interface WindowPort {
  readonly native: boolean;
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleZoom(): Promise<void>;
  /** 无法读取时返回 null */
  readFrame(): Promise<WindowFrame | null>;
  applyFrame(frame: WindowFrame): Promise<void>;
  /**
   * 关窗请求：回调完成后窗口才销毁。
   * 回调返回 false 表示拒绝本次关闭（已提示用户），由实现方 preventDefault。
   */
  onCloseRequested(handler: () => Promise<boolean>): Promise<() => void>;
}
