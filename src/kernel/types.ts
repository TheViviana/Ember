import type {
  CanvasId,
  CapabilityId,
  CommandId,
  ContentHash,
  DocId,
  Frontmatter,
  VaultId,
  VaultPath,
} from '#doc-model';
import type { CanvasGrid, Viewport } from '#canvas-engine';

/** 所有可释放资源统一形态（I7） */
export interface Disposable {
  readonly dispose: () => void;
}

export interface DocRevision {
  /** 进程内单调递增，从 1 开始；跨重启以 hash 为准 */
  readonly rev: number;
  /** 文件字节的 sha256 */
  readonly hash: ContentHash;
}

export interface DocFlags {
  readonly needsAdoption: boolean;
  readonly idInvalid: boolean;
  readonly duplicateId: boolean;
}

export interface DocMeta {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly title: string;
  /** 永不缺失：frontmatter.summary，缺失时由正文首段派生（不回写磁盘，D8） */
  readonly summary: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly created: string;
  readonly updated: string;
  readonly rev: DocRevision;
  readonly flags: DocFlags;
}

export interface DocSnapshot {
  readonly meta: DocMeta;
  readonly frontmatter: Frontmatter;
  /** 完整文件文本（含 frontmatter 块） */
  readonly text: string;
}

export type WriteIntent = 'user' | 'capability' | 'migration' | 'system';

export interface WriteOptions {
  /** 必填：读取时拿到的修订，用于乐观并发校验与三方合并基线 */
  readonly base: DocRevision;
  readonly intent: WriteIntent;
}

export interface CreateDocInput {
  readonly path: VaultPath;
  /** 正文，不含 frontmatter 块 */
  readonly text: string;
  readonly title?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly aliases?: readonly string[];
  /** 仅导入/迁移允许指定；普通创建留空由内核生成 */
  readonly id?: DocId;
  readonly intent: WriteIntent;
}

export interface DocPatch {
  readonly frontmatter?: {
    /** null = 删除该键（标题回落到文件名，简介回落到正文首段派生） */
    readonly title?: string | null;
    readonly summary?: string | null;
    readonly tags?: readonly string[];
    readonly aliases?: readonly string[];
  };
  /** 完整正文（不含 frontmatter 块） */
  readonly body?: string;
}

export interface ConflictCopy {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly of: DocId;
}

export interface WriteOutcome {
  readonly snapshot: DocSnapshot;
  /** true = 快路径或自动合并成功；false = 冲突并已落盘副本 */
  readonly merged: boolean;
  readonly conflict: ConflictCopy | null;
}

export interface DocChange {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly kind: 'created' | 'updated' | 'renamed' | 'removed' | 'external';
  readonly revision: DocRevision;
}

export interface DocFilter {
  readonly tags?: readonly string[];
  readonly pathPrefix?: VaultPath;
  readonly limit?: number;
}

export interface SearchQuery {
  readonly text: string;
  readonly limit?: number;
  readonly tags?: readonly string[];
  readonly pathPrefix?: VaultPath;
}

export interface SearchHit {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface LinkRecord {
  readonly srcId: DocId;
  readonly targetId: DocId | null;
  readonly raw: string;
  readonly kind: 'link' | 'embed';
  readonly resolver: 'path' | 'basename' | 'title' | 'alias' | 'ambiguous' | 'unresolved';
  readonly anchor: string | null;
  readonly line: number;
}

export interface IndexedDocument {
  readonly meta: DocMeta;
  readonly links: readonly LinkRecord[];
  readonly excerpt: string;
}

export interface IndexStats {
  readonly documents: number;
  readonly links: number;
  readonly unresolved: number;
  readonly ambiguous: number;
  readonly lastBuiltAt: string;
  readonly tokenizerVersion: number;
}

export interface IndexEvent {
  readonly kind: 'updated' | 'rebuilt' | 'unavailable';
  readonly changedDocIds: readonly DocId[];
}

export interface CapabilityManifest {
  readonly id: CapabilityId;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  /** semver range；v1 只接受满足 1.x 的声明 */
  readonly requiresKernel: string;
  readonly dependsOn?: readonly CapabilityId[];
  readonly defaultEnabled: boolean;
}

export interface CapabilityState {
  readonly id: CapabilityId;
  /** manifest 里的中文显示名，供设置面板直接渲染 */
  readonly displayName: string;
  readonly description: string | null;
  /** settings.json 里的开关 */
  readonly enabled: boolean;
  /** 运行期是否已激活 */
  readonly active: boolean;
  readonly error: string | null;
}

/** 画布网格与 scene 共用同一形状，避免两处定义漂移 */
export type { CanvasGrid };

/** 库内可携带的设置（vault-format §8.1）；未知键保留 */
export interface VaultSettings {
  readonly schemaVersion: 1;
  readonly vault: { readonly id: VaultId; readonly name: string; readonly createdAt: string };
  readonly capabilities: Readonly<
    Record<string, { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> }>
  >;
  readonly ui: {
    readonly defaultView: 'canvas' | 'editor';
    readonly defaultCanvasId?: string;
    readonly sidebar: 'auto' | 'off';
    readonly canvasGrid: CanvasGrid;
    readonly theme: 'ember-black';
    readonly [key: string]: unknown;
  };
  readonly linkOverrides: Readonly<Record<string, DocId>>;
  readonly [key: string]: unknown;
}

export interface SettingsPatch {
  readonly ui?: Omit<Partial<VaultSettings['ui']>, 'canvasGrid'> & {
    readonly canvasGrid?: Partial<CanvasGrid>;
  };
  readonly capabilities?: Readonly<
    Record<string, { readonly enabled?: boolean; readonly config?: Readonly<Record<string, unknown>> }>
  >;
  readonly linkOverrides?: Readonly<Record<string, DocId>>;
}

/** `.workbench/settings.json` 的唯一读写方（kernel-contract §9.1） */
export interface SettingsService {
  read(): Promise<VaultSettings>;
  patch(patch: SettingsPatch): Promise<VaultSettings>;
  watch(listener: (next: VaultSettings) => void): Disposable;
  /**
   * 等待排队中的写入落盘；若自上次 flush 以来有写入失败，抛出一次后清空。
   * 关窗阶段一必须调用它：只有会失败的 flush 才能拦住「磁盘是旧值」的关闭。
   */
  flush(): Promise<void>;
}

export interface KernelEnv {
  readonly kernelVersion: string;
  readonly vaultId: VaultId;
  /** 未拿到库锁时为 true（G2） */
  readonly readonlyMode: boolean;
  /** 只读原因；可写时为 null（由 Rust 的锁判定给出） */
  readonly readonlyReason: string | null;
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** 能力间共享可扩展槽；键冲突抛 duplicate_extension */
export interface ExtensionSlot<T> {
  readonly id: string;
  readonly __type?: T;
}

export interface CanvasSummary {
  readonly id: CanvasId;
  readonly title: string;
  readonly updatedAt: string;
}

export interface CreateCanvasInput {
  readonly title: string;
  readonly viewport?: Viewport;
}

export interface CommandDescriptor {
  readonly id: CommandId;
  readonly title: string;
  readonly scope: 'global' | 'editor' | 'canvas';
  readonly keybinding: { readonly key: string; readonly scope: 'global' | 'editor' | 'canvas' } | null;
  readonly owner: CapabilityId | null;
}
