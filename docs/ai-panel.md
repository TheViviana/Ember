# AI 助手浮窗

AI 助手是主内容区右下角的浮动面板（默认位于 HUD 与左下角横排上方），是 shell 层能力，内核只提供 `docs.*` 读写入口（见 `kernel-contract-v1.md` 第 20 行：内核不负责提示词）。它不占文章浮窗的 5 个名额，浮窗胶囊计数不含它。本文件记录它的配置、存储与验证方式。

## 配置

设置页 →「AI」：

| 项 | 说明 |
| --- | --- |
| provider | `ollama`（默认 `http://127.0.0.1:11434`）或 `openai-compatible` |
| base URL | 用户自填；不内置任何外域地址 |
| model | 必填，空模型时聊天与六种操作会直接提示 |
| API Key | `type="password"`，保存后只显示「已保存」，不回显明文；Ollama 可不填 |

密钥落点：

- 优先系统钥匙串，账户名 `provider:v1:<origin>`（不含密钥、不含模型）。
- 钥匙串不可用时降级为进程内存，8 小时 TTL，进程退出即回收；界面会提示「仅本次运行有效」。

## 入口与交互

- 六种文章操作（润色 / 总结 / 解释 / 延伸 / 定义 / 研究）不再常驻面板；在文章浮窗里选中非空文本后，于选区附近浮出菜单。
- 菜单复用画布子菜单的 `placeSubmenu`：贴选区、右侧放不下向左翻、下方放不下上翻、始终留在浮窗内。
- 取消选择、点击空白、按 Esc、滚动正文都会收起菜单；右键菜单优先，选区菜单先让位。
- 只读库下六项禁用并给出原因，不静默失败。
- 面板标题栏可拖动，右下角可同时改宽高；松手才写 `ui.json`，窗口缩放只重新夹取显示位置、不落盘。

## 存储归属

- 配置写机器本地 `ui.json`：`ai: { provider, baseUrl, model }`、`panels.ai: { open, x, y, width, height }`。
- 缺 `x` / `y` / `width` / `height` 时按右下默认位与 360×480 补齐；位置、尺寸在渲染时夹进当前主内容区，底部预留 52px 避开 HUD 与左下角横排。
- 序列化保留未知顶层键与他人子键（`recall`、`pomodoro`、`sidebarWidth`、`panels.*`），不做整体重写。
- 对话、写回提案、撤销栈只存在内存，不写 `ui.json`，也不使用 `localStorage`。

## 网络边界

- 运行时除用户显式配置的 AI 端点外零外联；默认只有回环地址。
- 端点解析后逐 IP 校验并固定解析结果，防 DNS 重绑定；HTTP 仅允许回环（除非将来显式放开）。
- 门禁：`pnpm check:offline`、`pnpm check:runtime`；人工核对用 `scripts/manual/net-sample.sh`。

## 写回与撤销

- 生成阶段只读；回复下方的「替换正文…」「存为新文章…」「删除…」只生成内存提案，点「应用」才经 `kernel.docs.update/create/remove` 写入，且必带 `base` 与 `intent: 'user'`。
- 应用前复核 `base.hash`，不一致即作废提案（stale）。
- 三方合并冲突时保留磁盘版本、报告冲突副本路径，不生成撤销条。
- 撤销仅在本次运行内有效：替换恢复旧正文；新建移入回收站；删除按原 id / 路径 / 正文 / frontmatter 重建（`created`/`updated` 会刷新为恢复时刻）。

## 验证

```bash
pnpm typecheck
pnpm test                 # 含 tests/shell/ai-proposal.test.ts、tests/shell/machine-store-ai.test.ts
pnpm ai:test              # Rust 侧 AI 传输与端点校验
pnpm gate
pnpm check:network        # build + offline + runtime-network
```
