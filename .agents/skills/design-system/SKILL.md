---
name: ember-futuristic
description: Ember 项目专属 Futuristic 深色霓虹设计系统。赛博黑背景 + 蓝紫发光 + 等宽字体 + 玻璃质感，适用于编辑器/内核管线/数据面板类应用。
license: MIT
metadata:
  author: typeui.sh
  project: ember
  updated: 2026-11-11
---

<!-- TYPEUI_SH_MANAGED_START -->
<!-- 此文件由 typeui.sh pull futuristic 生成，并针对 Ember 项目深度定制 -->
<!-- 原始规范保留，新增 Ember 专属令牌、组件规范与代码模板 -->

# Futuristic Design System — Ember Edition

## Mission
你是 Ember 的设计系统守护人。生成实现就绪的 UI 代码时，**必须**严格遵循本文件定义的令牌、组件骨架与反模式清单。
Ember 是一个基于 React 19 + Vite + Tauri 的桌面编辑器应用，运行在深色赛博主题上，所有组件都基于 CSS Modules。

---

## 1. 技术栈约束（不可违反）

| 项 | 值 |
|---|---|
| 框架 | React 19.3 |
| 构建 | Vite 7.3 |
| 样式 | **CSS Modules**（禁止 Tailwind、styled-components、内联 style 字符串） |
| 包管理 | pnpm workspaces |
| Tauri | v2 桌面壳 |
| 状态 | zustand + @tanstack/react-query |
| 编辑器 | CodeMirror 6 |
| 路径别名 | `#doc-model`、`#canvas-engine` |

---

## 2. Ember 设计令牌（直接对应 `src/styles/global.css`）

### 品牌色（发光版）
```
--ember-primary:       #3B82F6     核心发光蓝
--ember-primary-glow:  rgba(59, 130, 246, 0.6)
--ember-secondary:     #8B5CF6     辅助紫
--ember-secondary-glow:rgba(139, 92, 246, 0.6)
```

### 语义色
```
--ember-success:   #10B981   --ember-success-glow: rgba(16, 185, 129, 0.5)
--ember-warning:   #F59E0B   --ember-warning-glow: rgba(245, 158, 11, 0.5)
--ember-danger:    #EF4444   --ember-danger-glow: rgba(239, 68, 68, 0.5)
```

### 深色主题（赛博黑，6 层）
```
--ember-bg-deep:      #05060A   页面最底层
--ember-bg-base:      #0A0C14   主内容区
--ember-bg-surface:   #0F1220   侧栏/顶栏
--ember-bg-elevated:  #151A2E   弹窗/卡片
--ember-bg-glass:     rgba(21, 26, 46, 0.7)  毛玻璃层
```

### 边框
```
--ember-border:         rgba(59, 130, 246, 0.15)  常规
--ember-border-strong:  rgba(59, 130, 246, 0.35)  选中
--ember-border-glow:    rgba(59, 130, 246, 0.6)   发光态
```

### 文字
```
--ember-text-primary:   #E5E7EB
--ember-text-secondary: #9CA3AF
--ember-text-muted:     #6B7280
--ember-text-accent:    #60A5FA   悬停/链接态
```

### 字体
```
--font-display: 'Orbitron', 'Audiowide', sans-serif     LOGO/大标题
--font-body:    'Roboto', -apple-system, sans-serif     正文
--font-mono:    'Anonymous Pro', 'SF Mono', monospace   状态栏/标签/数值
```

### 间距标尺（严格使用，不要发明新值）
```
--space-xs: 4px    --space-sm: 8px    --space-md: 12px
--space-lg: 16px   --space-xl: 24px   --space-2xl: 32px
```

### 圆角
```
--radius-sm: 4px    --radius-md: 8px    --radius-lg: 12px    --radius-full: 9999px
```

### 发光效果
```
--glow-primary:   0 0 20px var(--ember-primary-glow), 0 0 40px var(--ember-primary-glow)
--glow-secondary: 0 0 20px var(--ember-secondary-glow), 0 0 40px var(--ember-secondary-glow)
```

### 过渡
```
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)
--duration-fast: 120ms   --duration-base: 200ms   --duration-slow: 360ms
```

---

## 3. 组件骨架模板

### 通用 React + CSS Modules 组件模板
```tsx
// src/shell/components/ComponentName.tsx
import styles from './ComponentName.module.css';

type Props = {
  variant?: 'default' | 'primary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
};

export function ComponentName({ variant = 'default', size = 'md', children }: Props) {
  return (
    <div className={`${styles.root} ${styles[variant]} ${styles[size]}`}>
      {children}
    </div>
  );
}
```
```css
/* ComponentName.module.css */
.root {
  /* 基础样式 */
  background: var(--ember-bg-elevated);
  border: 1px solid var(--ember-border);
  border-radius: var(--radius-md);
  transition: all var(--duration-base) var(--ease-out);
}

.root:hover {
  border-color: var(--ember-border-strong);
  box-shadow: 0 0 16px rgba(59, 130, 246, 0.1);
}

/* Variant: 主操作按钮 */
.primary {
  background: linear-gradient(135deg, var(--ember-primary) 0%, var(--ember-secondary) 100%);
  border: none;
  color: #fff;
}

.primary:hover {
  box-shadow: var(--glow-primary);
  transform: translateY(-1px);
}

/* Variant: 透明幽灵按钮 */
.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--ember-text-secondary);
}

.ghost:hover {
  background: rgba(59, 130, 246, 0.08);
  color: var(--ember-text-primary);
}
```

### 按钮
| 状态 | 背景 | 边框 | 文字 | 发光 |
|------|------|------|------|------|
| default | `--ember-bg-elevated` | `--ember-border` | `--ember-text-primary` | 无 |
| hover | 不变 | `--ember-border-strong` | 不变 | 16px 淡蓝 |
| primary | `primary → secondary` 渐变 | 无 | #fff | `--glow-primary` |
| disabled | `--ember-bg-base` | `--ember-border` | `--ember-text-muted` | 无 |

### 卡片 / 面板
```css
.card {
  background: var(--ember-bg-elevated);
  border: 1px solid var(--ember-border);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
}
.card:hover { border-color: var(--ember-border-strong); }
```

### 输入框
```css
.input {
  background: var(--ember-bg-base);
  border: 1px solid var(--ember-border);
  border-radius: var(--radius-md);
  color: var(--ember-text-primary);
  font-family: var(--font-body);
  padding: var(--space-sm) var(--space-md);
  outline: none;
  transition: border-color var(--duration-fast);
}
.input:focus { border-color: var(--ember-border-glow); box-shadow: 0 0 0 1px var(--ember-primary); }
.input::placeholder { color: var(--ember-text-muted); }
```

### 等宽标签（状态栏 / 徽章 / 时钟）
```css
.mono-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--ember-text-muted);
  letter-spacing: 0.05em;
}
```

### 品牌 LOGO 发光效果
```css
.logo-mark {
  color: var(--ember-primary);
  text-shadow: 0 0 12px var(--ember-primary-glow);
  animation: pulse-mark 2s ease-in-out infinite;
}
@keyframes pulse-mark {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}
```

### 背景网格（全局已有）
```css
/* body::before — 32px 淡蓝网格线 */
/* 新页面不要重复写，body 层已覆盖 */
```

---

## 4. Ember 应用骨架（已存在，新建组件请遵循层级）

```
App (垂直布局)
├── Topbar          52px 高 · 赛博黑底 · 底部发光蓝线
│   ├── Logo + 版本号
│   ├── 菜单 (文件/编辑/视图/内核/工具)
│   └── 内核状态点 + 实时时钟
├── Body (水平 flex)
│   ├── Sidebar     260px 宽 · 赛博黑底 · 资源管理器三栏
│   └── Main (flex:1)
│       └── EditorSurface
│           ├── Tabs    38px 高 · 激活态顶部发光蓝条
│           └── Content 主区域 · 内核管线可视化
└── StatusBar       26px 高 · 等宽字体 · 底部信息
```

---

## 5. 写作与命名规范

- **组件文件名**：PascalCase（`KernelGraph.tsx`）
- **CSS 模块**：同名 + `.module.css`
- **CSS 类名**：kebab-case 或 camelCase，推荐 camelCase + BEM 变体（`.root` / `.primary` / `.disabled`）
- **颜色变量**：**永远**用 `var(--ember-xxx)`，禁止硬编码十六进制色值（除非临时 debug）
- **间距变量**：用 `var(--space-sm/md/lg/xl)`，禁止随手写 `10px`
- **字体**：显示文字 `--font-display`，正文 `--font-body`，标签/数值 `--font-mono`

---

## 6. 反模式清单（严禁）

| # | 反模式 | 正确做法 |
|---|--------|---------|
| ❌ | 写 `#FFFFFF` 当背景 | 用 `var(--ember-bg-xxx)` |
| ❌ | 写 `color: #3B82F6` | 用 `color: var(--ember-primary)` |
| ❌ | 随手设 `padding: 10px` | 用 `var(--space-md)` (12px) |
| ❌ | 用 Tailwind 写样式 | 必须 CSS Modules |
| ❌ | 组件根元素加 `<style jsx>` | 必须分离 .module.css |
| ❌ | 亮白底配深色文字 | 所有面板必须深色背景 |
| ❌ | 缺少 hover / focus 态 | 每个可交互元素必须有 |
| ❌ | 动画超过 360ms | 遵循 `--duration-fast/base/slow` |
| ❌ | 无发光效果的品牌按钮 | primary 按钮必须带 glow |
| ❌ | 不用 CSS Modules 的模块 | 所有组件样式必须模块化 |

---

## 7. 无障碍要求

- 对比度 ≥ WCAG AA（深色背景上 `#E5E7EB` 主文字，`#9CA3AF` 次要）
- 可聚焦元素必须有 `outline: none` + focus 态发光边框
- 键盘可达所有交互元素（Tab 顺序合理）
- 装饰性动画（脉冲、发光）不能导致 epilepsy 风险，避免红色闪烁

---

## 8. QA 检查清单（代码审查时逐项过）

- [ ] 所有颜色用 `var(--ember-xxx)` 令牌，无硬编码
- [ ] 所有间距用 `var(--space-xxx)`，无手写像素
- [ ] CSS Modules 文件存在且与 .tsx 同名
- [ ] 交互元素有 hover / focus / active / disabled 四态
- [ ] 无 Tailwind、styled-components、内联 style 字符串
- [ ] 深色主题，无亮白底
- [ ] 品牌 primary 操作有 `--glow-primary` 效果
- [ ] 字体选择符合 token 规范
- [ ] 过渡动画时长在 120–360ms 区间
- [ ] 文件命名 PascalCase + `.module.css`
- [ ] 无 TypeScript 类型错误
- [ ] `pnpm run build` 通过

---

## 9. 与 TypeUI 原始 Futuristic 规范的差异

本文件为 **Ember 专属定制版**，与 TypeUI 通用 Futuristic 规范的主要差异：

| 维度 | TypeUI 通用 | Ember 定制 |
|------|------------|------------|
| 主题 | 亮色（surface #FFFFFF） | 深色赛博黑（#05060A → #151A2E） |
| 字体 | Audiowide + Roboto + Anonymous Pro | 加 Orbitron 作为 LOGO 显示字体 |
| 边框 | 无 | 统一加 `--ember-border` 淡蓝描边 |
| 发光 | 无 | 所有品牌态带 `--glow-primary/secondary` |
| 技术栈 | 无 | React 19 + Vite + CSS Modules + Tauri |
| 应用骨架 | 无 | 完整 Topbar/Sidebar/Editor/StatusBar 结构 |

---

## 10. 规则速查

**必须**（MUST）
- 使用 `var(--ember-xxx)` 令牌，禁止硬编码颜色/间距
- 所有样式走 CSS Modules
- 交互元素有 hover/focus/disabled 态
- 新建组件放在 `src/shell/components/` 下

**应该**（SHOULD）
- 品牌 primary 操作加发光效果
- LOGO/标题用 `--font-display`
- 状态栏/数值用 `--font-mono`
- 响应式优先适配 1280px+ 桌面宽屏

**禁止**（NEVER）
- Tailwind、styled-components、emotion
- 亮白底、纯黑文字
- 随手发明新间距值（如 10px、13px）
- 动画 > 360ms 或红色快速闪烁

<!-- TYPEUI_SH_MANAGED_END -->
