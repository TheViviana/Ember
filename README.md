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

仓库当前未配置 CI：没有远端仓库，且 `check:runtime` 依赖本机 Chromium 与图形环境，无法在通用 CI 上稳定运行。

`check:offline` 按字面量扫描源码与 `dist`：只识别文本中直接出现的 `http(s)://` 与协议相对地址。运行期拼出来的地址（scheme/host 分段拼接、环境变量、动态 `import()`、配置读取）不在覆盖范围；这类动态地址由 `check:runtime` 的启动期抓包与功能自身的地址校验兜底（参见 [docs/ai-panel.md](docs/ai-panel.md)）。

## 规范源

- [docs/kernel-contract-v1.md](docs/kernel-contract-v1.md)：内核与各能力之间的唯一契约源。
- [docs/vault-format.md](docs/vault-format.md)：库内文件格式（frontmatter、journal、锁、回收站等）的唯一规范源。

两份文档与代码不一致时以文档为准，代码是 bug；改动协议必须同步文档。

## 许可证

本项目以 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) 许可发布，详见根目录 [LICENSE](LICENSE)。

- 你可以将本项目用于个人学习、研究、兴趣爱好等**非商业用途**，包括修改与再分发（需保留 `Required Notice: Copyright TheViviana` 及许可证文本）。
- **商业使用需另行授权**，请联系作者。

### 随项目分发的第三方资源许可

- `public/fonts/` 中的字体（Orbitron、Geist、Anonymous Pro、Roboto）均以 SIL Open Font License 1.1 发布，各字体许可证文本已随目录分发（`LICENSE-*.txt`）。
- 数学公式渲染使用的 [KaTeX](https://katex.org)（npm 依赖）字体同样采用 OFL 许可，随其 npm 包分发。
- 其余第三方依赖均为 MIT / Apache-2.0 等宽松许可证，各依赖的许可证文本随其包分发。
