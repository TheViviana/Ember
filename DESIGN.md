---
name: Futuristic
colors:
  primary: "#3B82F6"
  secondary: "#8B5CF6"
  success: "#16A34A"
  warning: "#D97706"
  danger: "#DC2626"
  surface: "#FFFFFF"
  text: "#111827"
  neutral: "#FFFFFF"
typography:
  h1:
    fontFamily: "Geist Sans"
    fontSize: 3rem
  body-md:
    fontFamily: "Roboto"
    fontSize: 1rem
  label-caps:
    fontFamily: "Anonymous Pro"
    fontSize: 0.75rem
  sourceScale: "desktop-first expressive scale"
  weights: "100, 200, 300, 400, 500, 600, 700, 800, 900"
rounded:
  sm: 4px
  md: 8px
spacing:
  sm: 4px
  md: 8px
  sourceScale: "4/8/12/16/24/32"
---

## Overview

Forward-looking design with tech-inspired typography, modern layouts, and a sleek, innovation-driven aesthetic.

## Style Foundations

- **Visual style:** modern
- **Typography scale:** desktop-first expressive scale
- **Typography fonts:** primary=Roboto（正文回退）、display=Geist、mono=Anonymous Pro
- **Typography weights:** 100, 200, 300, 400, 500, 600, 700, 800, 900
- **Color palette:** primary, neutral, success, warning, danger
- **Spacing scale:** 4/8/12/16/24/32

## Colors

- **Primary (#3B82F6):** Token from style foundations.
- **Secondary (#8B5CF6):** Token from style foundations.
- **Success (#16A34A):** Token from style foundations.
- **Warning (#D97706):** Token from style foundations.
- **Danger (#DC2626):** Token from style foundations.
- **Surface (#FFFFFF):** 源色板值；**运行时**深色主题的底色见下节，实际取值以 `src/styles/tokens.css` 为唯一来源。
- **Text (#111827):** 源色板值；运行时正文色以 `--ember-text-primary` 为准。
- **Neutral (#FFFFFF):** Derived from the surface token for official format compatibility.

## 运行时主题（`tokens.css` 为唯一来源）

- 窗口底色：`--ember-bg-base` = `#0a0a0a`，无边框窗口启动无白闪（index.html 首屏同色）。
- 画布底色：`--ember-canvas-bg` 黑色径向渐变，终点为纯黑。
- 所有颜色、尺寸、层级只允许通过 token 引用；组件 CSS Module 里禁止裸色值、裸 `z-index`、内联 `style`。
- 字体仅本地 `@font-face`（Geist / Roboto / Anonymous Pro），禁止任何远程字体或图标库。

## 窗口边框

- 无系统外框（`decorations: false`），窗口底色 `--ember-bg-base`（#0a0a0a），四角为直角。
- 自绘交通灯：直径 `--window-control-size`（12px），间距 8px，距左上 `--window-controls-inset`（14px），层级 `--layer-chrome`。
- 拖拽区 = 顶栏整条（按钮与输入区除外），走 Tauri `data-tauri-drag-region`；双击拖拽区切换最大化由应用自己处理 —— Tauri 内置的双击路径调用 `internal_toggle_maximize`，它会先查 `is_maximizable()`，无边框窗口没有 zoom button 因而恒为 false，结果是静默无反应。
- 缩放热区：四边 + 四角共 8 处，宽 `--window-resize-grip`（6px）；最小尺寸 960 × 640。
- macOS 上 `startResizeDragging` 在 tao 0.37 返回 `NotSupported` 且被运行时吞掉，**不得使用**；缩放走自实现（见 kernel 外的 shell 实现说明）。

## 无限画布

- 绘制层级：网格 → 连线 → 节点（组在节点层内部排序沉底）→ 框选 → 画布工具条（过滤/书签/最近编辑）→ 引线菜单/右键菜单 → 浮窗层 → 图片大图浮层 → 窗口 chrome（用 `--layer-*`）。
- 节点默认 320 × 200，最小 160 × 100；圆角 10px，1px 边框 `--ember-node-border`，选中 `--ember-node-border-active`，阴影 `--ember-node-shadow`。
- 文章节点内容：标题单行省略、标签 chips 最多 3 个（多余显示 `+n`）、简介 2 行省略；简介为空显示「暂无简介」。
- 自由文本节点：正文就地编辑，底色 `--ember-node-bg-note`。
- 连线：1.5px 贝塞尔曲线，默认 `--ember-edge`，激活 `--ember-edge-active`；关系标签以胶囊渲染。
- 手势：滚轮以光标为锚点缩放（夹紧 0.1–4）；空格或中键拖拽平移；空白处拖拽框选（相交即选中，组不参与框选）；拖动节点按 `ui.canvasGrid` 吸附；双击自由文本节点就地编辑。
- 画布几何只能通过 CSS 变量传给组件（`--node-*` / `--viewport-*` / `--canvas-grid-*` / `--marquee-*`），组件内联 `style` 只允许出现这些变量名，颜色 / 字体 / 间距仍必须来自 `tokens.css`。
- 框选：填充 `--ember-marquee-fill`，描边 `--ember-marquee-border`。
- 右键菜单：宽 `--menu-width`（220px），行高 `--menu-item-height`（30px），底色 `--ember-menu-bg`，悬停 `--ember-menu-hover`，分隔线 `--ember-menu-separator`；支持 ↑↓ / Enter / Esc。

## 背景

- 删除全局 `body::before` 网格；网格由画布自绘（`--ember-canvas-grid` / `--ember-canvas-grid-major` / `--ember-canvas-grid-gap`），避免与画布网格叠加。

## 图标

- 1024 × 1024，纯黑 `#000000` 背景，居中白色 "EMBER"（Geist，字距 0.12em），无任何外链资源。
- 导出 16 / 32 / 64 / 128 / 256 / 512 / 1024 PNG 与 `icon.icns`；Windows `.ico` 本轮不重制（已知缺口）。

