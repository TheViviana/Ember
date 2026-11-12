# Ember Kernel Contract v1

> 状态：v1 冻结候选。本文件是**内核与能力之间唯一契约源**。
> 代码位置：接口定义在 `src/kernel/*.ts`，类型别名在 `packages/doc-model/src/*`，画布类型在 `packages/canvas-engine/src/*`。
> 本文件与代码不一致时，以本文件为准，代码是 bug。

标记约定：`[事实]` = 由技术约束决定；`[设计选择]` = Ember 的决定。

---

## 0. 内核是什么

内核负责四件事，且只负责这四件事：

1. **身份的稳定性**：`DocId` 与路径的解耦。
2. **写入的唯一入口**：所有落在磁盘上的内容变更都经 `doc-service`。
3. **派生数据的正确性**：索引可以在任意时刻从文件重建，且重建结果等价。
4. **能力的装配**：注册、依赖排序、启停、销毁。

内核**不**负责：Markdown 渲染、画布交互、编辑器按键、AI 提示词、任何视觉表现。

`[设计选择]` 内核无特权：Ember 自己的「斜杠命令 / 专注模式 / 导出」与第三方能力一样，只能通过 `KernelContext` 提供的六个服务工作，走同一套 `CapabilityModule` 装配流程，位于 `src/capabilities/core/`。内核里不存在一条只有内置功能能走的捷径。

---

## 1. 不变量（实现与评审的验收标准）

| 编号 | 不变量 | 违反后果 | 检测手段 |
|---|---|---|---|
| **I1** | 所有磁盘写入必须经 `doc-service`。能力、UI 不得直接调用 `invoke`、`fs`、`fetch` 写文件。 | 绕过 journal / 冲突检测 / 索引刷新 | `gate:layers`（capabilities 禁止 `@tauri-apps`、`node:*`）+ code review |
| **I2** | 每次写入必须携带 `WriteOptions.base`（`rev` + `hash`）；不匹配即走三方合并，**不存在 force 分支**。 | 静默覆盖用户内容 | 类型系统（`base` 必填）+ review |
| **I3** | 索引是派生数据：只有 `index-service` 写索引；删除 sqlite 后必须能重建出等价状态。 | 索引变成第二真相源 | 索引 schema 无私有时刻状态；重建测试 |
| **I4** | 文档身份 = frontmatter `id`；重命名不改变 `id`，不改变任何链接边。 | 引用断裂 | 索引存储 `target_id` 而非路径 |
| **I5** | 所有用户意图（斜杠、菜单、快捷键、能力动作）必须注册为 `Command` 并经 `command-bus` 执行。 | 行为不可发现、不可撤销、不可测试 | `CommandBus.list()` 是 UI 唯一行为来源 |
| **I6** | `KernelContext` 对内置能力与外部能力完全一致，无隐藏字段。 | 生态与内核分叉 | 契约测试：内置能力只 import 契约类型 |
| **I7** | 能力持有的资源必须包成 `Disposable`，停用后不得残留监听/定时器。 | 内存泄漏、重复执行 | 停用后 `watch` 计数归零 |
| **I8** | 能力之间不得直接 `import`；依赖只能通过 `manifest.dependsOn` 声明，运行期通过 `ctx` 查询。 | 装配顺序不可控、环依赖 | `gate:layers`（capabilities 内部禁止互相 import） |
| **I9** | 能力不得直接访问 `@tauri-apps/*`、`node:*`、`process`、`globalThis.__TAURI__`。 | 绕过内核写入模型 | `gate:layers` |
| **I10** | 编辑器装饰必须增量：每次 `ViewUpdate` 只重建受影响区间，用 `RangeSetBuilder` 生成 `RangeSet`；禁止全量重算。 | 大文档输入卡顿 | 契约类型要求 `provide(view, update)`；review 检查是否读取 `update.changes` |
| **I11** | Markdown 只有一条解析管线：`unified` + `remark-parse` + `remark-frontmatter` + `remark-gfm` + `remark-math`，产出单一 `mdast`。 | 两套 AST 语义漂移 | `packages/doc-model/src/markdown/pipeline.ts` 是唯一入口 |
| **I12** | 未识别 frontmatter 键必须往返保留（语义级）。 | 破坏用户/其它工具数据 | 往返测试 |
| **I13** | 三方冲突必须落盘副本并 emit `doc:conflict`，不得只在内存里提示。 | 冲突被后续写入吞掉 | `WriteOutcome.conflict` 非空即已落盘 |
| **I14** | journal 重放幂等：同一 `tx` 的事件重复处理不产生第二次副作用。 | 启动恢复破坏数据 | 恢复算法按 `tx` 归并 |
| **I15** | 时间戳统一 UTC `YYYY-MM-DDTHH:MM:SSZ`；`created` 只写一次。 | 排序与去重不可靠 | `doc-service` 序列化路径唯一 |

---

## 2. 基础类型

```ts
// packages/doc-model/src/brand.ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

// packages/doc-model/src/ids.ts
export type DocId = Brand<string, 'DocId'>;          // ULID
export type VaultId = Brand<string, 'VaultId'>;      // ULID
export type CanvasId = Brand<string, 'CanvasId'>;    // ULID
export type CapabilityId = Brand<string, 'CapabilityId'>; // 反向域名或 slug
export type CommandId = Brand<string, 'CommandId'>;  // 必须带命名空间前缀
export type VaultPath = Brand<string, 'VaultPath'>;  // vault 相对 POSIX 路径
export type ContentHash = Brand<string, 'ContentHash'>; // "sha256:<64 hex>"

export type Disposable = { readonly dispose: () => void };
```

`[设计选择]` 全部身份用 branded string，而不是 `interface { id: string }` 包装对象：跨 IPC 与 JSON 序列化零成本，且不会出现 `{id}` 被误当字符串比较。

约束：

- `CommandId` 必须形如 `<namespace>.<verb>`，`namespace` 为能力 id 的短名或 `core`；注册时校验，非法即抛 `invalid_command_id`。
- `VaultPath` 必须经 `paths.normalize()` 产生；禁止手写字符串字面量（由 `PathTools` 唯一出口保证）。

---

## 3. DocService

```ts
export interface DocRevision {
  readonly rev: number;          // 单调递增，从 1 开始；进程内维护，跨重启以 hash 为准
  readonly hash: ContentHash;    // 文件字节的 sha256
}

export interface DocMeta {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly title: string;
  /** 永不缺失：frontmatter.summary，缺失时由正文首段派生（D8），派生值不回写磁盘 */
  readonly summary: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly created: string;      // ISO-8601 UTC
  readonly updated: string;      // ISO-8601 UTC
  readonly rev: DocRevision;
  readonly flags: DocFlags;      // 见 vault-format §3.3 / §10.5
}

export interface DocFlags {
  readonly needsAdoption: boolean;
  readonly idInvalid: boolean;
  readonly duplicateId: boolean;
}

export interface DocSnapshot {
  readonly meta: DocMeta;
  readonly frontmatter: Frontmatter;   // 含未知键，见 vault-format §4.6
  readonly text: string;               // 完整文件文本（含 frontmatter 块）
}

export interface DocService {
  read(id: DocId): Promise<DocSnapshot>;
  readByPath(path: VaultPath): Promise<DocSnapshot | null>;
  list(filter?: DocFilter): Promise<readonly DocMeta[]>;

  create(input: CreateDocInput): Promise<DocSnapshot>;
  update(id: DocId, patch: DocPatch, opts: WriteOptions): Promise<WriteOutcome>;
  rename(id: DocId, next: VaultPath, opts: WriteOptions): Promise<WriteOutcome>;
  remove(id: DocId, opts: WriteOptions): Promise<void>;

  /**
   * 等待所有进行中的写入落盘；关闭库、导出前必须调用。
   * v1 无索引写入方，本调用不涉及索引刷新；索引接入后必须恢复 D7 的对齐保证。
   */
  flush(): Promise<void>;

  /** 订阅本实例内的文档变更（外部改动也经 watcher 揉合后从这里发出） */
  watch(listener: (change: DocChange) => void): Disposable;
}
```

```ts
export type WriteIntent = 'user' | 'capability' | 'migration' | 'system';

export interface WriteOptions {
  /** 必填。读取时拿到的修订；写入时用于乐观并发校验与三方合并基线 */
  readonly base: DocRevision;
  readonly intent: WriteIntent;
}

export interface CreateDocInput {
  readonly path: VaultPath;
  readonly text: string;
  readonly title?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly aliases?: readonly string[];
  /** 仅导入/迁移允许指定；普通创建必须留空，由内核生成 */
  readonly id?: DocId;
  readonly intent: WriteIntent;
}

export interface DocPatch {
  /** 只能改这四项；id 与 created 不可改 */
  readonly frontmatter?: {
    readonly title?: string;
    readonly summary?: string;
    readonly tags?: readonly string[];
    readonly aliases?: readonly string[];
  };
  /** 完整正文（不含 frontmatter 块） */
  readonly body?: string;
}

export interface WriteOutcome {
  readonly snapshot: DocSnapshot;
  /** true = 快路径或自动合并成功；false = 发生冲突并已落盘副本 */
  readonly merged: boolean;
  readonly conflict: ConflictCopy | null;
}

export interface ConflictCopy {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly of: DocId;
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
```

不变量：

- **D1** `update`/`rename`/`remove` 的 `base` 与磁盘不一致时，必须走 diff3，不得直接覆盖（I2）。
- **D2** `create` 遇到已存在的路径，必须抛 `path_exists`，不得覆盖。
- **D3** `rename` 不改变 `id`、`created`、`updated`；只改路径与 frontmatter 中的显式 title 不受影响。
- **D4** `remove` 把文件**移入操作系统回收站**（macOS：`NSFileManager.trashItemAtURL`），库内不保留副本；非 macOS 明确失败（`io_failed`，文案说明该平台不支持系统回收站），**不得**回退为永久删除。应用内不提供从回收站恢复的入口，恢复只能在系统回收站里完成。永久删除入口 `Vault::purge` / `vault_purge` **仅供内核回滚内部使用**（文章创建后画布写入失败），不是用户入口；`core.doc.purge` 在 v1 仍是「未实现」。
- **D5** 所有返回值里的 `DocMeta.rev` 必须与磁盘实际内容对应；不允许返回「打算写入但未提交」的状态。
- **D6** `read` 不做写入（adoption 不在这里发生）。
- **D7**（目标，**v1 不成立**）任何写入完成后，索引刷新可以是异步的，但 `flush()` 返回后索引必须已对齐。
  现状：`doc-service.flush()` 只排空写入队列（`src/kernel/doc-service.ts` 的 `flush` 实现），不触碰索引；
  生产注入的是占位索引端口（见 §4 实现状态）。索引接入时必须同时恢复本不变量，并让 `flush()` 覆盖索引对齐。
- **D8** `summary` 只来自 frontmatter；缺失时按 vault-format §4.3 从正文首段派生，供展示使用，**派生值不回写磁盘**；旧文档缺该键不产生诊断、不阻断读取。

---

## 4. IndexService

> **实现状态（v1 未实现）**：Rust 侧 SQLite/FTS5 索引尚未接入，生产启动注入的是
> `createPendingIndexPort` 占位端口（`available: false`，见 `src/data/bootstrap.ts`）。
> 因此 `document` / `search` / `outbound` / `backlinks` / `stats` / `rebuild` 在运行期统一抛
> `index_unavailable`，`watch` 为空实现。v1 没有任何 UI 或能力调用这些方法，也没有消费该错误码的界面；
> 反链由外壳前端全库正文扫描临时实现（`src/shell/editor/backlinks.ts`），不经过本服务。
> 下文接口与不变量是索引接入时的目标，不是当前能力。

```ts
export interface SearchQuery {
  readonly text: string;
  readonly limit?: number;              // 默认 30，上限 200
  readonly tags?: readonly string[];    // AND 语义
  readonly pathPrefix?: VaultPath;
}

export interface SearchHit {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly title: string;
  readonly snippet: string;      // 命中的上下文，已做高亮标记
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
  readonly raw: string;          // 原始 target 文本
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

export interface IndexService {
  document(id: DocId): Promise<IndexedDocument | null>;
  search(query: SearchQuery): Promise<SearchResult>;
  outbound(id: DocId): Promise<readonly LinkRecord[]>;
  backlinks(id: DocId): Promise<readonly LinkRecord[]>;
  stats(): Promise<IndexStats>;

  /** 全量重建；幂等。结束前 emit index:updated */
  rebuild(): Promise<IndexStats>;

  watch(listener: (event: IndexEvent) => void): Disposable;
}

export interface IndexEvent {
  readonly kind: 'updated' | 'rebuilt' | 'unavailable';
  readonly changedDocIds: readonly DocId[];
}
```

不变量：

- **X1**（目标，未实现）`IndexService` 是唯一可写索引的组件；其它组件只能通过它读（I3）。v1 没有任何索引写入方。
- **X2**（目标，未实现）`search` 中的中文切分必须与 `vault-format §9.3` 一致；查询串与索引串走同一 `tokenize()` 实现，禁止两处实现。v1 代码中不存在 `tokenize()`。
- **X3**（目标，未实现）未解析/歧义链接必须可查询（`stats`），不得静默丢弃（`vault-format §5.2`）。v1 的 `stats` 直接抛 `index_unavailable`。
- **X4**（目标，未实现）`rebuild()` 可以在 `doc-service` 有并发写入时调用；实现必须基于「读文件 → 比对 hash → 写入索引」，允许最终一致，不允许把读到一半的文件写进索引。v1 的 `rebuild` 直接抛 `index_unavailable`。
- **X5**（部分实现）索引不可用时，`search` 抛 `index_unavailable`——这一条已实现（`index-service.ts` 的 `guard`）；
  「由 shell 提示『正在重建』」**未实现**：v1 没有库级搜索 UI，也没有任何消费 `index_unavailable` 的界面，
  因此不存在提示路径。索引接入并出现搜索入口后，shell 必须补上该提示。任何时候都不得返回空结果冒充成功。

---

## 5. CapabilityHost 与能力装配

```ts
export interface CapabilityManifest {
  readonly id: CapabilityId;
  readonly version: string;              // semver
  readonly displayName: string;
  readonly description?: string;
  readonly requiresKernel: string;       // semver range，v1 只接受满足 1.x 的声明
  readonly dependsOn?: readonly CapabilityId[];
  readonly defaultEnabled: boolean;
}

export interface CapabilityModule {
  readonly manifest: CapabilityManifest;
  /** 只允许在这里注册命令/装饰槽/索引提取器/画布图层；不得保存 ctx 到模块级单例 */
  activate(ctx: KernelContext): void | Promise<void>;
}

export interface CapabilityState {
  readonly id: CapabilityId;
  readonly enabled: boolean;             // settings.json 里的开关
  readonly active: boolean;              // 运行期是否已激活
  readonly error: string | null;
}

export interface CapabilityHost {
  register(module: CapabilityModule): Disposable;
  activate(id: CapabilityId): Promise<void>;
  deactivate(id: CapabilityId): Promise<void>;
  isActive(id: CapabilityId): boolean;
  list(): readonly CapabilityState[];
  watch(listener: (state: CapabilityState) => void): Disposable;
}
```

装配规则：

- **C1** 注册只发生在编译期装配：`src/capabilities/index.ts` 静态 import 所有能力并导出 `readonly CapabilityModule[]`。运行期 `register` 仅供外壳在测试中注入，生产路径只有一个入口。
- **C2** `id` 全局唯一，重复注册抛 `duplicate_capability`。
- **C3** `dependsOn` 必须无环、必须已注册；激活按拓扑序，停用按反拓扑序。
- **C4** `requiresKernel` 不满足时，注册成功但激活失败，状态为 `error`，不阻塞其它能力。
- **C5** 激活过程中通过 `ctx` 注册的所有 `Disposable` 由 host 记录，`deactivate` 时**逆序**统一释放（I7）。能力不得自己维护全局清理列表。
- **C6** 能力被停用后，其命令必须从 `command-bus` 消失（`Disposable` 链），不能只是 `when()` 返回 false。
- **C7** 能力读取 `settings.json` 的开关由 host 负责；能力自己不解析设置文件。

---

## 6. CanvasHost

画布几何与场景类型属于 `packages/canvas-engine`，内核只做装配与持久化桥接。

```ts
// packages/canvas-engine/src/types.ts
export interface CanvasPoint { readonly x: number; readonly y: number }
export interface CanvasRect extends CanvasPoint { readonly w: number; readonly h: number }
export interface Viewport extends CanvasPoint { readonly zoom: number }

export type CanvasNodeKind = 'doc' | 'note' | 'group' | string;

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly rect: CanvasRect;
  readonly z: number;
  readonly docId: DocId | null;
  readonly text: string | null;
  /** 所属组节点 id；一个节点最多属于一个组，组不能嵌套（vault-format §8.2） */
  readonly groupId: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly arrow: 'none' | 'end' | 'both';
  readonly kind: 'relation';
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface CanvasScene {
  readonly id: CanvasId;
  readonly title: string;
  readonly viewport: Viewport;
  /** 画布自己的网格/吸附；创建时取 settings.ui.canvasGrid，之后随场景走 */
  readonly grid: CanvasGrid;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

/** 磁盘文档：scene 之外的时间戳、schema 与能力私有数据（写入时原样保留） */
export interface CanvasDocument {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scene: CanvasScene;
  readonly capabilityData: Readonly<Record<string, unknown>>;
}

export interface CanvasFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly viewport: Viewport;
  readonly size: { readonly w: number; readonly h: number };
  readonly scene: CanvasScene;
  readonly dpr: number;
}

export interface CanvasLayer {
  readonly id: string;
  readonly zIndex: number;
  /** 必须是纯绘制：不得读时间以外的外部状态，不得发 IPC */
  draw(frame: CanvasFrame): void;
  hitTest?(point: CanvasPoint, frame: CanvasFrame): string | null;
}
```

```ts
// src/kernel/canvas-host.ts
export interface CanvasSummary {
  readonly id: CanvasId;
  readonly title: string;
  readonly updatedAt: string;
}

export interface CreateCanvasInput {
  readonly title: string;
  readonly viewport?: Viewport;
}

export interface CanvasSession {
  readonly id: CanvasId;
  readonly scene: CanvasScene;
  /** 局部修改，由引擎负责标脏与重绘；返回的 Disposable 用于撤销订阅 */
  on(listener: (scene: CanvasScene) => void): Disposable;
  close(): void;
}

export type CanvasMutation =
  | { readonly type: 'addNode'; readonly node: CanvasNode }
  | { readonly type: 'updateNode'; readonly id: string; readonly patch: CanvasNodePatch }
  | { readonly type: 'removeNodes'; readonly ids: readonly string[] }
  | { readonly type: 'addEdge'; readonly edge: CanvasEdge }
  | { readonly type: 'updateEdge'; readonly id: string; readonly patch: CanvasEdgePatch }
  | { readonly type: 'removeEdges'; readonly ids: readonly string[] }
  | { readonly type: 'setViewport'; readonly viewport: Viewport }
  | { readonly type: 'setTitle'; readonly title: string }
  | { readonly type: 'setGrid'; readonly grid: CanvasGrid };

export interface CanvasNodePatch {
  readonly rect?: CanvasRect;
  readonly z?: number;
  readonly text?: string | null;
  readonly groupId?: string | null;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface CanvasEdgePatch {
  readonly label?: string | null;
  readonly arrow?: CanvasEdge['arrow'];
}

export interface CanvasGrid {
  readonly size: 8 | 16 | 32;
  readonly snap: boolean;
}

export interface CanvasHost {
  list(): Promise<readonly CanvasSummary[]>;
  create(input: CreateCanvasInput): Promise<CanvasSummary>;
  open(id: CanvasId): Promise<CanvasSession>;
  /** 解析主页画布：settings.ui.defaultCanvasId → 已有画布 → 新建「主页」并写回 settings */
  ensureDefault(): Promise<CanvasSummary>;
  /** 一批 mutation 一次原子写；写入前整批校验，失败抛 canvas_invalid 且不落盘 */
  apply(id: CanvasId, ops: readonly CanvasMutation[]): Promise<CanvasScene>;
  registerLayer(layer: CanvasLayer): Disposable;
  registerNodeKind(kind: CanvasNodeKindSpec): Disposable;
  /** 强制落盘挂起的视口防抖；内核关闭与窗口隐藏时调用 */
  flush(): Promise<void>;
}

export interface CanvasNodeKindSpec {
  readonly kind: string;
  readonly minSize: { readonly w: number; readonly h: number };
  readonly createDefault: (rect: CanvasRect) => Omit<CanvasNode, 'id' | 'z' | 'groupId'>;
}
```

不变量：

- **V1** 图层只绘制，不得修改场景；任何修改必须经 `command-bus` 的命令 → `canvas-host` 内部 mutation。
- **V2** 场景持久化写 `.workbench/canvas/<id>.json`，走与文档相同的原子写；不进 Markdown 索引。
- **V3** `open` 同一画布多次返回同一会话（引用计数），全部 `close` 后才释放。
- **V4** 图层 `zIndex` 相同按注册顺序；注册顺序稳定，不得依赖 Map 迭代顺序以外的隐式顺序。
- **V5** `apply` 的每个批次 = 一次原子写；校验（节点 id 唯一、`groupId` 合法、边端点存在且非组、无自环、`(from,to)` 唯一）失败时整批拒绝，磁盘与内存场景都保持原样。
- **V6** `viewport` 变更以 400ms 防抖落盘；会话 `close()` 与 `visibilitychange(hidden)` 时强制 flush，保证重启后视口保持。

---

## 7. EditorHost

```ts
// src/kernel/editor-host.ts
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import type { Disposable, DocSnapshot } from './types.ts';

/**
 * 一次打开文档的会话。EditorView 由 shell 创建（内核不碰 DOM），
 * 内核只提供创建视图所需的快照、扩展与装饰槽。
 */
export interface EditorSession {
  readonly docId: DocId;
  /** 打开瞬间的磁盘快照；首次保存必须把它当作 base（E2） */
  readonly snapshot: DocSnapshot;
  /** 打开时内核已登记的扩展快照（语言、主题、快捷键） */
  readonly extensions: readonly Extension[];
  /** 打开时已登记的装饰槽快照 */
  readonly slots: readonly DecorationSlot[];
  /** 关闭会话；不写盘（写盘由 doc-service 的保存流程负责） */
  close(): void;
}

export interface DecorationContext {
  readonly docId: DocId;
  readonly host: EditorHost;
}

export interface DecorationProvider {
  /**
   * 必须只根据 update.changes / update.viewportChanged 重建受影响区间。
   * 允许返回与上一次相同的 DecorationSet 实例以跳过重绘。
   */
  provide(view: EditorView, update: ViewUpdate): DecorationSet;
}

export interface DecorationSlot {
  readonly id: string;
  readonly placement: 'inline' | 'gutter' | 'block';
  readonly provider: (context: DecorationContext) => DecorationProvider;
}

export interface EditorHost {
  open(docId: DocId): Promise<EditorSession>;
  active(): EditorSession | null;
  /** 追加任意 CodeMirror 扩展（主题、语言、快捷键扩展） */
  extend(extension: Extension): Disposable;
  registerDecorationSlot(slot: DecorationSlot): Disposable;
}
```

不变量：

- **E1** 装饰必须增量（I10）：`provide` 的实现必须读取 `update.changes`，用 `RangeSetBuilder` 或对旧 `RangeSet` 做 `map`，禁止每次 `EditorState.create`。
- **E2** 编辑内容不直接落盘；保存是命令 `core.doc.save` 的职责，且必须带 `base` 修订（v1 未实现 `core.doc.save` 命令：当前由编辑会话直接调用 `DocService.update`，入口在 `src/shell/editor/float-persist.ts`；属已记录缺口，不是允许的现状）。
- **E3** `registerDecorationSlot` 的 `id` 在能力内唯一，冲突抛 `duplicate_slot`；停用能力时随 `Disposable` 移除。
- **E4** 一个文档同一时刻只有一个 `EditorView`（v1 不做同屏分栏编辑）；`open` 幂等返回同一会话，`close` 后才释放。`extensions` / `slots` 是打开瞬间的快照，打开后再登记的扩展只影响后续会话。

---

## 8. CommandBus

```ts
export type CommandScope = 'global' | 'editor' | 'canvas';

export interface CommandContext {
  readonly kernel: KernelContext;
  readonly docId: DocId | null;
  readonly surface: CommandScope;
}

export interface KeyBinding {
  readonly key: string;                  // 例 "Mod-Shift-k"，CodeMirror keymap 语法
  readonly scope: CommandScope;
}

export interface Command<Args = void> {
  readonly id: CommandId;
  readonly title: string;                // 命令面板显示文本
  readonly scope: CommandScope;
  readonly keybinding?: KeyBinding;
  /** 仅在命令面板过滤时使用，不得用于权限控制 */
  readonly when?: (ctx: CommandContext) => boolean;
  run(args: Args, ctx: CommandContext): void | Promise<void>;
}

export interface CommandDescriptor {
  readonly id: CommandId;
  readonly title: string;
  readonly scope: CommandScope;
  readonly keybinding: KeyBinding | null;
  readonly owner: CapabilityId | null;
}

export interface CommandResult {
  readonly id: CommandId;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface CommandBus {
  register<Args>(command: Command<Args>): Disposable;
  execute(id: CommandId, args?: unknown): Promise<CommandResult>;
  list(): readonly CommandDescriptor[];
  watch(listener: (descriptors: readonly CommandDescriptor[]) => void): Disposable;
}
```

不变量：

- **K1** 注册即申请 id：重复 id 抛 `duplicate_command`，后来者失败，先注册者继续有效。
- **K2** `execute` 不抛异常，失败返回 `{ ok: false, error }`；但 `doc_service` 的错误要保留 `code` 以文本形式。
- **K3** 命令执行期间不得嵌套执行同一命令（重入保护，抛 `command_reentrant`）。
- **K4** `owner` 由 host 在能力激活上下文中自动填充；能力自注册的命令 owner 必须等于该能力 id。
- **K5** `list()` 的顺序稳定：按 `owner`、再按 `id` 字典序。命令面板与快捷键注册都读它，UI 不自行维护第二份列表。

---

## 9. KernelContext

```ts
// src/kernel/context.ts
export interface KernelEnv {
  readonly kernelVersion: string;   // "1.1.0"
  readonly vaultId: VaultId;
  readonly readonlyMode: boolean;   // 未拿到库锁时为 true
}

export interface KernelContext {
  readonly env: KernelEnv;
  readonly docs: DocService;
  /** 文章门面：内部持有带 purge 的文档服务，能力侧看不到永久删除入口 */
  readonly articles: ArticlesFacade;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly editor: EditorHost;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
  readonly capabilities: CapabilityHost;
  readonly events: EventBus;
  readonly log: Logger;
  readonly paths: PathTools;
  /** 能力间共享可扩展槽；键冲突抛 duplicate_extension */
  extend<T>(slot: ExtensionSlot<T>, value: T): Disposable;
}

/** .workbench/settings.json 的唯一读写方（vault-format §8.1） */
export interface SettingsService {
  read(): Promise<VaultSettings>;
  /** 深合并到 ui / capabilities；未识别键原样保留（P2）。只读模式抛 vault_locked */
  patch(patch: SettingsPatch): Promise<VaultSettings>;
  watch(listener: (next: VaultSettings) => void): Disposable;
}

export interface SettingsPatch {
  readonly ui?: Partial<VaultSettings['ui']>;
  readonly capabilities?: Readonly<Record<string, { enabled?: boolean; config?: Readonly<Record<string, unknown>> }>>;
  readonly linkOverrides?: Readonly<Record<string, DocId>>;
}

export interface VaultSettings {
  readonly schemaVersion: 1;
  readonly vault: { readonly id: VaultId; readonly name: string; readonly createdAt: string };
  readonly capabilities: Readonly<Record<string, { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> }>>;
  readonly ui: {
    readonly defaultView: 'canvas' | 'editor';
    readonly defaultCanvasId?: CanvasId;
    readonly sidebar: 'auto' | 'off';
    readonly canvasGrid: CanvasGrid;
    readonly theme: 'ember-black';
    readonly [key: string]: unknown;
  };
  readonly linkOverrides: Readonly<Record<string, DocId>>;
  readonly [key: string]: unknown;
}

export interface ExtensionSlot<T> {
  readonly id: string;
  readonly __type?: T;   // 仅用于类型推断
}

export interface Logger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface PathTools {
  /** 归一化为 VaultPath；越界/绝对路径抛 path_outside_vault */
  normalize(input: string): VaultPath;
  join(base: VaultPath, ...segments: readonly string[]): VaultPath;
  dirname(path: VaultPath): VaultPath;
  basename(path: VaultPath): string;
  stem(path: VaultPath): string;
  ext(path: VaultPath): string;
  /** 冲突副本命名（vault-format §10.3） */
  conflictName(path: VaultPath, at: Date, uid: string): VaultPath;
}
```

```ts
// src/kernel/events.ts
export interface KernelEventMap {
  'doc:changed': { id: DocId; path: VaultPath; kind: DocChange['kind']; revision: DocRevision };
  'doc:conflict': { id: DocId; copyId: DocId; copyPath: VaultPath };
  'index:updated': { changedDocIds: readonly DocId[] };
  'command:executed': { id: CommandId; ok: boolean };
  'capability:state': { id: CapabilityId; active: boolean; error: string | null };
  'vault:mode': { readonly: boolean; reason: string | null };
  'canvas:changed': { canvasId: CanvasId; rev: number };
  /** 内核只发意图，由 shell 打开浮窗/选择器；能力不得直接碰 UI（G1） */
  'canvas:ui': {
    canvasId: CanvasId;
    action: 'openDoc' | 'editDoc' | 'attachDoc' | 'canvasSettings';
    docId: DocId | null;
    point?: CanvasPoint;
  };
  'settings:changed': { settings: VaultSettings };
}

export interface EventBus {
  emit<K extends keyof KernelEventMap>(type: K, payload: KernelEventMap[K]): void;
  on<K extends keyof KernelEventMap>(
    type: K,
    handler: (payload: KernelEventMap[K]) => void,
  ): Disposable;
}
```

不变量：

- **G1** `KernelContext` 是能力能看到的**全部**内核面。能力不得 import `src/shell/*`、`src/data/*`、`src/kernel/*` 的具体实现（只允许 `@ember/doc-model` 与契约类型）。
- **G2** `readonlyMode` 为 true 时，`docs.create/update/rename/remove` 必须抛 `vault_locked`，而 `index.search` 正常可用。
- **G3** 能力不得把 `ctx` 存到模块级变量或 `globalThis`；契约测试会以伪造 ctx 激活两次，第二次必须失败或完全覆盖。
- **G4** `events.on` 返回的 `Disposable` 必须被 host 或能力持有并释放；`emit` 期间不得修改监听器集合（迭代快照）。

---

## 10. 错误模型

```ts
export type EmberErrorCode =
  | 'not_implemented'
  | 'doc_not_found'
  | 'path_exists'
  | 'path_outside_vault'
  | 'stale_revision'
  | 'invalid_frontmatter'
  | 'duplicate_id'
  | 'vault_locked'
  | 'index_unavailable'
  | 'command_not_found'
  | 'command_reentrant'
  | 'duplicate_command'
  | 'invalid_command_id'
  | 'duplicate_capability'
  | 'capability_failed'
  | 'duplicate_slot'
  | 'duplicate_extension'
  | 'canvas_invalid'
  | 'io_failed';

export class EmberError extends Error {
  readonly code: EmberErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: EmberErrorCode, message: string, details?: Readonly<Record<string, unknown>>);
}
```

规则：`code` 是稳定契约，`message` 可改（可本地化）；UI 依据 `code` 分支，不解析 `message`。

---

## 11. 启动顺序（不可乱序）

```
1. 解析 vault 路径 → 计算 vaultHash
2. 获取库锁（失败 → readonlyMode = true）
3. journal 恢复（vault-format §6.2）——必须在任何写之前
4. 打开索引：校验 schema_version / tokenizer_version，不匹配则重建（v1 未执行：无索引）
5. 绑定端口（VaultPort / IndexPort / AiPort），由 data 层注入（v1 的 IndexPort 为占位实现）
6. 构造服务：events → commands → settings → docs → index → editor → canvas → capabilities
7. 注册能力（静态清单）→ 依赖校验 → 拓扑激活（跳过 disabled）
8. 交给 shell（React 挂载，注入 KernelProvider）
9. 启动 watcher → 初次全量对账（文件 → 索引）（v1 只做文件层对账，无索引）
10. emit 'vault:mode'
```

失败策略：3–6 任一步失败 → 启动中止并展示可复制诊断，**不允许**带着未恢复的 journal 进入可写状态。
索引相关失败策略在索引接入后另行定义（v1 无索引，第 4 步不执行）。

---

## 12. 契约演进

- 版本号规则（`KERNEL_VERSION`）：
  - **新增**字段或服务方法 → minor 位 +1（如 1.0.0 → 1.1.0）；
  - **删除**字段或改变已有字段语义 → major 位 +1，并同时存在两个版本的能力适配层（v1 能力仍能加载）；
  - 纯 bug 修复、接口不变 → patch 位 +1。
- 新增字段时，**所有 `KernelContext` 构造点必须同步**（boot 的 createKernelContext、测试桩 stubContext/scopeContext 等）；不补即类型错误，不得用可选字段或类型断言绕过。
- 能力声明的 `requiresKernel` 与实际内核版本不兼容时，只禁用该能力，不阻塞启动。

---

## 13. 明确不做（v1）

- 不做权限沙箱：能力与内核同进程、同权限（`vault-format` 与 `I9` 约束的是**代码规范**，不是安全边界）。
- 不做插件热加载/远程下载；能力只来自编译期装配。
- 不做多窗口共享同一 `KernelContext` 的内存同步；多窗口通过文件 + watcher 通信（v1 单窗口）。
- 不做撤销栈的跨会话持久化。
