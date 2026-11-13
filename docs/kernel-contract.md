# Ember Kernel Contract v2

> 状态：v2 生效。本文件是**内核与外壳之间唯一契约源**。
> 代码位置：接口定义在 `src/kernel/*.ts`，类型别名在 `packages/doc-model/src/*`，画布类型在 `packages/canvas-engine/src/*`。
> 本文件与代码不一致时，以本文件为准，代码是 bug。
>
> **v2 相对 v1 的架构决定**（TRAE 最终方案落地）：删除能力体系（capability-host）、编辑器宿主（editor-host）、文章门面（article-service）；索引由占位端口改为内核内存实现；写入管线退化为「基线校验 + 冲突副本」（不做自动三方合并）；Rust 侧删除 journal，库锁收敛为「独占创建 + pid 存活 + 失效清理」。删除的是机制，不是保证——原子写、基线校验、文件监视、单实例锁、系统回收站、身份引用六项保证全部保留。

标记约定：`[事实]` = 由技术约束决定；`[设计选择]` = Ember 的决定。

---

## 0. 内核是什么

内核负责五件事，且只负责这五件事：

1. **身份的稳定性**：`DocId` 与路径的解耦；外部改名/移动按身份重绑。
2. **写入的唯一入口**：所有落在磁盘上的内容变更都经 `doc-service`。
3. **派生数据的正确性**：索引（搜索/反链）随时可从文件重建，且重建结果等价。
4. **画布库**：多画布的增删改复制、总览画布、Portal、视图书签、定位。
5. **统一命令总线**：所有用户意图注册为 `Command` 并经 `command-bus` 执行。

内核**不**负责：Markdown 渲染、画布交互、编辑器按键、AI 提示词、任何视觉表现。

`[设计选择]` 内核无外壳特权：外壳（`src/shell/`）与内核只通过 `KernelContext` 通信；不存在只有内置功能能走的捷径。功能开关是设置里的普通布尔值（`ui.tool*`），不是插件系统。

---

## 1. 不变量（实现与评审的验收标准）

| 编号 | 不变量 | 违反后果 | 检测手段 |
|---|---|---|---|
| **I1** | 所有磁盘写入必须经 `doc-service` 或 `canvas-host`。UI 不得直接调用 `invoke`、`fs`、`fetch` 写文件。 | 绕过冲突检测 / 索引刷新 | `gate:layers`（kernel 禁止 `@tauri-apps`、React）+ code review |
| **I2** | 每次写入必须携带 `WriteOptions.base`（`rev` + `hash`）；不匹配即落冲突副本，**不存在 force 分支，也不做自动合并**。 | 静默覆盖用户内容 | 类型系统（`base` 必填）+ review |
| **I3** | 索引是派生数据：只有 `index-service` 写索引；重建必须等价。元数据（标题/标签/别名）即时可搜，正文后台增量。 | 索引变成第二真相源 | 重建测试（tests/kernel/index-service.test.ts） |
| **I4** | 文档身份 = frontmatter `id`；重命名不改变 `id`，不改变任何链接边。外部改名/移动由目录对账按身份迁移。 | 引用断裂 | `doc-service.refresh` 迁移测试 |
| **I5** | 所有用户意图必须注册为 `Command` 并经 `command-bus` 执行。 | 行为不可发现、不可测试 | `CommandBus.list()` 是 UI 唯一行为来源 |
| **I6** | 画布节点引用文档身份（`docId`），不引用路径。 | 外部搬动文件断链 | 画布节点类型固定 `docId: DocId \| null` |
| **I7** | 画布只存摆放：节点、连线、视口、书签、Portal 指向；不承载正文。 | 画布变成第二真相源 | `CanvasDocument` 无正文字段 |
| **I8** | 文件被外部删除后，画布节点保留失效占位（不自动消失），右键可清理；从回收站放回后自动恢复可用。 | 误删布局 | 外部对账 + 失效占位测试 |
| **I9** | 用户删除一律进系统回收站（`vault_remove`）；`vault_purge` 仅供内核回滚（文章创建后画布写失败）与画布历史轮转，不注册为用户命令。 | 不可恢复的删除 | media/trash 测试 |
| **I10** | Markdown 只有一条解析管线：`unified` + `remark-parse` + `remark-frontmatter` + `remark-gfm` + `remark-math`，产出单一 `mdast`。 | 两套 AST 语义漂移 | `packages/doc-model/src/markdown/pipeline.ts` 是唯一入口 |
| **I11** | 未识别 frontmatter 键必须往返保留（语义级）。 | 破坏用户/其它工具数据 | 往返测试 |
| **I12** | 基线冲突必须落盘冲突副本并 emit `doc:conflict`，不得只在内存里提示。 | 冲突被后续写入吞掉 | `WriteOutcome.conflict` 非空即已落盘 |
| **I13** | 时间戳统一 UTC `YYYY-MM-DDTHH:MM:SSZ`；`created` 只写一次。 | 排序与去重不可靠 | `doc-service` 序列化路径唯一 |
| **I14** | 非 UTF-8 文件拒绝一切会重编码的写入（含冲突副本），文件保持一字节不动。 | 保存损坏原始字节 | doc-service-encoding 测试 |

---

## 2. 基础类型

```ts
// packages/doc-model/src/ids.ts
export type DocId = Brand<string, 'DocId'>;          // ULID
export type VaultId = Brand<string, 'VaultId'>;      // ULID
export type CanvasId = Brand<string, 'CanvasId'>;    // ULID
export type CommandId = Brand<string, 'CommandId'>;  // 必须形如 <namespace>.<verb>
export type VaultPath = Brand<string, 'VaultPath'>;  // vault 相对 POSIX 路径
export type ContentHash = Brand<string, 'ContentHash'>; // sha256:<hex>
```

---

## 3. DocService（`.workbench/` 之外的唯一写入口）

```ts
export interface DocService {
  read(id: DocId): Promise<DocSnapshot>;
  readByPath(path: VaultPath): Promise<DocSnapshot | null>;
  list(filter?: DocFilter): Promise<readonly DocMeta[]>;
  create(input: CreateDocInput): Promise<DocSnapshot>;
  update(id: DocId, patch: DocPatch, opts: WriteOptions): Promise<WriteOutcome>;
  rename(id: DocId, next: VaultPath, opts: WriteOptions): Promise<WriteOutcome>;
  remove(id: DocId, opts: WriteOptions): Promise<void>;   // 系统回收站
  listHistory(id: DocId): Promise<readonly DocHistoryEntry[]>;
  readHistory(id: DocId, versionId: string): Promise<DocHistoryPreview>;
  restoreHistory(id: DocId, versionId: string, opts: WriteOptions): Promise<WriteOutcome>;
  adoptCopy(copyId: DocId, opts: AdoptConflictOptions): Promise<AdoptConflictResult>;
  detachCopy(copyId: DocId, opts: WriteOptions): Promise<DocSnapshot>;
  /** 为缺少 id 的既有 `.md` 文件补写身份；不改正文，不记历史 */
  adopt(path: VaultPath, expectedHash: ContentHash): Promise<DocSnapshot>;
  flush(): Promise<void>;
  watch(listener: (change: DocChange) => void): Disposable;
}

export interface AdoptConflictOptions {
  base: DocRevision;      // 用户在冲突中心看到的原文修订
  copyBase: DocRevision;  // 用户在冲突中心看到的副本修订
  intent: WriteIntent;
}

export interface AdoptConflictResult {
  snapshot: DocSnapshot;
  copyRemoved: boolean;   // false = 原文已更新，但第二步删除副本失败
}

export interface DocServiceInternal extends DocService {
  refresh(): Promise<void>;               // watcher 触发的目录对账
  purge(id: DocId, opts: WriteOptions): Promise<void>; // 仅供 createArticle 回滚
}
```

细节不变量（v2 修订后）：

- **D1** `update` 唯一写管线：读盘 → `base.hash` 与磁盘比对 → 一致则直接写（快路径）；不一致则**保留磁盘版本**并把本地改动写入冲突副本（`<stem> (conflict <UTC戳>-<4字符>).md`，新 ULID + `ember.conflictOf`），emit `doc:conflict`。**没有 diff3/merge3**。
- **D2** `create` 命中已有路径抛 `path_exists`；同 id 重复抛 `duplicate_id`。
- **D3** `rename` 保持 `id`、`created` 与所有链接不变；目标存在抛 `path_exists`；基线过期抛 `stale_revision`。
- **D4** `remove` → `vault_remove` → OS 回收站（非 macOS 明确失败，不回退永久删除）；`purge` 只服务回滚。
- **D5** `read` 返回的 `DocMeta.rev` 可直接作为后续写 `base`（read 不写盘，只同步缓存）。
- **D6** 外部变更事件只由 watcher → refresh 链广播（`doc:changed` kind `external`）；read 不是事件源。
- **D7** 外部改名/移动：refresh 发现同 id 出现在新路径时迁移目录条目（`kind: 'renamed'` 或 `external`），画布节点不断链。
- **D8** 文件消失：refresh 广播 `removed`；画布节点转失效占位（I8）。
- **D9** per-docId 串行写队列仍然保留：读-改-写整体入队，防止进程内并发丢更新。`previousCommitted` 快照与 merge3 已删除。
- **D10** `update` 快路径在提交主文前先把当前磁盘**原始字节**记入文档历史（`.workbench/history/documents/<docId>/`，每篇最多 20 版 / 64 MiB，最旧先淘汰）；历史写失败直接抛出且不提交主文。`create` / `rename` / 冲突副本创建 / `remove` / `purge` 不记录历史。
- **D11** `restoreHistory` 在串行队列内重新读盘并校验 `opts.base.hash`：一致则先把当前版入历史再写回目标版原始字节（后续历史不删除，可用恢复前的版本再恢复）；失配时不改主文、不新增历史，把目标版内容写成冲突副本并返回 `merged: false`。目标版本 id 非法、文件缺失、非 UTF-8 或 sha256 与索引不符分别抛 `invalid_payload` / `doc_not_found`，且全程不写盘。
- **D12** `DocMeta.conflictOf` 由 frontmatter `ember.conflictOf` 解析：合法 ULID 归还原文 id，缺失/非法一律 `null`。冲突副本仍留在普通列表与搜索结果中，外壳据 `conflictOf !== null` 显示冲突标识；不做自动合并、不自动清理。
- **D13** `adoptCopy` 在**原文** docId 队列内执行：重新读盘并分别校验副本与原文的 sha256（任一失配抛 `stale_revision`，零写入、且不制造新副本），把副本正文与 `title/summary/tags/aliases` 写回原文，保留原 id、`created`、`ember` 与其余 extra；提交前 `recordHistory` 原文原始字节。第二步删除副本：复核 hash 后 `vault_remove`（系统回收站）并 emit `removed`；删除失败或副本已变化不撤销原文写入，只返回 `copyRemoved: false` 并告警。原文缺失时抛 `doc_not_found`（孤儿冲突只能另存或删除副本）。`detachCopy` 清除副本的 `ember.conflictOf` 并保留 id/路径/正文，同样先记历史；非冲突副本、非 UTF-8 抛 `invalid_payload`，只读抛 `vault_locked`。
- **D14** `adopt` 只为缺少 id 的 `.md` 文件补写身份：仅当路径未入目录、文件为合法 UTF-8 且磁盘 sha256 等于 `expectedHash` 时写入；失配抛 `stale_revision` 且零写入。frontmatter YAML 损坏或已存在 id（含非法 id）抛 `invalid_payload`，不改写。写入保留正文、未知键与 BOM/行尾风格，补 `id`、缺失的 `created` 并刷新 `updated`；不记历史，成功后 emit `doc:changed`（`created`）。

---

## 3.1 HealthService（库健康检查）

```ts
export interface HealthService {
  scan(): Promise<HealthReport>;
  adopt(path: VaultPath, expectedHash: ContentHash): Promise<DocSnapshot>;
  renameMarkdown(path: VaultPath, expectedHash: ContentHash): Promise<VaultPath>;
}

export interface HealthIssue {
  kind: HealthIssueKind; // broken_frontmatter | missing_id | invalid_id | duplicate_id |
                         // non_utf8 | oversize | markdown_extension | broken_asset |
                         // broken_canvas | broken_history | symlink
  path: VaultPath;
  target: VaultPath | null;
  detail: string;
  hash: ContentHash | null;
  fix: 'adopt' | 'rename-markdown' | null;
}

export interface HealthReport {
  scannedAt: string;
  documents: number;
  issues: readonly HealthIssue[];
}
```

- **H1** `scan` 只经 `VaultPort.scan` / `read` / `stat`：以文件系统清单为入口，**不依赖 `docs.list()`**（否则漏掉坏 frontmatter 文档），扫描期间零写入。
- **H2** 超过 32 MiB 的文件只报 `oversize`，不读取；符号链接只报 `symlink`，不跟随、不读取目标。
- **H3** 只开放两类修复：缺失 id 的 `adopt`（委托 D14）与 `.markdown` → `.md` 改名；坏 YAML、非 UTF-8、非法/重复 id、失效资产、坏画布/历史、符号链接只报告。
- **H4** 修复前复核 path + 字节 sha256：失配抛 `stale_revision` 且零写入；改名目标已存在抛 `path_exists`，不覆盖；只读抛 `vault_locked`。
- **H5** `renameMarkdown` 只改文件名、不改内容；成功后 `docs.refresh()`，有合法 id 的文档随即进入目录，仍缺 id 的下次扫描继续报 `missing_id`。

---

## 4. IndexService（v2：内核内存实现）

```ts
export interface IndexService {
  document(id: DocId): Promise<IndexedDocument | null>;
  search(query: SearchQuery): Promise<SearchResult>;
  outbound(id: DocId): Promise<readonly LinkRecord[]>;
  backlinks(id: DocId): Promise<readonly LinkRecord[]>;
  referencesByRaw(raw: string): Promise<readonly LinkRecord[]>; // 附件被引用位置
  stats(): Promise<IndexStats>;
  rebuild(): Promise<IndexStats>;
  watch(listener: (event: IndexEvent) => void): Disposable;
}
```

- **N1** 元数据阶段：`docs.list()` 快照即时建（标题/标签/别名/简介可搜）；正文阶段后台逐篇推进（每批 8 篇让出一个宏任务）。
- **N2** 中文切分：相邻二元组（bigram）+ 单字 + 拉丁词；不依赖外部词典；`tokenizerVersion: 1`。
- **N3** 链接解析顺序：路径 → 文件名（最短路径优先）→ 标题 → 别名 → unresolved；歧义按 `settings.linkOverrides` 消解。链接边存 `targetId`（身份），不是路径。
- **N4** `doc:changed` 增量维护；`removed` 直接摘除条目。
- **N5** 数据全部可重建：设置页手动重建 + 启动后首次访问懒启动完整构建。

---

## 5. CanvasHost（画布库）

```ts
export interface CanvasHost {
  list(): Promise<readonly CanvasSummary[]>;              // 含 nodeCount
  create(input: CreateCanvasInput): Promise<CanvasSummary>;
  open(id: CanvasId): Promise<CanvasSession>;             // 引用计数（V3）
  rename(id: CanvasId, title: string): Promise<CanvasScene>;
  duplicate(id: CanvasId, title?: string): Promise<CanvasSummary>;
  remove(id: CanvasId): Promise<void>;                    // 系统回收站；总览不可删
  ensureDefault(): Promise<CanvasSummary>;                // 主页解析（defaultCanvasId → 已有 → 新建「主页」）
  ensureOverview(): Promise<CanvasSummary>;               // 总览：自动对账 Portal 卡片
  apply(id: CanvasId, ops: readonly CanvasMutation[]): Promise<CanvasScene>;
  createArticle(input: CreateArticleInput): Promise<CreateArticleResult>; // 一步建文（含 purge 回滚）
  locateDoc(docId: DocId): Promise<readonly CanvasDocLocation[]>;
  locateAsset(assetPath: string): Promise<readonly CanvasAssetLocation[]>;
  bookmarks(): Promise<readonly CanvasBookmarkEntry[]>;
  hasHistory(id: CanvasId): Promise<boolean>;
  listHistory(id: CanvasId): Promise<readonly CanvasHistoryEntry[]>;   // 最多 5 版，1 为上一版
  readHistory(id: CanvasId, slot: number): Promise<CanvasHistoryPreview>; // 只读，不写盘
  restoreHistory(id: CanvasId, slot: number, hash: string): Promise<CanvasScene>;
  restorePrevious(id: CanvasId): Promise<CanvasScene>;                 // restoreHistory(id, 1) 包装
  registerLayer(layer: CanvasLayer): Disposable;
  registerNodeKind(spec: CanvasNodeKindSpec): Disposable;
  flush(): Promise<void>;
}
```

- **V1** 图层纯绘制：不得改场景、不得发 IPC。
- **V2** 持久化到 `.workbench/canvas/<id>.json`，与文档共用原子写端口；`schemaVersion: 1`。
- **V3** 同画布并发 `open` 共享同一会话（引用计数）。
- **V4** `apply` 批次 = 一次原子写；整批校验失败抛 `canvas_invalid`，内存与磁盘都不动。
- **V5** 内容变更落盘失败 → 内存回滚并重新广播。
- **V6** 视口变更 400ms 防抖落盘，不广播；`flush()` 强制落盘。
- **V7** 节点类型（v2 内置）：`doc`（正文在 .md）、`note`（自由文本）、`group`（分组）、`portal`（指向另一画布，meta.portalTarget/portalTitle/portalNodeCount）、`image`（meta.assetPath）。
- **V8** 视图书签：`CanvasScene.bookmarks`（`{id, name, viewport, filters}`）；`setBookmarks` mutation 原子写。
- **V9** 总览画布：`ensureOverview` 为每张画布保证一张 Portal 卡片（自动摆位、同步标题与节点数、清理失效目标）；卡片即 Portal，双击进入，面包屑返回。
- **V10** 画布删除后 `settings.ui.defaultCanvasId` 指向它时写 `null` 清除（主页回落）。
- **V11** 内容变更落盘前把当前磁盘版本轮转到 `.workbench/history/<canvasId>.<n>.json`，最多保留 5 版；纯视口变更不记录。`listHistory` 只读列出槽位（时间、节点数、sha256 指纹、是否可读），损坏快照仍列出但 `readable: false`；`readHistory` 只读预览，损坏抛 `canvas_invalid`。`restoreHistory` 先校验槽位（1..5，越界抛 `invalid_payload`）与快照指纹（不符抛 `stale_revision`，不写盘），通过后把当前版本推进历史再写回目标，恢复可逆；槽位不存在抛 `doc_not_found`。`restorePrevious` 是 `restoreHistory(id, 1)` 的无指纹预检包装。恢复同步内存并广播（会话已打开时在写队列内串行）。历史轮转不是跨文件事务，主画布仍由单文件原子写保证完整性。

---

## 6. CommandBus

- **K1** 重复 id 抛 `duplicate_command`；id 必须形如 `<namespace>.<verb>`。
- **K2** `execute` 永不抛错：返回 `{ ok: false, error }`（`command_not_found` / `command_reentrant` / 未绑定内核 / run 抛错）。
- **K3** 每 id 单飞：在飞期间再次执行返回 `command_reentrant`。
- **K4** `list()` 按 id 字典序稳定排序。
- **K5** v1 的 `withOwner`（能力归属）已随能力体系删除；`CommandDescriptor` 不再有 `owner` 字段。

---

## 7. KernelContext

```ts
export interface KernelContext {
  readonly env: KernelEnv;          // kernelVersion / vaultId / readonlyMode / readonlyReason
  readonly docs: DocService;
  readonly health: HealthService;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
  readonly events: EventBus;
  readonly log: Logger;
  readonly paths: PathTools;
  extend<T>(slot: ExtensionSlot<T>, value: T): Disposable;
}
```

事件表：`doc:changed`、`doc:conflict`、`index:updated`、`command:executed`、`settings:changed`、`canvas:changed`、`canvas:ui`。（`capability:state`、`vault:mode` 已随能力体系与心跳锁删除。）

`KERNEL_VERSION = '2.3.0'`：2.2.0 → 2.3.0 为 minor，`DocService` 新增 `adopt`，`KernelContext` 新增 `health`，`VaultPort` 新增只读 `scan`；既有方法签名与错误码不变。2.1.0 → 2.2.0 为 minor，`DocService` 新增 `adoptCopy` / `detachCopy` 两个方法，`DocMeta` 新增 `conflictOf`。2.0.0 → 2.1.0 为 minor，`DocService` 新增 `listHistory` / `readHistory` / `restoreHistory` 三个方法。相对 1.2.0 的 2.0.0 是 major：删除了 `articles` / `editor` / `capabilities` 三个服务与 `withOwner`，IndexService 语义变更。

---

## 8. 错误模型

`code` 是稳定契约，UI 只分支 code，不解析 message。v2 代码表：

`not_implemented` `doc_not_found` `path_exists` `path_outside_vault` `stale_revision` `invalid_frontmatter` `invalid_payload` `duplicate_id` `vault_locked` `vault_uninitialized` `index_unavailable` `command_not_found` `command_reentrant` `duplicate_command` `invalid_command_id` `duplicate_extension` `canvas_invalid` `io_failed` `startup_failed`

（`duplicate_capability` `capability_failed` `duplicate_slot` 已随能力体系与装饰槽删除。）

`code` 集合以 `src/kernel/errors.ts` 的 `EmberErrorCode` 为唯一来源，本节列表必须与它逐字一致。来源与含义：

| code | 产生方 | 含义 |
|---|---|---|
| `not_implemented` | TS | 能力/命令尚未接入（命令总线未绑定上下文等） |
| `doc_not_found` | Rust / TS | 文档或文件不存在 |
| `path_exists` | Rust / TS | 目标路径已存在（create / rename 不覆盖） |
| `path_outside_vault` | Rust | 路径越出库根 |
| `stale_revision` | TS | 写入携带的 `base.hash` 与磁盘不一致 |
| `invalid_frontmatter` | TS | frontmatter 超限或类型非法（不阻断读取） |
| `invalid_payload` | Rust / TS | 编码非法、序列化失败、写入载荷类型非法 |
| `duplicate_id` | TS | 同一库内 id 冲突 |
| `vault_locked` | Rust / TS | 库未获得写锁或以只读模式打开，写操作被拒绝 |
| `vault_uninitialized` | Rust | 库尚未初始化 |
| `index_unavailable` | TS（契约保留） | 索引不可用；当前内存索引实现没有该错误的产生路径 |
| `command_not_found` | TS | 命令未注册 |
| `command_reentrant` | TS | 命令执行期间重入同一命令 |
| `duplicate_command` | TS | 命令 id 重复注册 |
| `invalid_command_id` | TS | 命令 id 不符合 `<namespace>.<verb>` |
| `duplicate_extension` | TS | 扩展槽重复注册 |
| `canvas_invalid` | TS | 画布场景/变更非法或总览画布缺失 |
| `io_failed` | Rust | 磁盘 IO 失败（含带绝对路径的 `IoAt`） |
| `startup_failed` | Rust | 启动期无法建立可用库（身份损坏/版本不支持） |

### 8.1 错误码已知限制

| 项 | 当前行为 | 为什么不修 |
|---|---|---|
| Rust 上限无法被 TS 自动引用 | `MAX_VAULT_READ/WRITE_BYTES`（32MB）、`MAX_MACHINE_UI_BYTES`（1MB）、`MAX_ASSET_BYTES`（20MB）只存在于 Rust 常量；UI 若需展示具体数值只能镜像一份并人工同步。 | 要把上限下发前端需新增 IPC/契约字段，超出本轮范围；数值本身稳定，人工同步成本低于新增命令。 |
| 一个 code 覆盖多种原因 | `invalid_payload` 同时表示编码非法（`Encoding`）与序列化失败（`Serde`）；`io_failed` 同时表示无路径与带路径（`IoAt`）两类 IO 失败。 | 拆 code 会改动 Rust、TS、契约与全部相关测试，且用户可见文案不变；`message` 已带区分信息。 |

只读原因收敛为两态（Rust `ReadonlyReason`，camelCase）：`lockedByOther`（被占用）/ `lockLost`（丢失，契约保留态）。

---

## 9. 启动顺序

1. Rust：`Vault::open`（身份文件 → 独占创建抢锁 → pid 存活判定 → 启动清扫）→ watcher 线程。
2. TS：events → commands → settings → docs → index（懒启动）→ canvas（注入 docs）→ 绑定上下文。
3. `docs.flush()` → watcher 对账订阅。
4. 中途失败即抛出，不允许半初始化进入可写状态；抢不到锁 = 只读观察者（`lockedByOther`），永远不「无锁写入」。

---

## 10. 非目标

- 无权限沙箱、无插件热加载、无多窗口上下文共享、无跨会话 undo 持久化。
- 无自动三方合并（基线不符一律冲突副本）。
- 无运行期锁失守通知（锁持有即贯穿会话）。
- 画布不做演示模式、不做实时协作、不承载正文。

---

## 11. 备份（内核之外）

整库导出与导出包预检全部在 Rust `vault/backup.rs`，不进内核服务图，也不改变写路径：

| 命令 | 语义 |
|---|---|
| `vault_backup_default_destination` | 返回库外默认导出目录，前端只用来预填输入框 |
| `vault_backup_export` | staging → 逐文件复核 → 原子改名；只读库也允许 |
| `vault_backup_inspect` | 只读导出包，返回 `restorable` 与 `issues[]`（error / conflict / warn） |

约束：导出不经过 `DocService` 队列，因此外壳必须先 `flushFloatEditors()` → `docs.flush()` → `canvas.flush()` →
`settings.flush()` 再发命令；命令本身仍会复核每个源文件的 hash，导出期间的外部改动会让整次导出失败而不是产出半新半旧的包。
导出包格式与目录映射见 `docs/vault-format.md` §11。
