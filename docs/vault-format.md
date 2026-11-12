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
5. 原子写与 journal 落盘流程；
6. 库锁；
7. 派生索引的存储位置与中文分词取舍。

总原则：

- **P1 文件是唯一真相源。** 任何界面状态都可以从文件重建；数据库、内存模型、窗口布局都不是真相。
- **P2 未知内容不丢弃。** 不认识的 frontmatter 键、不认识的 `.workbench/` 文件，读写时必须原样保留（语义级往返，见 §4.6）。
- **P3 写入必须可恢复。** 进程在任意时刻崩溃，磁盘上只能是「旧内容」或「新内容」，不能是半截内容。
- **P4 不静默覆盖。** 检测到外部修改且无法三方合并时，落盘冲突副本（§10），不覆盖任何一方的独有内容。
- **P5 路径不是身份。** 文档身份是 frontmatter `id`（§3）。所有跨文件引用登记为 id，而不是路径。

---

## 2. 目录布局

```
<vault>/
├── .workbench/                  # 工作台状态（进库，参与同步，不参与索引）
│   ├── settings.json
│   ├── canvas/<canvasId>.json
│   ├── mindmap/<mindmapId>.json
│   ├── ai/memory.jsonl
│   ├── ai/threads/<threadId>.json
│   ├── .lock                    # 库锁，见 §7
│   ├── .journal/                # 本库 journal（v1 权威位置，见 §6.2；App Support 副本为后续索引层预留）
│   └── trash/<ULID>/            # 软删除副本（docs.remove 落点），见 §8.6
├── notes/                       # 任意用户目录结构，Ember 不干预
│   └── 某文档.md
└── media/                       # 图库内容寻址存储（只能经 asset_save 写入）
```

不在库内、由 Ember 管理的位置：

```
~/Library/Application Support/Ember/
├── index/<vaultHash>.sqlite     # 派生索引，可删可重建，见 §9
├── journals/<vaultHash>.ndjson  # v1 未写入：后续索引层预留（见 §6.2）
├── machine-id                   # 机器标识（库锁与 machines 目录共用）
├── machines/<machineId>/
│   └── ui.json                  # 机器本地 UI 状态，见 §8.7
└── logs/
```

`[事实]` macOS 上 `Application Support` 随用户迁移，但不随库同步；这正是「机器状态」与「库状态」分家的原因。

`[设计选择]` 忽略规则：`.workbench/`、`.` 开头的目录、`node_modules/`、`.git/` 不进入 Markdown 索引；watcher 只监听库内 `.md` 文件，同样跳过 `.workbench/` 与所有点开头路径（含 `.lock`、`.journal/`），避免自我触发。

---

## 3. 文档身份

### 3.1 id 是 ULID

`id` 取 **ULID**：26 字符，Crockford Base32，前 10 字符为 48 位毫秒时间戳，后 16 字符为 80 位随机数。

`[事实]` ULID 字典序 = 时间序，适合作为 SQLite 主键与稳定排序键。

规则：

- `id` 一旦写入，**永不改变**。重命名、移动目录、内容改写都不改 `id`。
- 同一库内 `id` 必须唯一。`[设计]` 判重归索引职责，但索引尚未接入（§9）：v1 由 `doc-service.refresh()` 在目录对账时兜底判重，保留先收录者并告警，写盘路径不做全库扫描。
- 新建文档时由 `doc-service` 生成，采用**同进程单调**策略：同一毫秒内随机部分递增，保证同一毫秒创建的多个文档仍可按创建顺序排序。

### 3.2 路径只是定位符

- 路径是 vault 相对路径，POSIX 分隔符，不允许 `..`、不允许绝对路径、大小写敏感（`[事实]` APFS 默认大小写不敏感，因此索引额外记录 `path_folded` 用于查找，但比较规则以实际磁盘为准）。
- 文件名冲突后缀（§10）不参与 title 派生：`方案 (conflict 20261111T103205Z-7F3K).md` 的 title 仍是 `方案`，除非 frontmatter 显式写了 `title`。

### 3.3 缺 id 的文档（adoption）

> **实现状态（v1 未实现）**：`refresh()` 目前只跳过缺 id（或 frontmatter 损坏）的文档并输出告警，
> 不标记 `needs_adoption`，也没有「纳入库管理（adopt）」命令；`DocMeta.flags` 恒为全 `false`。
> 以下为设计目标，待后续版本实现。

`[设计选择]` 从 Obsidian 或纯文本目录导入的文档没有 `id`。Ember **不在后台静默改写文件**，而是：

1. 索引扫描时标记 `needs_adoption = 1`，该文档在列表里以「未纳入索引身份」标出；
2. 用户首次编辑或执行「纳入库管理（adopt）」命令时，`doc-service` 以带 `baseHash` 的普通写入流程补写 `id`；
3. 写入前必须重新校验磁盘 hash，若期间被外部修改，按普通冲突流程处理。

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
- 因此 doc-service 只在需要修改 frontmatter 时重写 frontmatter 块，正文部分逐字节保留（不做 Markdown 重排）。

已知限制（必须在 UI 说明，不隐藏）：用户写在 frontmatter 里的 YAML 注释会在 Ember 写入该文档时丢失。

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

```sql
-- links: 一条链接一行；embed 单独标记
CREATE TABLE links (
  src_id     TEXT NOT NULL,
  target_id  TEXT,            -- 可空：未解析
  raw        TEXT NOT NULL,   -- 原始 target 文本（不含 label）
  kind       TEXT NOT NULL,   -- 'link' | 'embed'
  resolver   TEXT NOT NULL,   -- 'path' | 'basename' | 'title' | 'alias' | 'ambiguous' | 'unresolved'
  anchor     TEXT,            -- 标题文本或 '^blockId'
  path_hint  TEXT,            -- 链接写的是显式路径时保留
  line       INTEGER NOT NULL
);
```

不变量：**链接边指向 id，不指向路径**。文档重命名后，只要目标 `id` 不变，反链无需重算（仅显示路径需要刷新）。

---

## 6. 原子写与 journal

### 6.1 原子写步骤（单文件）

目标：崩溃只可能留下「旧内容」或「新内容」。

1. 校验：目标路径在当前 vault 内、目标不是目录、未越过符号链接根。
2. 在**目标同目录**创建隐藏临时文件 `.{原文件名}.ember-tmp-<纳秒时间戳>-<进程内自增计数>`（同目录保证 rename 在同一文件系统，`rename(2)` 才是原子的；文件名含 `.ember-tmp-` 供 §8.6 清扫识别）。
3. 写入完整字节 → `write_all` → `fsync(temp_fd)` → `close`。
4. `rename(temp, target)`（覆盖语义，POSIX 原子）。
5. `fsync(target_dir)`（`[事实]` 不 fsync 目录，rename 的目录项可能在掉电后丢失）。
6. 写入返回后由索引层异步刷新对应文档行（内容 hash、mtime、size；kernel-contract D7）。

权限与元数据：`[设计选择]` 新文件继承父目录 umask；替换已有文件时在 rename 前把原文件的权限位复制到临时文件，避免权限被重置。

### 6.2 journal 两阶段

journal 是**追加写的 NDJSON**，路径 `<vault>/.workbench/.journal/journal.ndjson`（v1 以此为准；App Support 副本是后续索引层预留，见 §2 的 `journals/` 行）。一行一个事件。

事件 schema（`tx`、`phase`、`target`、`at` 必填；`temp` 在涉及临时文件的事务中出现，`kind` 仅在 `prepared` 出现）：

```json
{"tx":"01JB8ZQ3K4M5N6P7Q8R9S0T1V2","phase":"prepared","target":"notes/a.md","temp":"notes/.a.md.ember-tmp-1762839612456789000-7","kind":"user","at":"2026-11-11T03:40:12Z"}
{"tx":"01JB8ZQ3K4M5N6P7Q8R9S0T1V2","phase":"committed","target":"notes/a.md","temp":"notes/.a.md.ember-tmp-1762839612456789000-7","at":"2026-11-11T03:40:12Z"}
{"tx":"01JB8ZQ3K4M5N6P7Q8R9S0T1V2","phase":"cleaned","target":"notes/a.md","temp":"notes/.a.md.ember-tmp-1762839612456789000-7","at":"2026-11-11T03:40:12Z"}
```

`kind` 记录写入意图（`user` / `capability` / `migration` / `system`）。v1 不记录 `docId` 与内容 hash：journal 只用于判定事务是否完成，不作为内容恢复依据（§6.3）。

阶段：

| 阶段 | 磁盘动作 | 崩溃后的语义 |
|---|---|---|
| `prepared` | 临时文件已 fsync，journal 行已 fsync，目标**未**改变 | 可安全回滚：临时文件交给 §8.6 的 24h 孤儿清扫 |
| `committed` | rename + 目录 fsync 已完成，journal 行已 fsync | 新内容生效 |
| `cleaned` | 事务结束，临时文件已随 rename 消失（失败路径为显式删除） | 事务结束，可从 journal 裁剪 |

写入顺序严格为：`temp fsync` → `prepared fsync` → `rename` → `dir fsync` → `committed fsync` → `cleaned fsync`；索引刷新在写入返回后由索引层异步完成（kernel-contract D7），不阻塞 `cleaned`。

启动恢复算法（只诊断，不删除）：

1. 读全部事件，按 `tx` 分组、按行序取最后阶段（幂等，见 I14）。
2. 对「有 `prepared` 无 `committed`」的事务：rename 未发生或失败；临时文件不在恢复中删除，交给 §8.6 清扫。
3. 对「有 `committed` 无 `cleaned`」的事务：只补记诊断，索引由后续对账刷新；不回滚、不校验内容 hash。
4. 判定完毕后清空 journal（事务已全部判定）；写入路径上 journal 超过 **256 行**时即时压缩，只保留未结束事务。
5. 完整落盘行解析失败 → 启动降级只读并保留现场（不 panic、不删除）；末尾无换行的半截行按断电撕裂丢弃。

> 数值提示：journal 压缩阈值（256 行）以 `journal.rs` 常量为准，锁心跳与失效阈值（5s/30s）以 `lock.rs` 常量为准，改代码必须同步本文件。

### 6.3 journal 不做的事

`[设计选择]` journal 不是撤销栈，也不是内容备份：

- 不保存旧内容、也不记录内容 hash，因此不能从 journal 恢复被覆盖的内容——「禁止静默覆盖」由 §10 的冲突副本保证，而不是由 journal 保证。
- 不承担跨文档事务（v1 无多文档原子事务；批量操作逐文件提交，失败项单独报告）。

---

## 7. 库锁与多实例

锁文件：`<vault>/.workbench/.lock`

```json
{"vaultId":"01JB...","pid":48213,"machineId":"01JB...","startedAt":"2026-11-11T03:00:00Z","heartbeatAt":"2026-11-11T03:00:10Z","leaseToken":1,"app":"0.1.0"}
```

规则：

- 获取：`open(O_CREAT|O_EXCL)`。已存在则读内容判断有效性。
- 租约代次：`leaseToken` 为 `u64`。同一把锁存续期间只增不减：首次获取写 `1`，每次失效接管在当前值上 `+1`；锁文件缺失或损坏（包括认领后崩溃留下的空路径）按 `0` 处理。
- 心跳：持有者每 5 秒刷新 `heartbeatAt`（重写整个文件 + rename）。
- 失效判定：同一 `machineId` 且 pid 不存在 → 失效；任意机器上 `heartbeatAt` 超过 30 秒未更新 → 失效（跨机器共享库时以时间兜底）。
- 写前校验：每次落盘前重读锁文件，要求 `pid`、`leaseToken`、`heartbeatAt` 三者与持有方内存值**完全一致**；任一不一致说明锁已被接管或心跳停摆，**立即转只读**并拒绝本次写入（正文写入与图片落盘都走同一道写闸）。
- 失效后：新实例可以抢占；接管成功并持有锁之后、任何写入之前，必须先完成 §6.2 的 journal 恢复。
  - 接管流程：先把 `.lock` 原子 `rename` 到 `.workbench/lock.takeover.<pid>.<leaseToken>.<序号>` 完成认领（序号区分同进程的并发认领），
    并发接管只有一个 `rename` 成功，其余按只读返回；认领后回读临时文件，与判定失效时读到的原始字节
    逐字节比较，内容已变说明期间有人写入了新锁，用硬链接原位放回（目标存在时原子失败，不覆盖新锁），
    确认是同一份后才创建新 `.lock`，`leaseToken` 在认领值上 `+1`。接管者在 `rename` 后、创建前崩溃时
    锁路径为空，后续实例可直接创建，不会留下永久不可用的库；临时副本留在 `.workbench/` 中不参与锁判定，
    超过 24 小时（与孤儿临时文件同一门槛）由启动清扫回收，正在进行的认领因认领时刷新过 mtime 而不会被误删。
  - **实现状态**：`Vault::open` 的顺序是 `ensure_identity` → `lock::acquire`（含接管）→ `journal::recover` → 惰性清扫；
    只读观察者不执行恢复。写前校验（`pid` + `leaseToken` + `heartbeatAt`）已在 `lock.rs` 的 `verify_lease` 与
    `Vault::begin_write` 落地，心跳线程发现锁文件 PID/代次不符时同样立即降级只读；`kind: "lock.takeover"` 审计记录
    尚未实现（属已记录缺口，待后续版本补齐）。
- 抢不到锁：以**只读观察者**模式打开库（可搜索、可渲染、不可写），UI 明确提示「库已被其它实例打开」。绝不降级为「写但不加锁」。
  - 只读判定分两层：启动态的 `readonly` 只在抢锁时确定，运行期接管后的 UI 提示**最多滞后一个心跳周期（5 秒）**；
    真正的拦截点是写闸里的写前校验，因此不会出现「提示仍可写、实际已双写」的窗口。

watcher 跳过整个 `.workbench/`（因此也天然忽略 `.lock` 与 `.journal/`），避免自我触发。

---

## 8. `.workbench/` schema

通用约定：所有 JSON 文件都带 `schemaVersion`（整数，当前为 `1`），未知版本 ≥ 当前应用支持版本时**拒绝写入**并提示升级应用；低于当前版本时按迁移链升级，升级前先写 `.workbench/backup/<name>.<ts>.json`。

> **实现状态（v1 部分未实现）**：`vault.json` 读到未知/缺失 `schemaVersion` 时 `Vault::open` 返回可读错误，
> 启动页显示「启动失败 + 原因」（不再 panic），但**没有迁移链、也没有升级前备份**；`settings.json` 由
> 内核按默认值容错，`ui.json` 读到更高版本时整会话禁写（§10.3）已实现。

所有写入同样走 §6.1 原子写；`.workbench/` 下的文件不参与 Markdown 索引。

### 8.1 settings.json

```json
{
  "schemaVersion": 1,
  "vault": { "id": "01JB8ZQ3K4M5N6P7Q8R9S0T1V2", "name": "我的库", "createdAt": "2026-11-11T02:00:00Z" },
  "capabilities": {
    "ember.core.slash": { "enabled": true, "config": {} },
    "ember.core.focus": { "enabled": true, "config": { "dimOpacity": 0.4 } }
  },
  "ui": {
    "defaultView": "canvas",
    "defaultCanvasId": "01JB8ZQ3K4M5N6P7Q8R9S0T1V5",
    "sidebar": "auto",
    "canvasGrid": { "size": 8, "snap": true },
    "theme": "ember-black"
  },
  "linkOverrides": { "01JB...源文档id::方案": "01JB...目标id" }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `vault.id` | ULID | 库身份。索引文件名仍用路径 hash（§9），但库身份用于导出与冲突检测。 |
| `capabilities` | map<capabilityId, {enabled, config}> | 能力开关。缺失项按能力清单默认值处理。 |
| `ui` | object | 允许自由扩展，未识别键保留。 |
| `ui.defaultCanvasId` | ULID 或缺失 | 主页画布。缺失或指向不存在的画布时，启动流程重新解析并写回。 |
| `ui.sidebar` | `"auto"` \| `"off"` | 左侧栏行为：`auto` 左缘滑出、移开收起；`off` 彻底不渲染。默认 `auto`。 |
| `ui.canvasGrid` | `{ size: 8\|16\|32, snap: boolean }` | 画布网格尺寸与吸附。缺失时默认 `{ size: 8, snap: true }`。 |
| `ui.theme` | `"ember-black"` | 主题标识；v1 仅纯黑主题。 |
| `linkOverrides` | map<string, DocId> | 歧义链接的用户裁决，键为 `sourceId::rawTarget`。 |

`[设计选择]` 这些键属于**库状态**而不是机器状态：换一台机器打开同一个库，侧栏与主题行为一致。窗口位置、缩放、最近打开等机器相关状态不走 `settings.json`，见 §2 的 `machines/<machineId>/`。

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
    { "id": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W3", "kind": "group", "docId": null, "text": "内核", "x": 80, "y": 40, "w": 900, "h": 400, "z": 0, "groupId": null, "meta": { "color": "primary" } }
  ],
  "edges": [
    { "id": "e_01JB8ZQ3K4M5N6P7Q8R9S0T1W4", "from": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W1", "to": "n_01JB8ZQ3K4M5N6P7Q8R9S0T1W2", "label": "依赖", "arrow": "end", "kind": "relation", "meta": {} }
  ],
  "capabilityData": { "ember.canvas.minimap": { "enabled": true } }
}
```

节点字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 画布内局部 id，形如 `n_<ULID>`，同一画布内唯一；不参与跨文件引用。 |
| `kind` | `"doc"` \| `"note"` \| `"group"` | 是 | 节点类型；能力注册的新 kind 必须提供 `CanvasNodeKindSpec`。 |
| `docId` | ULID 或 null | doc 必填 | 关联文档。`note`/`group` 必须为 `null`。 |
| `text` | string 或 null | 否 | `note` 的正文、`group` 的标题；`doc` 恒为 `null`（标题/标签/简介从索引读，不冗余落盘）。 |
| `x`/`y`/`w`/`h` | number | 是 | 世界坐标与尺寸，1 = 1 CSS px @ zoom=1；最小 160×100。 |
| `z` | integer | 是 | 同 `z` 按数组顺序；组永远绘制在所有非组节点之下，不依赖 `z` 比较。 |
| `groupId` | string 或 null | 否 | 所属组的节点 id。一个节点最多属于一个组；组不能嵌套组；必须指向存在的 `group` 节点。 |
| `meta` | object | 是 | 未知键保留。`meta.color` 取 token 名 `primary\|secondary\|success\|warning\|danger\|null`，**不落色值**。 |

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
- 校验失败不写盘、不更新内存场景；命令返回 `ok: false` 与 `canvas_invalid` 文案。

### 8.3 mindmap/<mindmapId>.json

```json
{
  "schemaVersion": 1,
  "id": "01JB8ZQ3K4M5N6P7Q8R9S0T1V6",
  "title": "拆解",
  "rootId": "m1",
  "layout": "right",
  "createdAt": "2026-11-11T02:20:00Z",
  "updatedAt": "2026-11-11T02:30:00Z",
  "nodes": [
    { "id": "m1", "parentId": null, "text": "主题", "order": 0, "collapsed": false, "docId": null },
    { "id": "m2", "parentId": "m1", "text": "分支", "order": 0, "collapsed": false, "docId": "01JB8ZQ3K4M5N6P7Q8R9S0T1V3" }
  ]
}
```

约束：`rootId` 必须存在且 `parentId === null`；任何节点不得形成环（写入前校验，失败即拒绝，不写半成品）。

### 8.4 ai/memory.jsonl

追加写，一行一条：

```json
{"id":"01JB...","at":"2026-11-11T03:00:00Z","kind":"fact","scope":"vault","text":"用户偏好用中文写规范","source":{"docId":"01JB...","line":12}}
```

| 字段 | 取值 |
|---|---|
| `kind` | `fact`（稳定事实） / `episode`（交互片段摘要） / `preference`（用户偏好） |
| `scope` | `vault` / `global`（`global` 仍落库内，导出时不带） |
| `source` | 可选溯源，`docId` 必须存在于索引，否则导出时置空 |

不变量：只追加、不改写；纠错通过新增 `kind: "fact"` 且 `supersedes: <id>` 表达，不删除历史行。

### 8.5 ai/threads/<threadId>.json

```json
{ "schemaVersion": 1, "id": "01JB...", "title": "关于索引", "createdAt": "...", "updatedAt": "...", "messages": [ { "role": "user", "text": "...", "at": "..." } ] }
```

消息只存文本与引用（`refs: [{docId, anchor}]`），不存模型原始响应体，避免格式耦合。

### 8.6 trash/<ULID>/ 与惰性清扫

- `docs.remove` 的软删除副本落在 `.workbench/trash/<ULID>/<原文件名>`；副本 frontmatter 的 `id` **重写为新 ULID**，其余键原样保留——即使副本日后被移出 `.workbench/`，也不会与目录中的同 id 文档冲突。
- 持锁实例启动且 journal 恢复成功后执行惰性清扫：副本目录 mtime 超过 **30 天** 整目录回收；全库孤儿 `.ember-tmp-` 临时文件（>24h）一并回收。清扫只记日志不影响启动，mtime 不可读按保守不删处理。
- 孤儿 temp 清扫**覆盖** `.workbench/` 内部：锁心跳与 journal 的瞬时 temp 也在那里，24h 门槛远大于单次写入的存活时间，不会与 rename 竞态；`lock.takeover.*` 认领副本按同一门槛回收（§7）。
- 数值提示：孤儿 temp（24h）与回收站（30 天）的保留期以 `vault/mod.rs` 常量为准，改代码必须同步本文件。

### 8.7 machines/<machineId>/ui.json（机器本地，不在库内）

```json
{ "schemaVersion": 1, "floatSizes": {}, "floatPositions": {}, "recall": null, "pomodoro": {}, "ai": { "provider": "ollama", "baseUrl": "http://127.0.0.1:11434", "model": "" }, "panels": { "ai": { "open": false, "x": 0, "y": 0, "width": 360, "height": 480 } }, "sidebarWidth": 260 }
```

- 已知键：`floatSizes`、`floatPositions`、`recall`、`pomodoro`、`ai`、`panels.ai`、`sidebarWidth`。
- 序列化时未知顶层键与 `panels.*` 的他人子键**原样保留**，不做整体重写；对话与提案只存内存，不落盘。
- 读到更高 `schemaVersion` 时整会话禁止回写（旧版应用不得用默认态覆盖新版数据）。

---

## 9. 索引存储与检索

### 9.1 位置与生命周期

- 路径：`~/Library/Application Support/Ember/index/<vaultHash>.sqlite`，`vaultHash = SHA-256(规范化绝对路径)` 的前 32 个 hex 字符。
- `[设计选择]` 库被移动/重命名后 hash 变化 → 索引变成孤儿，触发全量重建。这是可接受的代价，换来「索引绝不写进库目录」。

  > 备选是使用 `settings.json` 里的 `vault.id` 命名索引文件，移动后索引仍可用。v1 不采用：路径 hash 让索引与「当前挂载位置」强绑定，避免同一库被复制到两处时两个实例共用一份索引互相污染。

- 索引可随时删除；删除后启动即全量重建。**任何功能不得依赖索引中存在未重建的数据。**
- SQLite 配置：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`。

### 9.2 表结构（v1）

> **实现状态（v1 未实现）**：Rust 侧 SQLite/FTS5 索引尚未接入；运行期注入的是
> `createPendingIndexPort` 占位端口（`available: false`，查询返回空、`rebuild` 返回空统计）。
> 下文表结构、`flags` 位与分词方案都是后续版本目标，当前没有落地的库文件。

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- meta: schema_version, vault_id, built_at, tokenizer_version

CREATE TABLE documents (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  path_folded    TEXT NOT NULL,
  title          TEXT NOT NULL,
  tags_json      TEXT NOT NULL,
  aliases_json   TEXT NOT NULL,
  created        TEXT,
  updated        TEXT,
  mtime_ms       INTEGER NOT NULL,
  size           INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  frontmatter_json TEXT NOT NULL,
  flags          INTEGER NOT NULL DEFAULT 0,  -- bit0 needs_adoption, bit1 id_invalid, bit2 duplicate_id
  indexed_at     TEXT NOT NULL
);
CREATE INDEX documents_path_folded ON documents(path_folded);
CREATE INDEX documents_title ON documents(title);

CREATE TABLE links ( /* §5.3 */ );
CREATE INDEX links_src ON links(src_id);
CREATE INDEX links_target ON links(target_id);

CREATE TABLE tags (doc_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(doc_id, tag));
CREATE INDEX tags_tag ON tags(tag);

-- 正文全文索引（外部内容表）
CREATE VIRTUAL TABLE docs_fts USING fts5(
  body_tokens,
  content='doc_text',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE doc_text (rowid INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, body_tokens TEXT NOT NULL);
```

`doc_text.body_tokens` 存的是**归一化后的检索串**（§9.3），不是原文；原文永远从文件读，避免索引成为第二真相源。

### 9.3 中文分词：取舍

`[事实]` FTS5 内置 tokenizer 只有 `unicode61`、`ascii`、`porter`，以及 3.34+ 的 `trigram`。它们都不做中文分词：`unicode61` 把连续汉字段当成**一个 token**，因此「知识库」无法被「知识」命中。

候选方案对比：

| 方案 | 召回 | 成本 | 依赖 | 主要缺陷 |
|---|---|---|---|---|
| A. `unicode61` 原样 | 差：整段汉字一个 token | 最低 | 无 | 中文搜索基本不可用 |
| B. `trigram` | 好：任意 ≥3 字子串 | 索引约 3× 正文 | 内置（SQLite ≥3.34） | 1–2 字查询退化为 LIKE 全扫；对英文短词也失效 |
| C. 写入时自建**二元组**（bigram）影子列 | 好：中文 ≥2 字查询全覆盖 | 索引约 2× 正文 | 无 | 无短语语义；1 字查询需 LIKE 兜底；需要 `tokenizer_version` 以便重建 |
| D. 自定义 jieba tokenizer | 最好：词级切分 | 索引最小 | 需编译扩展 + 词典随应用分发 | 词典与 SQLite 构建耦合，升级风险高 |

**v1 决定：C（二元组影子列）为默认，B 不采用，D 推迟。**

理由：C 的召回对中文长尾足够，且完全确定（同一文本永远切出同一串），不依赖词典版本；索引体积代价（约 2×）可接受，因为索引可删可重建。D 的准确率提升不足以抵消「原生扩展 + 词典 licensing + 跨架构构建」的工程量。

切分规则（`tokenizer_version = 1`）：

1. 文本归一化：NFKC、小写、去零宽字符、全角标点转半角。
2. 按「汉字连续段 / 拉丁字母数字连续段 / 其它分隔」分段。
3. 汉字段长度 L：
   - L = 1：保留单字 token；
   - L ≥ 2：生成全部重叠二元组（`知识库` → `知识`、`识库`），**不再**保留整段 token。
4. 拉丁段：整词作为 token（不做词干化，避免误召回）。
5. token 之间以单个空格连接写入 `body_tokens`。

查询构造：

- 查询串做同样的归一化与切分；汉字段生成二元组，多 token 之间用 `AND`；拉丁词加引号。
- 单字查询（切分后无二元组）→ 走 `LIKE '%字%'` 兜底并限制结果数，UI 标注「单字检索，结果可能较慢」。
- 查询 token 数量上限 32，超出截断并提示。

`[设计选择]` 升级切分规则必须递增 `tokenizer_version`，启动时发现版本不符即重建 `docs_fts`（不要求用户操作）。

---

## 10. 冲突处理

### 10.1 触发条件

`doc-service` 每次写入都携带调用方读到的 `baseHash`。提交前重新读取磁盘：

- 磁盘 hash == `baseHash` → 直接原子写（快路径）。
- 磁盘 hash != `baseHash` → 进入三方合并：`base` = 调用方持有的基线内容，`local` = 调用方要写入的内容，`disk` = 当前磁盘内容。

`[事实]` 这里没有「强制覆盖」分支。`force` 参数不存在，避免调用方误用。

### 10.2 合并

- 以行/块为单位的 diff3：取 `base→local` 与 `base→disk` 的变更区间，重叠区间为冲突。
- 复杂度上限：单侧 diff 为 O(n·m) DP（Uint32 表），`(n+1)×(m+1) > 8M` 格时返回 `too_large` 交人工处理——峰值内存约 64MB，可覆盖 ~2800 行 × ~2800 行的长文；更大文档不走自动合并。
- 无冲突 → 自动合并结果原子写入，返回 `{ merged: true, conflictCopy: null }`。
- 有冲突 → **两份都保留**：
  1. 主文件写入合并结果，冲突区间用标记包裹（见 10.4）；
  2. 同时生成冲突副本，保存**磁盘版本**的完整内容（用户/外部工具的那一份），并附注本地版本已并入主文件；
  3. 返回 `{ merged: false, conflictCopy: { path, docId } }` 并 emit `doc:conflict`。

### 10.3 冲突副本命名

```
<stem> (conflict <YYYYMMDDTHHMMSSZ>-<XXXX>).md
```

- 时间取 UTC，紧凑格式，无冒号（`[事实]` macOS 允许冒号但会在 Finder 中显示为 `/`，故禁用）。
- `XXXX` 取冲突副本自身 ULID 的前 4 位，同一秒内多次冲突也几乎不会碰撞；碰撞时追加 `-2`、`-3`。
- 冲突副本的 `id` 必须**新生成**（否则与主文件重复），并写入 `ember.conflictOf: <原文档 id>`。
- 冲突副本的 `created` = 冲突发生时间，`title` 保留原 title（不加后缀，后缀在文件名上）。

示例：

```
notes/方案.md
notes/方案 (conflict 20261111T103205Z-7F3K).md
```

### 10.4 冲突标记格式

```
<<<<<<< local (Ember 2026-11-11T10:32:05Z)
本地内容
=======
磁盘内容
>>>>>>> disk (mtime 2026-11-11T10:31:40Z)
```

标记行必须整行匹配；解析器把未闭合的标记视为普通文本，不报错（防止用户手写误伤）。

### 10.5 id 重复

`[事实]` 复制文件（Finder 复制、同步工具冲突副本）会产生重复 `id`。策略：

- 索引允许存在重复 id 的行，但 `documents.id` 唯一约束会被违反 → 改为允许重复：主键为 `rowid`，`id` 建普通索引，另加 `id_canonical` 指向规范文档。
- 规范文档选择：`created` 最早者；相同则路径字典序最小者。
- 其余标记 `flags.bit2 = duplicate_id`，UI 提供「重新分配 id」命令（复用 adoption 流程，逐文件确认）。
  - **实现状态（v1 未实现）**：没有 `duplicate_id` 标记，也没有「重新分配 id」命令；`refresh()` 只按路径字典序保留先收录者并告警，
    不会改写任何文件。
- **禁止**在后台自动改 id——那会在用户不知情时改变外部工具的引用。

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
  "workbench": { "canvas": ["01JB..."], "mindmap": ["01JB..."], "settings": true, "ai": false },
  "integrity": { "algorithm": "sha256", "files": { "docs/方案.md": "9f2c..." } }
}
```

契约：

- 字段只增不改；`formatVersion` 只在破坏性变更时递增。
- `documents[].contentHash` 与 `integrity.files[path]` 必须一致；导入时以 `integrity` 为准校验。
- 导入规则：校验 hash → 按 `id` 判重 → 冲突时不覆盖，导出报告列出 `conflicts[]`（不静默丢弃）。
- `ai/memory.jsonl` 默认不导出（`workbench.ai: false`），因为可能含敏感上下文。

---

## 12. 版本与迁移

- 本规范的 schema 版本：`vaultSchemaVersion = 1`，写入 `settings.json.schemaVersion`。
- 迁移必须单向、可重入：迁移前备份到 `.workbench/backup/`，迁移过程写 journal（`kind: "migrate"`）。
- 迁移失败 → 库进入只读并提示，不留下「迁移了一半」的库。
- 索引不受库 schema 版本约束，但受 `tokenizer_version` 约束（§9.3）。

---

## 13. 明确的非目标（v1）

- 不做多文档原子事务。
- 不做内容历史版本（依赖用户的 Git/Time Machine）。
- 不解析 Markdown 之外的格式（`.canvas` JSON Canvas 后续以能力形式接入，不进入内核）。
- 不在库内保存二进制大对象；附件是普通文件。
