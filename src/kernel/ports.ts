import type { VaultPath } from '#doc-model';
import type { Disposable, WriteIntent } from './types.ts';

/** 用户删除的实际落点：系统回收站，或降级后的库内回收目录（vault-format §8.3） */
export type TrashDestination = 'system' | 'internal';

/** 单个文件的变更事件（watcher 已按 mtime + size 判定确实变了） */
export interface VaultFileChange {
  readonly kind: 'created' | 'changed' | 'removed' | 'renamed';
  readonly path: VaultPath;
  /** 仅 kind === 'renamed' 携带：重命名前的原路径 */
  readonly from?: VaultPath;
  /** 事件发生时的 mtime（Unix 毫秒）：与目录里缓存的元数据一致时前端可跳过读盘 */
  readonly mtimeMs?: number;
  /** 事件发生时的字节数 */
  readonly size?: number;
}

/**
 * 单 tick 事件数超过阈值时，watcher 只发这一条替代成百上千条逐文件事件；
 * 前端收到后做一次全量对账。
 */
export interface VaultOverflowEvent {
  readonly kind: 'overflow';
  /** 本 tick 被合并掉的事件数 */
  readonly count: number;
}

export type VaultFileEvent = VaultFileChange | VaultOverflowEvent;

/** 库健康检查清单条目；只读遍历结果，不跟随符号链接 */
export interface VaultScanEntry {
  readonly path: VaultPath;
  readonly kind: 'file' | 'symlink';
  /** 普通文件为字节数；符号链接为链接自身长度 */
  readonly size: number;
}

/**
 * 文件系统端口（启动时由 data 层注入）。
 * 内核只经此端口读写文件；库锁、watcher 的实现在 Rust 侧。
 */
export interface VaultPort {
  readonly readonlyMode: boolean;
  /** 只读原因（启动时由 Rust 判定，运行期固定 lockLost）；可写时为 null */
  readonly readonlyReason: string | null;
  /** 不存在返回 null */
  read(path: VaultPath): Promise<Uint8Array | null>;
  write(path: VaultPath, bytes: Uint8Array, intent: WriteIntent): Promise<void>;
  /** 用户删除：优先系统回收站，不可用降级库内回收目录；返回实际落点，文件不存在为 null */
  remove(path: VaultPath): Promise<TrashDestination | null>;
  /** 永久删除：仅供内核回滚内部使用，不是用户删除入口 */
  purge(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  /** 全库 Markdown 清单（相对路径），用于文档目录对账 */
  list(): Promise<readonly VaultPath[]>;
  /**
   * 库健康检查清单：包含 `.md` / `.markdown` / `.workbench` 画布与历史 JSON / 符号链接。
   * 只读，不跟随符号链接。
   */
  scan(): Promise<readonly VaultScanEntry[]>;
  /** 画布清单（`.workbench/canvas/<id>.json`），画布库扫描用 */
  listCanvases(): Promise<readonly VaultPath[]>;
  /** 文件元信息；不存在返回 null */
  stat(path: VaultPath): Promise<{ readonly mtime: string; readonly size: number } | null>;
  watch(listener: (event: VaultFileEvent) => void): Disposable;
  /**
   * 运行期只读切换（库守护熔断用）：传 null 解除。
   * 实现方必须让 readonlyMode / readonlyReason 联动；不实现的端口（如纯内存桩）
   * 只会失去跨服务的只读扩散，内核自身仍会拒绝写入。
   */
  setRuntimeReadonly?(reason: string | null): void;
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
