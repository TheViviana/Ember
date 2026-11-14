# Ember

Ember 是一个本地优先的知识工作台：数据完全存放在本地 vault 中，无服务端、无账号，桌面端基于 Tauri（Rust 宿主 + Web 前端）构建。

## 开发与检查

需要 Node.js >= 22.18（版本见 `package.json` 的 `engines`）与 pnpm。

```sh
pnpm install      # 安装依赖
pnpm dev          # 启动 Web 前端（Vite）
pnpm tauri dev    # 启动桌面端
pnpm check        # 提交前完整检查
pnpm check:gates  # 只跑架构门禁与门禁自检
```

`pnpm check` 依次执行：TypeScript 类型检查 → ESLint → 架构门禁（循环依赖、分层、禁用项、shell 层体积、CSP）与门禁自检 → Node 测试 → 构建 + 离线/运行期零外域检查。Rust 侧单独运行 `cargo test --offline` 与 `cargo clippy --offline --all-targets -- -D warnings`（工作目录 `src-tauri/`）。

仓库当前未配置 CI：远端已配置为 `origin`（`https://github.com/TheViviana/Ember.git`），但 `check:runtime` 依赖本机 Chromium 与图形环境，无法在通用 CI 上稳定运行。

`check:offline` 按字面量扫描源码与 `dist`：只识别文本中直接出现的 `http(s)://` 与协议相对地址。运行期拼出来的地址（scheme/host 分段拼接、环境变量、动态 `import()`、配置读取）不在覆盖范围；这类动态地址由 `check:runtime` 的启动期抓包与功能自身的地址校验兜底（见 `docs/kernel-contract.md` 的「AI 面板行为」一节）。

## 安装与首次启动

### 系统要求

macOS 13.0（Ventura）及以上。

安装包内 `Ember.app/Contents/Info.plist` 的 `LSMinimumSystemVersion` 与主二进制 `LC_BUILD_VERSION` 的 `minos` 均由 `src-tauri/tauri.conf.json` 的 `bundle.macOS.minimumSystemVersion` 生成，两者同为 `13.0`；macOS 13.0 以下无法启动。

### 安装

1. 打开 `Ember_0.1.0_universal.dmg`（universal：`x86_64` + `arm64`）。
2. 把 `Ember.app` 拖进「应用程序」。
3. 推出安装镜像。

### 首次打开

安装包为 ad-hoc 签名且未公证（`codesign` 显示 `Signature=adhoc`，`spctl` 判定 `no usable signature`），双击会被 Gatekeeper 拦截。任选一种方式放行：

- 在「应用程序」中右键 `Ember.app` →「打开」，再确认一次「打开」；
- 或打开「系统设置 → 隐私与安全性」，在页面下方点击「仍要打开」。

### 首次启动

- 库根按以下顺序解析：环境变量 `EMBER_VAULT` → 已存在的 `~/Documents/EmberVault` → `~/Library/Application Support/Ember/vault`。前两者都不成立时，在最后一项新建空库。
- 使用 `~/Documents/EmberVault` 时，macOS 会请求「文稿」文件夹访问权限；拒绝后应用仍能启动，但文档列表会报权限错误，需到「系统设置 → 隐私与安全性 → 文件与文件夹」中放行。
- AI 功能不内置任何模型：需在「设置 → AI」选择 `ollama`（默认 `http://127.0.0.1:11434`）或 `openai-compatible`，并填写 base URL、模型名与 API Key（Ollama 可不填 Key）。

## 规范源

- [docs/kernel-contract.md](docs/kernel-contract.md)：内核契约源（v2：画布库 / 真索引 / 基线校验+冲突副本），并收录 AI 面板行为（§12）。
- [docs/vault-format.md](docs/vault-format.md)：库内文件格式（frontmatter、画布/书签、库锁、回收站等）的唯一规范源。

两份文档与代码不一致时以文档为准，代码是 bug；改动协议必须同步文档。

## 隐私

- 笔记与附件数据全部存放在本地 vault，无服务端、无账号；运行时除用户显式配置的 AI 端点与主动启用的公共翻译接口外，不发起外部请求。
- AI 请求只发往用户在「设置 → AI」自行填写的端点，应用不内置外域地址，默认只有回环地址。
- 整篇翻译有三条通道：
  - 本地模型：走 Ollama，正文不出本机；
  - API 模型：走用户配置的 OpenAI 兼容端点；
  - 公共免费接口：正文按约 450 字符切块后分段发往 MyMemory（主）与 `translate.googleapis.com`（回落），可能被第三方记录；不发送文件路径、标题、标签、链接。该通道需用户在设置中显式确认后才启用。
- API Key 优先存入系统钥匙串（钥匙串不可用时只保留在进程内存，8 小时过期）；界面不回显明文，也不写入 `ui.json` 等配置文件。

## 许可证

本项目以 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) 许可发布，详见根目录 [LICENSE](LICENSE)。

- 你可以将本项目用于个人学习、研究、兴趣爱好等**非商业用途**，包括修改与再分发（需保留 `Required Notice: Copyright TheViviana` 及许可证文本）。
- **商业使用需另行授权**，请联系作者。

### 随项目分发的第三方资源许可

- `public/fonts/` 中的字体（Geist、Anonymous Pro、Roboto）均以 SIL Open Font License 1.1 发布，各字体许可证文本已随目录分发（`LICENSE-geist.txt`、`LICENSE-anonymous-pro.txt`、`LICENSE-roboto.txt`）。
- 数学公式渲染使用的 [KaTeX](https://katex.org)（npm 依赖，0.19.1）分两部分许可：代码为 MIT，原文见 `public/licenses/katex.txt`；字体为 SIL Open Font License 1.1，原文见 `public/licenses/katex-fonts-OFL.txt`。
- 其余第三方依赖均为 MIT / Apache-2.0 等宽松许可证，各依赖的许可证文本随其包分发。
