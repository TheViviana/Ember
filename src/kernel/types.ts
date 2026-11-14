import type {
  CanvasId,
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
  /** 冲突副本指向的原文 id；普通文档为 null（vault-format §10.3） */
  readonly conflictOf: DocId | null;
}

export interface DocSnapshot {
  readonly meta: DocMeta;
  readonly frontmatter: Frontmatter;
  /** 完整文件文本（含 frontmatter 块） */
  readonly text: string;
}

export type WriteIntent = 'user' | 'migration' | 'system';

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

export interface AdoptConflictOptions {
  /** 用户在冲突中心看到的原文修订 */
  readonly base: DocRevision;
  /** 用户在冲突中心看到的副本修订 */
  readonly copyBase: DocRevision;
  readonly intent: WriteIntent;
}

export interface AdoptConflictResult {
  readonly snapshot: DocSnapshot;
  /** 第二步（删除副本）是否成功；false 表示原文已更新、副本仍在 */
  readonly copyRemoved: boolean;
}

/** 库健康检查问题类别（kernel-contract H1/H5） */
export type HealthIssueKind =
  | 'broken_frontmatter'
  | 'missing_id'
  | 'invalid_id'
  | 'duplicate_id'
  | 'non_utf8'
  | 'oversize'
  | 'markdown_extension'
  | 'broken_asset'
  | 'broken_canvas'
  | 'broken_history'
  | 'symlink';

export interface HealthIssue {
  readonly kind: HealthIssueKind;
  /** 问题文件；坏资产引用时为引用方文档 */
  readonly path: VaultPath;
  /** 补充定位：缺失的 `media/...`、历史版本文件等 */
  readonly target: VaultPath | null;
  readonly detail: string;
  /** 扫描时字节 sha256；未读取或不可修复时为 null */
  readonly hash: ContentHash | null;
  /** 可安全执行的修复；其余问题只报告 */
  readonly fix: 'adopt' | 'rename-markdown' | null;
}

export interface HealthReport {
  /** UTC `YYYY-MM-DDTHH:MM:SSZ` */
  readonly scannedAt: string;
  /** 实际检查的 `.md` 文档数（不含 `.markdown` 与 `.workbench`） */
  readonly documents: number;
  readonly issues: readonly HealthIssue[];
}

/** 文档历史版本摘要（新→旧；只读列出，不读版本正文） */
export interface DocHistoryEntry {
  /** 版本文件 id（ULID）；readHistory / restoreHistory 的定位键 */
  readonly versionId: string;
  /** 版本字节的 sha256，读取时与索引值交叉校验 */
  readonly hash: ContentHash;
  /** 版本写入时文档所在路径，仅用于展示 */
  readonly path: VaultPath;
  /** 版本写入时间（UTC YYYY-MM-DDTHH:MM:SSZ） */
  readonly at: string;
  /** 版本字节数 */
  readonly size: number;
}

export interface DocHistoryPreview {
  readonly entry: DocHistoryEntry;
  /** 只读展示文本：去 BOM、CRLF 归一为 LF（不落盘） */
  readonly text: string;
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
  /** 首个命中行（文件内 1-based，含 frontmatter 偏移）；空查询或正文未索引时为 null */
  readonly line: number | null;
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

/**
 * 未链接提及：某文档正文里出现了目标文档的标题或别名，但没有用 [[ 双链 ]] 包裹。
 * 来自按需扫描（IndexService.unlinkedMentions），不进索引 rebuild 周期。
 */
export interface UnlinkedMention {
  /** 提及发生在哪篇 */
  readonly srcId: DocId;
  /** 被提及（面板目标） */
  readonly targetId: DocId;
  /** 目标文档标题（展示用） */
  readonly title: string;
  /** 匹配发生在源文档正文中的 UTF-16 区间（JS string.slice 直接用） */
  readonly from: number;
  readonly to: number;
  /** 匹配到的字符串（接受时替换这个 range） */
  readonly match: string;
  /** 候选来源 */
  readonly kind: 'title' | 'alias';
  /** 所在行（1-based，含 frontmatter 偏移） */
  readonly line: number;
  /** 前后各 48 字符的上下文（面板展示） */
  readonly snippet: string;
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

/** 画布网格与 scene 共用同一形状，避免两处定义漂移 */
export type { CanvasGrid };

/** 库内可携带的设置（vault-format §8.1）；未知键保留 */
export interface VaultSettings {
  readonly schemaVersion: 1;
  readonly vault: { readonly id: VaultId; readonly name: string; readonly createdAt: string };
  readonly ui: {
    /** 主页画布（「主页固定」开关）；画布被删时由内核写 null 清除 */
    readonly defaultCanvasId?: string;
    /** 总览画布 id：固定的一张特殊画布 */
    readonly overviewCanvasId?: string;
    readonly canvasGrid: CanvasGrid;
    /** 文档浮窗上限（可在设置调整） */
    readonly floatLimit?: number;
    /** 最近访问的画布 id（新在前，最多 10 条；画布切换器「最近访问」分组） */
    readonly recentCanvasIds?: readonly string[];
    /** 左下角工具入口（能力化，默认关闭）：番茄钟 */
    readonly toolPomodoro?: boolean;
    /** 左下角工具入口：图库（附件面板），缺省（老 settings.json 无此键）按开启处理 */
    readonly toolGallery?: boolean;
    /** 编辑器左侧行号：缺省（老 settings.json 无此键）按开启处理 */
    readonly editorLineNumbers?: boolean;
    readonly theme: 'ember-black';
    readonly [key: string]: unknown;
  };
  readonly linkOverrides: Readonly<Record<string, DocId>>;
  readonly [key: string]: unknown;
}

export interface SettingsPatch {
  readonly ui?: Omit<Partial<VaultSettings['ui']>, 'canvasGrid' | 'defaultCanvasId' | 'overviewCanvasId'> & {
    readonly canvasGrid?: Partial<CanvasGrid>;
    /** null = 删除该键（画布被删时清掉主页固定 / 总览指向） */
    readonly defaultCanvasId?: string | null;
    readonly overviewCanvasId?: string | null;
  };
  readonly linkOverrides?: Readonly<Record<string, DocId>>;
}

/** `.workbench/settings.json` 的唯一读写方（kernel-contract §0 第 2 条） */
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

/** 库守护熔断状态：单次对账中消失文档过多时进入，等待用户确认 */
export interface VaultGuardState {
  /** 熔断前目录里的文档数 */
  readonly known: number;
  /** 本次对账中消失的文档数 */
  readonly missing: number;
  /** missing / known（known 为 0 时按 0 处理） */
  readonly ratio: number;
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
  /** 场景节点数：Portal 卡片与总览展示用 */
  readonly nodeCount: number;
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
}
