# Ember Vault Format v1

> 状态：草案冻结候选（v1）。本文件是**库内文件格式的唯一规范源**。
> 标记约定：`[事实]` = 由外部约束或既有事实决定；`[设计选择]` = Ember 自己的决定，可以改，但改动必须同步本文件与迁移逻辑。

---

## 1. 范围与总原则

本规范定义：

1. Markdown 文档的 frontmatter 键；
2. `.workbench/` 目录的内容 schema；
3. 导出包的 `manifest.json` 契约；
4. 冲突副本命名规则；
5. 原子写流程（v2 已移除 journal，见 §6.2）；
6. 库锁；
7. 派生索引的存储位置与中文分词取舍。

总原则：

- **P1 文件是唯一真相源。** 任何界面状态都可以从文件重建；数据库、内存模型、窗口布局都不是真相。
- **P2 未知内容不丢弃。** 不认识的 frontmatter 键、不认识的 `.workbench/` 文件，读写时必须原样保留（语义级往返，见 §4.6）。
- **P3 写入必须可恢复。** 进程在任意时刻崩溃，磁盘上只能是「旧内容」或「新内容」，不能是半截内容。
- **P4 不静默覆盖。** 检测到外部修改（基线不一致）时，落盘冲突副本（§10），不覆盖任何一方的独有内容。
- **P5 路径不是身份。** 文档身份是 frontmatter `id`（§3）。所有跨文件引用登记为 id，而不是路径。

---

## 2. 目录布局

```
<vault>/
├── .workbench/                  # 工作台状态（进库，参与同步，不参与索引）
│   ├── settings.json
│   ├── canvas/<canvasId>.json
│   ├── history/<canvasId>.<n>.json # 画布历史，n=1 为上一版，最多 5 版
│   ├── history/documents/<docId>/  # 文档历史：index.json + <versionId>.md（§8.2.1）
│   └── .lock                    # 库锁，见 §7（独占创建 + pid 存活；无心跳无 journal）
├── notes/                       # 任意用户目录结构，Ember 不干预
│   └── 某文档.md
├── inbox/                       # 快速收集箱默认目录；只是普通 Markdown 目录（§13 非事务）
└── media/                       # 图库内容寻址存储（只能经 asset_save 写入）
```

删除优先移入操作系统回收站；不可用时依次降级为 Finder 代删与库内回收目录 `.workbench/trash/<ULID>/`，任何路径都不永久删除（库内副本 30 天后由启动清扫回收，详见 §8.3）。

不在库内、由 Ember 管理的位置：

```
~/Library/Application Support/Ember/
├── machine-id                   # 机器标识（库锁与 machines 目录共用）
└── machines/<machineId>/
    └── ui.json                  # 机器本地 UI 状态，见 §8.4

索引在 v2 是内核内存实现（见 §9），不再落 sqlite 文件；崩溃或损坏由 rebuild 一次恢复。
```

`[事实]` macOS 上 `Application Support` 随用户迁移，但不随库同步；这正是「机器状态」与「库状态」分家的原因。

`[设计选择]` 忽略规则：`.workbench/`、`.` 开头的目录、`node_modules/`、`.git/` 不进入 Markdown 索引；watcher 只监听库内 `.md` 文件，同样跳过 `.workbench/` 与所有点开头路径（含 `.lock`），避免自我触发。

---

## 3. 文档身份

### 3.1 id 是 ULID

`id` 取 **ULID**：26 字符，Crockford Base32，前 10 字符为 48 位毫秒时间戳，后 16 字符为 80 位随机数。

`[事实]` ULID 字典序 = 时间序，适合作为稳定排序键。

规则：

- `id` 一旦写入，**永不改变**。重命名、移动目录、内容改写都不改 `id`。
- 同一库内 `id` 必须唯一。`[设计]` 判重归索引职责，但索引尚未接入（§9）：v1 由 `doc-service.refresh()` 在目录对账时兜底判重，保留先收录者并告警，写盘路径不做全库扫描。
- 新建文档时由 `doc-service` 生成，采用**同进程单调**策略：同一毫秒内随机部分递增，保证同一毫秒创建的多个文档仍可按创建顺序排序。

### 3.2 路径只是定位符

- 路径是 vault 相对路径，POSIX 分隔符，不允许 `..`、不允许绝对路径、大小写敏感（`[事实]` APFS 默认大小写不敏感，因此索引额外记录 `path_folded` 用于查找，但比较规则以实际磁盘为准）。
- 文件名冲突后缀（§10）不参与 title 派生：`方案 (conflict 20261111T103205Z-7F3K).md` 的 title 仍是 `方案`，除非 frontmatter 显式写了 `title`。

### 3.3 缺 id 的文档（adoption）

> **实现状态（v1 已实现，仅显式入口）**：`refresh()` 仍只跳过缺 id（或 frontmatter 损坏）的文档并输出告警，
> 不标记 `needs_adoption`，`DocMeta.flags` 恒为全 `false`。adoption 只能从「库健康检查」面板显式触发
> （`DocService.adopt`，携带扫描时的字节 hash）；仍**没有后台自动改写**。非法 id 与坏 YAML 不在 adoption 范围。

`[设计选择]` 从 Obsidian 或纯文本目录导入的文档没有 `id`。Ember **不在后台静默改写文件**，而是：

1. 库健康扫描把缺 id 的文档标为 `missing_id`，列出路径与可执行的 adoption；
2. 用户确认「纳入库管理」时，`doc-service` 以带 `expectedHash` 的写入流程补写 `id`、缺失的 `created` 与 `updated`；
3. 写入前重新校验磁盘 hash，若期间被外部修改则取消（`stale_revision`），零写入。

理由：后台改写会让用户的 Git 工作区出现无法解释的 diff，也会与同步工具打架。

---

## 4. frontmatter 定义

### 4.1 形态

```yaml
---
id: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2
title: 方案
summary: 这份方案解决索引重建慢的问题
tags: [研发, 架构]
aliases: [plan, 技术方案]
created: 2026-11-11T02:15:00Z
updated: 2026-11-11T03:40:12Z
---
```

- 必须位于文件首字节处的 `---` 与 `---` 之间；BOM 会被剥离后再判断。
- 解析器只接受 YAML 文档形式；多文档 YAML（`---` 分隔多段）视为格式错误，文档降级为「无 frontmatter + 原始文本」，并产生 `frontmatter.invalid` 诊断。

### 4.2 键定义

| 键 | 类型 | 必填 | 默认值 | 维护者 | 语义 |
|---|---|---|---|---|---|
| `id` | ULID 字符串 | 是（adoption 后） | 无 | doc-service | 文档身份，不可变。 |
| `title` | string | 否 | 文件名去扩展名、去冲突后缀 | 用户 | 显示名，**不唯一**，不参与身份判定。 |
| `summary` | string | 否 | 无（展示层从正文首段派生） | 用户 | 文章简介，≤280 字符。画布文章节点与非索引列表用它做一行摘要；缺失时不回写磁盘。 |
| `tags` | string[] | 否 | `[]` | 用户 | 标签。比较时 NFKC + 小写 + 去前导 `#`。 |
| `aliases` | string[] | 否 | `[]` | 用户 | 链接别名，用于 `[[别名]]` 解析。 |
| `created` | ISO-8601 UTC | 否 | 首次见到该文档的时间 | doc-service | 只在缺失时写入一次，之后不再改写。 |
| `updated` | ISO-8601 UTC | 否 | 首次写入时间 | doc-service | 每次成功提交写入后刷新。 |
| `ember.*` | 任意 | 否 | 无 | Ember | 保留命名空间。v1 只使用 `ember.conflictOf`（§10.3）、`ember.schemaVersion`。 |
| 其它任意键 | 任意 | 否 | 无 | 用户/其它工具 | 原样保留（§4.6），v1 不解释。 |

### 4.3 取值约束

- `id`：必须匹配 `^[0-9A-HJKMNP-TV-Z]{26}$`（Crockford Base32，排除 I/L/O/U）。不匹配的非空 `id` 视为**格式错误**：文档可读，但索引标记 `id_invalid`，不参与双链目标登记，避免污染引用图。
- `tags` / `aliases`：数组元素必须是字符串；出现非字符串元素时整键降级为无效（保留原值，索引不采用），并产生诊断。
- `created` / `updated`：必须是带时区的 ISO-8601；解析失败即视为缺失，由 doc-service 补写。统一输出 `YYYY-MM-DDTHH:MM:SSZ`（秒级，UTC），避免无谓 diff。
- `summary`：必须是不超过 280 字符的字符串；非字符串或超长视为**用户错误**，该键降级为「无 summary」并产生 `summary_invalid` 诊断。**不阻断读取**：旧文档没有该键属于正常情况，不产生任何诊断，只在需要展示简介时按「正文第一个非空段落（跳过标题行、列表符号、代码块与图片）→ 压成一行 → 截 120 字符」派生，派生值不回写磁盘。
- 字符串长度上限：`title` 512 字符，`summary` 280 字符，`tags`/`aliases` 每项 256 字符，`id` 固定 26。超限截断写入是被禁止的——超限视为用户错误，写入直接失败并返回 `invalid_frontmatter`。

### 4.4 写入顺序

`[设计选择]` 序列化时固定键顺序：`id, title, summary, tags, aliases, created, updated, ember.*, 其余键按字母序`。目的是让「格式化」操作不产生无意义 diff，也让用户手写的键顺序变化不引起内容 hash 抖动。这是**格式规范化**，不是内容修改：规范化只发生在 doc-service 真正写入该文档时，不在读取时发生。

### 4.5 时间语义

- 所有时间戳以 UTC 存储，展示层按用户时区渲染。
- `updated` 由 doc-service 在**提交成功后**写入；如果写入内容与磁盘内容仅有 `updated` 差异，则跳过写入（避免自我触发的写入风暴）。
- 外部编辑器修改文件时，doc-service 不追写 `updated`；索引记录文件 `mtime` 与内容 hash，`updated` 保持文件内声明值。这是有意为之：外部修改的事实由 mtime 表达，不篡改用户文件。

### 4.6 未知键保留

`[设计选择]` 往返保真是**语义级**的，不是字节级：

- 未知键的解析值必须原样写回（字符串、数字、布尔、数组、嵌套映射）；
- 注释、缩进风格、引号风格不保证保留（YAML 重新序列化会丢注释）；
- 正文不做 Markdown 重排（不重新格式化、不重排列表），但**并非逐字节原样**：落盘前会按原文件的字节风格还原。

写入端的字节风格规则（实测行为，2026-11 起）：

| 情形 | 行为 |
|---|---|
| BOM | **保留**：原文件有 UTF-8 BOM，写入后仍有；原来没有则不加 |
| 统一 CRLF | **保留**：保存后整篇仍是 CRLF，不出现裸 LF |
| 统一 LF | 保持 LF |
| 混合行尾 | **写回统一 LF**（已知限制：编辑器只给一份正文，无法反推逐行风格） |
| 非法 UTF-8 | **拒绝写入**：`invalid_payload`，磁盘字节一字节不动；`rename`/`remove` 不受限 |
| 正文内容 | 不做重排；制表符、行尾空白、`\u0000`、NFC/NFD 均原样保留 |

`hash` 仍按**落盘真实字节**计算（不是 canonical 文本的 hash），并发写入的过期判定不受风格还原影响。

已知限制（必须在 UI 说明，不隐藏）：

- 用户写在 frontmatter 里的 YAML 注释会在 Ember 写入该文档时丢失。
- 混合行尾文件在任意写入后统一为 LF。
- 导入时源文件的 BOM 不会带入库（导入按库规范新建文件；源文件本身不被修改），正文的 CRLF 会保留。
- 撤销删除会按库规范重建文件：保留正文，但行尾为 LF、无 BOM。

---

## 5. 双链语法与解析

### 5.1 语法

```
link       := "!"? "[[" inner "]]"
inner      := target ( "|" label )?
target     := path? ( "#" anchor )?
anchor     := heading-text | "^" block-id
```

示例：

| 写法 | 含义 |
|---|---|
| `[[方案]]` | 按路径/标题/别名解析到文档 |
| `[[notes/方案.md]]` | 显式路径优先 |
| `[[方案#风险]]` | 指向标题「风险」 |
| `[[方案#^b7f2]]` | 指向块 id `b7f2` |
| `[[方案\|技术方案]]` | 显示文本覆盖解析文本 |
| `![[图.png]]` | 嵌入（非 Markdown 资源按附件处理） |

约束：

- 内层长度上限 512 字符；`[[` 不嵌套；`\[\[` 为转义。
- 链接只在 Markdown AST 的 `text` / `inlineCode` 之外的位置识别（代码块、行内代码、数学公式内的 `[[` 不解析）。`[事实]` Obsidian 行为一致，且能避免代码示例被误登记。
- `[事实]` 该语法与 Obsidian 的 wikilink 兼容子集一致；Ember 不写 `[[...]]` 之外的私有链接语法，保证库可以被 Obsidian 直接打开。

### 5.2 解析顺序（必须确定性）

按下表逐级尝试，命中即停：

1. **显式路径**：target 含 `/` 或 `.md` 后缀 → 以 vault 根为基准做相对路径匹配（先精确，再大小写折叠）。
2. **同名文件**：target + `.md` 作为 basename 匹配；多命中时取**路径最短**者，仍并列则按路径字典序最小者。
3. **标题**：`title` 归一化（NFKC + 小写 + 去首尾空白）后相等。
4. **别名**：`aliases` 归一化后相等。
5. **未解析**：登记 `resolver = 'unresolved'`，不猜测、不改写原文。

当某一级出现多个候选且无法用上述规则决胜时，登记 `resolver = 'ambiguous'` 并保存**全部候选 id**。UI 必须让用户选择；选择结果存进 `settings.json` 的 `linkOverrides`（键为 `sourceId + rawTarget`），不改写正文。

### 5.3 登记形态

解析在索引构建时发生，落库为边：

```ts
// 索引内存形态（kernel LinkRecord，见 §9）
{ srcId, targetId, raw, kind: 'link' | 'embed', resolver, anchor, line }
```

不变量：**链接边指向 id，不指向路径**。文档重命名后，只要目标 `id` 不变，反链无需重算（仅显示路径需要刷新）。

---

## 6. 原子写

### 6.1 原子写步骤（单文件）

目标：崩溃只可能留下「旧内容」或「新内容」。

1. 校验：目标路径在当前 vault 内、目标不是目录、未越过符号链接根。
2. 在**目标同目录**创建隐藏临时文件 `.{原文件名}.ember-tmp-<纳秒时间戳>-<进程内自增计数>`（同目录保证 rename 在同一文件系统，`rename(2)` 才是原子的；文件名含 `.ember-tmp-` 供 §8.3 清扫识别）。
3. 写入完整字节 → `write_all` → `fsync(temp_fd)` → `close`。
4. `rename(temp, target)`（覆盖语义，POSIX 原子）。
5. `fsync(target_dir)`（`[事实]` 不 fsync 目录，rename 的目录项可能在掉电后丢失）。
6. 写入返回后由索引层异步刷新对应文档行（内容 hash、mtime、size；kernel-contract 契约）。

权限与元数据：`[设计选择]` 新文件继承父目录 umask；替换已有文件时在 rename 前把原文件的权限位（含 setuid/setgid/sticky）复制到临时文件，避免权限被重置。复制失败（读取原文件元数据出错或设置临时文件权限失败）视为本次写入失败：临时文件被删除、目标保持旧内容，不降级为按 umask 新建。

### 6.2 为什么没有 journal

`[设计选择]` v1 曾用两阶段 journal 维持「文档 + 目录 + 索引」跨文件一致；v2 架构下三个前提消失了，journal 连同它的恢复/压缩/损坏降级一起删除：

- 索引是派生数据，可随时重建（§9）——不再需要跨文件一致；
- 画布只是布局（§8.2），损坏可接受，重建画布或卡片即恢复；
- 正文唯一真相在文件本身——「禁止静默覆盖」由 §10 的冲突副本保证，不由 journal 保证。

崩溃残留的清理交给两个既有机制：§6.1 的原子写保证「旧内容或新内容」二选一；§8.3 的启动清扫回收超龄孤儿临时文件。`vault_write` 直接走 `atomic::write_atomic`，与设置、锁、图片共用同一套临时文件 + fsync + rename + 目录 fsync 流程。

---

## 7. 库锁与多实例

锁文件：`<vault>/.workbench/.lock`

```json
{"vaultId":"01JB...","pid":48213,"machineId":"01JB...","startedAt":"2026-11-11T03:00:00Z","app":"0.1.0"}
```

`[设计选择]` v2 把锁从「心跳 + 租约 + fencing + 接管认领」收敛为**独占创建 + pid 存活 + 失效清理**——
这是分布式系统的机制，单机个人库只需要进程级互斥；只读原因从 5 种收敛为 2 种（被占用 / 丢失）：

- 获取：`open(O_CREAT|O_EXCL)` 独占创建。已存在则读载荷判 pid：pid 存活 → 被占用（`lockedByOther`），
  新实例以只读观察者打开（可搜索、可渲染、不可写），绝不「写但不加锁」。
- 失效清理：pid 已死或载荷损坏（半截 JSON）→ 崩溃遗留，直接删除锁文件后重试独占创建（最多 3 次；
  连续失败说明并发窗口内出现了活跃锁，按被占用返回）。删除即清理，无接管副本、无租约代次。
- Drop：只删除 `pid` + `machineId` + `vaultId` 都与自己一致的锁文件，不误删后来者。
- 运行期不失守：锁一旦持有即贯穿整个会话（pid 存活期间无人能接管），不再有心跳线程、写前租约校验
  与 `vault://mode` 事件；只读状态在启动时确定后不变。
- pid 探测：`/bin/kill -0 <pid>`，无 libc 依赖；探测命令不可用时保守视为存活，避免误抢锁。

watcher 跳过整个 `.workbench/`（因此也天然忽略 `.lock`），避免自我触发。

---

## 8. `.workbench/` schema

通用约定：所有 JSON 文件都带 `schemaVersion`（整数，当前为 `1`），未知版本 ≥ 当前应用支持版本时**拒绝写入**并提示升级应用；低于当前版本时按迁移链升级，升级前先写 `.workbench/backup/<name>.<ts>.json`（迁移链尚未实现，未知版本按拒绝处理）。

> **实现状态（v1 部分未实现）**：`vault.json` 读到未知/缺失 `schemaVersion` 时 `Vault::open` 返回可读错误，
> 启动页显示「启动失败 + 原因」（不再 panic），但**没有迁移链、也没有升级前备份**；`settings.json` 由
> 内核按默认值容错，`ui.json` 读到更高版本时整会话禁写（§10.3）已实现。

所有写入同样走 §6.1 原子写；`.workbench/` 下的文件不参与 Markdown 索引。

### 8.1 settings.json

```json
{
  "schemaVersion": 1,
  "vault": { "id": "01JB8ZQ3K4M5N6P7Q8R9S0T1V2", "name": "我的库", "createdAt": "2026-11-11T02:00:00Z" },
  "ui": {
    "defaultCanvasId": "01JB8ZQ3K4M5N6P7Q8R9S0T1V5",
    "overviewCanvasId": "01JB8ZQ3K4M5N6P7Q8R9S0T1V7",
    "recentCanvasIds": ["01JB8ZQ3K4M5N6P7Q8R9S0T1V5"],
    "canvasGrid": { "size": 8, "snap": true },
    "floatLimit": 5,
    "toolPomodoro": false,
    "toolGallery": false,
    "theme": "ember-black"
  },
  "linkOverrides": { "01JB...源文档id::方案": "01JB...目标id" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `vault.id` | ULID | 库身份，用于导出与冲突检测。 |
| `ui` | object | 允许自由扩展，未识别键保留。 |
| `ui.defaultCanvasId` | ULID 或缺失 | 主页画布（「主页固定」）。缺失或指向不存在的画布时，启动流程重新解析并写回；画布被删时由内核写 `null` 清除。 |
| `ui.overviewCanvasId` | ULID 或缺失 | 总览画布（卡片即 Portal，内核自动对账）。缺失时 `ensureOverview` 重建。 |
| `ui.recentCanvasIds` | string[] 或缺失 | 最近访问的画布 id，新在前，最多 10 条。 |
| `ui.canvasGrid` | `{ size: 8\|16\|32, snap: boolean }` | 画布网格尺寸与吸附。缺失时默认 `{ size: 8, snap: true }`。 |
| `ui.floatLimit` | number | 文档浮窗上限，1–12，默认 5；满额时不自动关闭任何窗口，先提示用户，用户显式确认后再挤掉最久未激活的一扇。 |
| `ui.editorLineNumbers` | boolean | 文稿编辑器行号；缺失时默认开启（`!== false`）。 |
| `ui.toolPomodoro` | boolean | 左下角番茄钟入口（能力化，默认关）。 |
| `ui.toolGallery` | boolean | 左下角附件面板入口（能力化，默认关；键名沿用旧图库命名）。 |
| `ui.theme` | `"ember-black"` | 主题标识；仅纯黑主题。 |
| `linkOverrides` | map<string, DocId> | 歧义链接的用户裁决，键为 `sourceId::rawTarget`。 |

`[设计选择]` 这些键属于**库状态**而不是机器状态：换一台机器打开同一个库，画布导航与主题行为一致。窗口位置、缩放、AI 面板几何、每画布开关等机器相关状态不走 `settings.json`，见 §8.4。

### 8.2 canvas/<canvasId>.json

```json
{
  "schemaVersion": 1,
  "id": "01JB8ZQ3K4M5N6P7Q8R9S0T1V5",
  "title": "主页",
  "createdAt": "2026-11-11T02:10:00Z",
  "updatedAt": "2026-11-11T03:00:00Z",
  "viewport": { "x": -120, "y": -40, "zoom": 1.25 },
  "grid": { "size": 8, "snap": true },
  "nodes": [
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W1", "kind": "doc", "docId": "01JB8ZQ3K4M5N6P7Q8R9S0T1V3", "text": null, "x": 120, "y": 80, "w": 320, "h": 200, "z": 1, "groupId": null, "meta": { "color": null } },
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W2", "kind": "note", "docId": null, "text": "待定", "x": 520, "y": 80, "w": 240, "h": 120, "z": 2, "groupId": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W3", "meta": {} },
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W3", "kind": "group", "docId": null, "text": "内核", "x": 80, "y": 40, "w": 900, "h": 400, "z": 0, "groupId": null, "meta": { "color": "primary" } },
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W5", "kind": "portal", "docId": null, "text": null, "x": 960, "y": 80, "w": 320, "h": 220, "z": 1, "groupId": null, "meta": { "portalTarget": "01JB8ZQ3K4M5N6P7Q8R9S0T1V6", "portalTitle": "子画布", "portalNodeCount": 12 } },
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W6", "kind": "image", "docId": null, "text": null, "x": 120, "y": 360, "w": 320, "h": 200, "z": 1, "groupId": null, "meta": { "assetPath": "media/ab/01JB....png" } }
  ],
  "edges": [
    { "id": "e_01JB8ZQ3K4M5N6P7Q8R9S0T1W4", "from": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W1", "to": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W2", "label": "依赖", "arrow": "end", "kind": "relation", "meta": {} }
  ],
  "bookmarks": [
    { "id": "bm_01JB8ZQ3K4M5N6P7Q8R9S0T1W7", "name": "写作视角", "viewport": { "x": -120, "y": -40, "zoom": 1.25 }, "filters": { "tags": ["研发"], "kinds": ["doc"], "text": "", "mode": "dim" } }
  ],
  "capabilityData": {}
}
```

多画布与空间（v2）：

- 画布库：`list/create/rename/duplicate/remove`；删除进系统回收站；总览画布不可删。
- 总览画布：`settings.ui.overviewCanvasId` 指向的一张特殊画布；内核 `ensureOverview` 自动为每张画布维护一张 `portal` 卡片（摆位、标题、节点数对账，失效目标清理）——**卡片即 Portal**，双击进入，面包屑返回。
- 主页固定：`settings.ui.defaultCanvasId`；画布删除时由内核写 `null` 清除。
- 节点引用文档身份（`docId`），不引用路径：外部改名/移动不断链；文件被外部删除后节点保留灰色失效占位（右键可清理），从回收站放回自动恢复。
- 失效 `portal`（目标画布被删）保留灰色占位，总览对账时自动清理。

节点字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 画布内局部 id，形如 `n_<ULID>`，同一画布内唯一；不参与跨文件引用。 |
| `kind` | `"doc"` \| `"note"` \| `"group"` \| `"portal"` \| `"image"` | 是 | 节点类型。 |
| `docId` | ULID 或 null | doc 必填 | 关联文档。其余 kind 必须为 `null`。 |
| `text` | string 或 null | 否 | `note` 的正文、`group` 的标题；`doc`/`portal`/`image` 恒为 `null`。 |
| `x`/`y`/`w`/`h` | number | 是 | 世界坐标与尺寸，1 = 1 CSS px @ zoom=1；最小 160×100。 |
| `z` | integer | 是 | 同 `z` 按数组顺序；组永远绘制在所有非组节点之下，不依赖 `z` 比较。 |
| `groupId` | string 或 null | 否 | 所属组的节点 id。一个节点最多属于一个组；组不能嵌套组；必须指向存在的 `group` 节点。 |
| `meta` | object | 是 | 未知键保留。`meta.color` 取 token 名 `primary\|secondary\|success\|warning\|danger\|null`，**不落色值**；`meta.portalTarget/portalTitle/portalNodeCount` 为 portal 指向与展示；`meta.assetPath` 为 image 的库内 `media/` 路径（`asset_save` 去重后返回）。 |

视图书签：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 形如 `bm_<ULID>`，同一画布内唯一。 |
| `name` | string | 是 | 用户命名；一键跳回。 |
| `viewport` | `{x,y,zoom}` | 是 | 保存的镜头位置与缩放。 |
| `filters` | object 或 null | 否 | 保存的过滤条件：`tags`（标签数组）、`kinds`（节点类型数组）、`text`（关键词）、`mode`（`dim` 高亮 / `hide` 隐藏）。解析容错：坏一条跳过一条，不炸画布。 |

连线字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 形如 `e_<ULID>`，同一画布内唯一。 |
| `from`/`to` | string | 是 | 节点 id；必须是存在的非组节点，禁止自环。 |
| `label` | string 或 null | 是 | 关系标签，空字符串归一化为 `null`。 |
| `arrow` | `"none"` \| `"end"` \| `"both"` | 是 | 箭头样式，新建默认 `end`。 |
| `kind` | `"relation"` | 是 | v1 只有关系连线；其它类型留给能力。 |
| `meta` | object | 是 | 未知键保留。 |

分组语义（`[设计选择]`）：

- 成员关系用成员节点上的 `groupId` **显式表达**，不靠几何包含推断；移动组 = 同批移动其成员，删除组 = 解组并保留成员。
- 写入前校验整批：违反任一条则**拒绝整批写入**，抛 `canvas_invalid`，磁盘保持旧内容。
  1. 节点 id 唯一；2. `groupId` 指向存在的 `group` 节点且不自指、不嵌套；3. 边端点存在且非 group；4. 无自环；5. 同一 `(from, to)` 只允许一条边。

落盘规则：

- 任何显式 mutation 立即触发一次原子写（§6.1），一次 mutation 批次 = 一次写。
- `viewport` 变化 400ms 防抖落盘；会话关闭、窗口隐藏（`visibilitychange`）时强制 flush，保证「重启后视口保持」。
- `updatedAt` 随每次成功写入刷新。
- 内容变更落盘前把当前磁盘版本轮转到 `.workbench/history/<canvasId>.<n>.json`：`n=1` 是上一版，其余依次后移，最多保留 **5** 版；纯视口变更不生成历史。
- 历史槽位可由 `listHistory` 只读列出（`slot`、`updatedAt`、`nodeCount`、sha256 指纹、`readable`）；`readHistory` 只读预览，预览不打开会话、不写盘。损坏快照仍列出但标记 `readable: false`，预览/恢复抛 `canvas_invalid`。
- `restoreHistory(id, slot, hash)` 先把当前版本推进历史，再把目标槽位写回主画布，因此恢复可撤销；槽位越界抛 `invalid_payload`，槽位为空抛 `doc_not_found`，快照指纹与 `hash` 不符抛 `stale_revision` 且不写盘。`restorePrevious` 等价于恢复 `.1`（不做指纹预检）。恢复同步更新已打开会话的内存场景并广播。
- 历史文件与主画布分别使用单文件原子写；历史轮转和主画布写入**不是跨文件事务**，崩溃可能只完成部分轮转，主画布仍保证为完整的旧版或新版。
- 校验失败不写盘、不更新内存场景；命令返回 `ok: false` 与 `canvas_invalid` 文案。

### 8.2.1 文档历史（`history/documents/<docId>/`）

- 每次 `DocService.update` 提交主文前、以及 `restoreHistory` 写回目标版前，把当前磁盘文件的**原始字节**
  （含 BOM 与 CRLF）存为 `history/documents/<docId>/<versionId>.md`；`versionId` 为 ULID。
- 同目录 `index.json` 由内核整表原子写维护：
  `{ schemaVersion: 1, docId, versions: [{ versionId, path, hash, at, size }] }`，`versions` 新→旧。
  `hash` 是版本字节的 sha256，读取时与实际文件交叉校验。
- 保留策略：每篇文档最多 **20 版**、总字节最多 **64 MiB**，超出从最旧开始淘汰（永远保留最新一版）；
  淘汰的文件经内部 `vault_purge` 清理。历史写失败时本次主文不提交。
- 只有 `update`、`restoreHistory`、`adoptCopy`、`detachCopy` 记录历史；`create`、`rename`、冲突副本创建、`remove`、`purge` 都不记录。
- 预览只读、不写盘。恢复前重新校验 `base.hash`：一致则当前版先入历史再写回目标版原始字节（后续历史不删除）；
  失配则不改主文、不新增历史，把目标版内容写成冲突副本（kernel-contract D11）。
- 索引损坏（JSON 非法、schema 版本不符、任一条目非法）按「无历史」处理并告警，下次保存重建；
  已存在的版本文件成为孤儿，不阻断编辑。

### 8.3 删除与系统回收站

- `[事实]` 用户删除（`docs.remove`）优先把文件移入**操作系统回收站**（macOS：`NSFileManager.trashItemAtURL`）；系统回收站不可用时依次降级为 Finder 代删（`osascript`，落点仍是系统回收站）与库内回收目录 `.workbench/trash/<ULID>/`。任何路径都不调用 `fs::remove_file`，不会永久删除。
- `[设计选择]` 不做 id 重写：Ember 不再感知离开库的文件 id，重写没有收益。风险是用户从系统回收站还原、或从库内回收目录手动移回时，可能与库内同 id 文档并存——`refresh()` 按路径字典序保留先收录者并告警，不会改写任何文件（§10.5）。
- `[设计选择]` 应用内**没有**"从回收站恢复"的入口：系统回收站里的文件需在系统里恢复；库内回收目录的副本需在 30 天内手动移回（到期由启动清扫回收）。撤销只存在于本次运行内（重建文档，不从回收站取回），见 §10.5 与 AI 删除提案的文案。
- 降级语义：非本地卷（网络盘/云盘）、无法确认卷类型、回收站 API 报错或权限不足时逐级降级（Finder → 库内回收目录）；三级全部失败才报错，文件保持原样。非 macOS 平台明确报 `io_failed`（文案说明该平台不支持系统回收站），**绝不**回退为永久删除。
- 调用后校验：源路径必须消失；系统返回的 `resultingItemURL` 必须存在且不在库根内（回收站内文件名可能被改写，不能按原路径推断）。
- 文章创建后画布写入失败的回滚，以及画布历史轮转、文档历史淘汰的过期版本清理，共用内核内部入口 `Vault::purge` / `vault_purge`；不对用户暴露，也不注册为 `core.doc.purge` 命令（kernel-contract D4/I9）。
- 历史遗留：库内回收目录 `.workbench/trash/<ULID>/` 不迁移、不自动放回；持锁实例在 Vault::open 时执行惰性清扫，副本目录 mtime 超过 **30 天**整目录回收；全库孤儿 `.ember-tmp-` 临时文件（>24h）一并回收。清扫只记日志不影响启动，mtime 不可读按保守不删处理。
- 孤儿 temp 清扫**覆盖** `.workbench/` 内部：锁文件与设置写入的瞬时 temp 也在那里，24h 门槛远大于单次写入的存活时间，不会与 rename 竞态（§7 已无心跳与认领副本）。
- 数值提示：孤儿 temp（24h）与库内回收目录（30 天）的保留期以 `vault/mod.rs` 常量为准，改代码必须同步本文件。

### 8.4 machines/<machineId>/ui.json（机器本地，不在库内）

```json
{ "schemaVersion": 1, "floatSizes": {}, "floatPositions": {}, "pomodoro": {}, "ai": { "provider": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "" }, "translationChannel": "model", "panels": { "ai": { "x": 0, "y": 0, "width": 360, "height": 480 } }, "canvasFlags": { "01J...": { "recentEdits": true } } }
```

- 已知键：`floatSizes`、`floatPositions`、`pomodoro`、`ai`、`panels.ai`（仅 x/y/width/height，AI 面板已改为命令唤起）、`canvasFlags`（每画布 UI 开关，如最近编辑层）、`translationChannel`（`model` | `public`；缺省或非法值回落 `model`）。
- **AI 会话持久化（阶段 7）**：`machines/<machineId>/ai/<vaultId>.json` 存最近一次对话 turns、未应用 proposal、崩溃恢复中的 applying 状态；schemaVersion 当前 1，文件不存在或损坏时水合为空态；不持久化 UndoAction（跨重启撤销本期不做）、不持久化 API Key（钥匙串里）；备份不扫此目录、不进知识库索引。
- 历史遗留键（旧版 `recall`、`sidebarWidth`、`panels.ai.open`）不再是已知键，作为未知键原样保留。
- 序列化时未知顶层键与 `panels.*` 的他人子键**原样保留**，不做整体重写；对话与提案只存内存，不落盘。
- 读到更高 `schemaVersion` 时整会话禁止回写（旧版应用不得用默认态覆盖新版数据）。

---

## 9. 索引存储与检索

`[设计选择]` v2 索引是**内核内存实现**（`src/kernel/index-service.ts`），不再落 sqlite 文件：

- 元数据（标题/标签/别名/简介）在首次访问时从 `docs.list()` 即时建；
- 正文词组与链接关系后台逐篇增量（每批 8 篇让出一个宏任务）；`doc:changed` 增量维护；
- 中文按相邻二元组（bigram）+ 单字切分，拉丁按词，不依赖外部词典；`tokenizerVersion: 1`；
- 链接边存 `targetId`（文档身份），不是路径（§5.3）；
- `referencesByRaw(raw)` 按链接目标反查引用（附件面板「被引用位置」）；
- 索引可随时丢弃：设置页手动重建，或重启后自动重建（**任何功能不得依赖索引中存在未重建的数据**）；
- 反向链接由索引提供，shell 不再全库扫描正文。

将来数据量增大需要更强存储时，替换 index-service 内部实现即可——接口稳定，界面不改。

---

## 10. 冲突处理

### 10.1 触发条件

`doc-service` 每次写入都携带调用方读到的 `baseHash`。提交前重新读取磁盘：

- 磁盘 hash == `baseHash` → 直接原子写（快路径）。
- 磁盘 hash != `baseHash` → 进入三方合并：`base` = 调用方持有的基线内容，`local` = 调用方要写入的内容，`disk` = 当前磁盘内容。

`[事实]` 这里没有「强制覆盖」分支。`force` 参数不存在，避免调用方误用。

### 10.2 处理（v2：基线校验 + 冲突副本，无自动合并）

- 保存前比对 `base.hash` 与磁盘 hash：一致 → 直接原子写入，返回 `{ merged: true, conflictCopy: null }`。
- 不一致 → **两份都保留，磁盘版本一字节不动**：
  1. 本地改动（编辑区内容 + 补丁后的 frontmatter）完整写入冲突副本；
  2. 主文件保持磁盘版本；
  3. 返回 `{ merged: false, conflictCopy: { path, docId } }` 并 emit `doc:conflict`；UI 在标题区与状态栏常驻提示。
- 没有 diff3、没有冲突标记、没有 `too_large` 上限——任何大小的文件行为一致。

### 10.3 冲突副本命名

```
<stem> (conflict <YYYYMMDDTHHMMSSZ>-<XXXX>).md
```

- 时间取 UTC，紧凑格式，无冒号（`[事实]` macOS 允许冒号但会在 Finder 中显示为 `/`，故禁用）。
- `XXXX` 取冲突副本自身 ULID 的后 4 位，同一秒内多次冲突也几乎不会碰撞。
- 冲突副本的 `id` 必须**新生成**（否则与主文件重复），并写入 `ember.conflictOf: <原文档 id>`。
- 冲突副本的 `created` = 冲突发生时间，`title` 保留原 title（不加后缀，后缀在文件名上）。

示例：

```
notes/方案.md
notes/方案 (conflict 20261111T103205Z-7F3K).md
```

### 10.4 冲突解决（v2.2：显式采用 / 另存 / 删除）

冲突副本与普通文档一样参与索引和列表，`ember.conflictOf` 只表达归属；解决必须由用户显式触发。

- **并排查看**：外壳同时打开原文与副本两扇浮窗，供用户手动合并；内核不做自动合并。
- **采用副本**（`DocService.adoptCopy`，仅在原文存在时可用）：
  1. 分别复核副本与原文的磁盘 sha256，任一与用户所见修订不符即失败（`stale_revision`），零写入；
  2. 副本正文与 `title` / `summary` / `tags` / `aliases` 写回**原文**，保留原文 `id`、`created`、`ember` 与其余未知键；
  3. 写前把原文当前原始字节记入文档历史（§9）；
  4. 提交成功后再删除副本（系统回收站）；删除失败不回滚原文，结果标记 `copyRemoved: false`，由外壳明确提示手动删除。
- **另存为普通文档**（`DocService.detachCopy`）：清除副本的 `ember.conflictOf`，保留 `id`、路径与正文；用于原文已删除的孤儿冲突，或用户想保留副本但不再提示冲突。
- **删除副本**：走普通 `remove`（系统回收站），不触碰原文。
- **孤儿冲突**（原文已被删除）：只提供「另存为普通文档」与「删除副本」，不允许采用。
- 不自动合并、不自动清理；只读模式下所有解决动作被拒绝（`vault_locked`）。

### 10.5 id 重复

`[事实]` 复制文件（Finder 复制、同步工具冲突副本）会产生重复 `id`。策略：

- 索引允许存在重复 id 的行，但 `documents.id` 唯一约束会被违反 → 改为允许重复：主键为 `rowid`，`id` 建普通索引，另加 `id_canonical` 指向规范文档。
- 规范文档选择：`created` 最早者；相同则路径字典序最小者。
- 其余标记 `flags.bit2 = duplicate_id`，UI 提供「重新分配 id」命令（复用 adoption 流程，逐文件确认）。
  - **实现状态（v1 未实现）**：没有 `duplicate_id` 标记，也没有「重新分配 id」命令；`refresh()` 只按路径字典序保留先收录者并告警，
    不会改写任何文件。
- **禁止**在后台自动改 id——那会在用户不知情时改变外部工具的引用。
- 回收站还原也属于「复制产生重复 id」：还原后若库内已有同 id 文档，`refresh()` 只保留路径字典序先收录者并告警，不会改写文件。应用内不提供还原入口，用户需自行处理重复（v1 没有「重新分配 id」命令）。

---

## 11. 导出包 manifest.json

导出产出一个目录（zip 由 UI 层负责打包）：

```
Ember Export <vaultName> <YYYY-MM-DD>/
├── manifest.json
├── docs/…              # 保留相对路径
├── assets/…
└── .workbench/…        # 可选，见 manifest.includeWorkbench
```

`manifest.json`：

```json
{
  "format": "ember-export",
  "formatVersion": 1,
  "exportedAt": "2026-11-11T04:00:00Z",
  "app": { "name": "Ember", "version": "0.1.0" },
  "vault": { "id": "01JB8ZQ3K4M5N6P7Q8R9S0T1V2", "name": "我的库" },
  "includeWorkbench": true,
  "documents": [
    { "id": "01JB...", "path": "docs/方案.md", "title": "方案", "contentHash": "sha256:9f2c...", "size": 4211, "tags": ["研发"], "aliases": ["plan"] }
  ],
  "assets": [ { "path": "assets/diagram.png", "contentHash": "sha256:...", "size": 91234 } ],
  "workbench": { "canvas": ["01JB..."], "settings": true },
  "integrity": { "algorithm": "sha256", "files": { "docs/方案.md": "9f2c..." } }
}
```

契约：

- 字段只增不改；`formatVersion` 只在破坏性变更时递增。
- `documents[].contentHash` 与 `integrity.files[path]` 必须一致；导入时以 `integrity` 为准校验。
- 导入规则：校验 hash → 按 `id` 判重 → 冲突时不覆盖，导出报告列出 `conflicts[]`（不静默丢弃）。

### 11.1 实现现状（v1：导出 + 只读预检）

导出与预检由 Rust `vault/backup.rs` 独占实现，不经过索引，也不要求库可写（只读库可以导出）。

目录映射（冻结）：

| 库内来源 | 包内路径 |
|---|---|
| 任意目录下 `*.md`（排除 `media/`、点开头目录、`node_modules/`） | `docs/<库内相对路径>` |
| `media/**` | `assets/<media 下的相对路径>` |
| `.workbench/settings.json` | `.workbench/settings.json` |
| `.workbench/canvas/*.json` | `.workbench/canvas/…` |
| `.workbench/history/*` | `.workbench/history/**`（含 `documents/<docId>/` 嵌套目录与 `index.json`） |

排除：`.workbench/.lock`、`.workbench/trash/`、`.workbench/backup/`、`*.ember-tmp-*`、点开头的文件/目录。
机器本地状态（`machines/<machineId>/ui.json`、`ai/<vaultId>.json`、钥匙串）不在库内，结构上不会被导出。

导出流程：遍历拒绝符号链接 → 逐文件流式 SHA-256 写入 staging 目录 → 复核 staging 字节 → 复核源文件 hash
（导出期间被外部改动即整体失败）→ 最后写 `manifest.json` → `rename(staging, 目标)`。任何失败都会删除 staging，
目标父目录不留残包；目标必须绝对路径、位于库外、且不得已存在（不覆盖）。首版不打包 zip。

预检只读导出包、不写盘，结论分为三级：

- `error`（阻断恢复）：`invalid_format`、`unsupported_version`、`path_traversal`、`invalid_path`、
  `missing_file`、`hash_mismatch`、`not_a_file`、`symlink`、`invalid_manifest`。
- `conflict`（需人工处理，但不阻断）：`duplicate_id`、`invalid_id`、`duplicate_path`、`case_collision`。
- `warn`：`missing_id`（未 adoption 的文档）、`unlisted_file`（未登记在 integrity 的文件）。

`restorable = 没有 error`。首版没有回写恢复：预检只回答「这个包是否完整、有没有冲突」。

---

## 12. 版本与迁移

- 本规范的 schema 版本：`vaultSchemaVersion = 1`，写入 `settings.json.schemaVersion`。
- 迁移必须单向、可重入：迁移前备份到 `.workbench/backup/`，逐文件原子写，失败项单独报告。
- 迁移失败 → 库进入只读并提示，不留下「迁移了一半」的库。
- 索引不受库 schema 版本约束，但受 `tokenizer_version` 约束（§9.3）。

---

## 12.1 库健康检查

`[设计选择]` 体检是显式触发的一次性只读扫描，不是后台常驻任务。入口为设置页「检查库健康」或命令
`ember.panel.health`。

扫描以文件系统清单为入口（`vault_scan`），**不依赖文档目录**，因此坏 frontmatter、缺 id、`.markdown`、
符号链接都能被发现。覆盖：

- `.md`：坏 frontmatter、缺失/非法/重复 id、非 UTF-8、超过 32 MiB（不读取内容）；
- `.markdown`：不会被索引收录，可安全改名为 `.md`；
- 正文中的 `media/` 图片引用是否存在（外链不检查）；
- `.workbench/canvas/*.json`、`.workbench/history/<canvasId>.<n>.json`（n 仅 1..5）、
  `.workbench/history/documents/<docId>/index.json` 及其版本文件；
- 库内符号链接：只报告，不跟随、不读取目标。

只读保证：扫描期间不写盘。安全修复只有两类：

1. 缺失 id 的 adoption（`id` + 缺失的 `created` + 刷新 `updated`，正文不变）；
2. `.markdown` → `.md` 改名（内容不变，目标已存在则不覆盖）。

两类修复都要求扫描时的字节 hash 仍一致，否则取消并提示重新检查。坏 YAML、非 UTF-8、非法/重复 id、
失效资产引用、坏画布/历史、符号链接只报告定位，不自动改写。

---

## 13. 明确的非目标（v1）

- 不做多文档原子事务。
- 不做内容历史的 diff / 自动合并 / Git 集成（版本记录与恢复见 §8.2.1）。
- 不解析 Markdown 之外的格式（`.canvas` JSON Canvas 后续以能力形式接入，不进入内核）。
- 不在库内保存二进制大对象；附件是普通文件。
