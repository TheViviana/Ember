/**
 * 设计 token 的 TypeScript 镜像。
 *
 * 唯一权威仍是 `src/styles/tokens.css`；本文件只服务需要以 JS 值消费 token 的场景
 * （CodeMirror 主题、画布引擎等），两者必须逐项一致。
 * 新增 token 时先改 CSS，再同步这里，禁止只改一边。
 */

export const colors = {
  primary: '#e5e5e5',
  primaryGlow: 'rgba(255, 255, 255, 0.14)',
  secondary: '#a1a1a1',
  secondaryGlow: 'rgba(255, 255, 255, 0.1)',

  success: '#00bd7d',
  successGlow: 'rgba(0, 189, 125, 0.22)',
  warning: '#fcb500',
  warningGlow: 'rgba(252, 181, 0, 0.22)',
  danger: '#ff6568',
  dangerGlow: 'rgba(255, 101, 104, 0.22)',
  info: '#2c7fff',

  bgDeep: '#050505',
  bgBase: '#0a0a0a',
  bgSurface: '#171717',
  bgElevated: '#1f1f1f',
  bgGlass: 'rgba(23, 23, 23, 0.86)',
  bgMenu: '#1f1f1f',
  glassTopbar: 'rgba(10, 10, 10, 0.62)',
  bgHover: 'rgba(255, 255, 255, 0.08)',
  bgSelected: 'rgba(255, 255, 255, 0.1)',

  border: 'rgba(255, 255, 255, 0.1)',
  borderSubtle: 'rgba(255, 255, 255, 0.06)',
  borderStrong: 'rgba(255, 255, 255, 0.16)',
  borderInput: 'rgba(255, 255, 255, 0.15)',
  borderFocus: 'rgba(255, 255, 255, 0.35)',
  borderGlow: 'rgba(255, 255, 255, 0.35)',

  textPrimary: '#fafafa',
  textSecondary: '#a1a1a1',
  textMuted: '#737373',
  textAccent: '#fafafa',
  textOnAccent: '#171717',

  primaryTintWeak: 'rgba(255, 255, 255, 0.03)',
  primaryTintSoft: 'rgba(255, 255, 255, 0.06)',
  primaryTintStrong: 'rgba(255, 255, 255, 0.12)',
  secondaryTint: 'rgba(255, 255, 255, 0.06)',
  secondaryBorder: 'rgba(255, 255, 255, 0.14)',
  successTint: 'rgba(0, 189, 125, 0.12)',
  successBorder: 'rgba(0, 189, 125, 0.32)',
  warningTint: 'rgba(252, 181, 0, 0.12)',
  warningBorder: 'rgba(252, 181, 0, 0.32)',
  dangerTint: 'rgba(255, 101, 104, 0.12)',
  dangerBorder: 'rgba(255, 101, 104, 0.32)',
} as const;

export const fonts = {
  display: "'Geist', 'Roboto', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
  body: "'Geist', 'Roboto', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', sans-serif",
  mono: "'Anonymous Pro', 'SF Mono', 'Fira Code', 'PingFang SC', monospace",
} as const;

export const fontSize = {
  '2xs': '10px',
  xs: '11px',
  sm: '12px',
  md: '13px',
  base: '14px',
  lg: '16px',
  xl: '20px',
  '2xl': '28px',
  display: '48px',
} as const;

export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
} as const;

export const radius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  full: '9999px',
} as const;

export const motion = {
  easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
  easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  durationFast: '120ms',
  durationBase: '160ms',
  durationSlow: '240ms',
} as const;

export const layout = {
  sidebarWidth: 250,
  topbarHeight: 52,
  statusbarHeight: 28,
  windowControlSize: 12,
  windowControlsInset: 14,
  windowResizeGrip: 6,
  windowRadius: 12,
  glassBlur: 24,
  glassSaturate: 140,
  menuWidth: 220,
  menuItemHeight: 30,
  floatWidth: 560,
  floatHeight: 420,
  floatMinWidth: 480,
  floatMinHeight: 320,
  floatResizeHit: 16,
} as const;

/** 无限画布视觉（对应 tokens.css 的 --ember-canvas-* / --ember-node-* / --ember-edge-* 等） */
export const canvas = {
  bgVoid: '#000000',
  bg: '#0a0a0a',
  grid: 'rgba(255, 255, 255, 0.035)',
  gridMajor: 'rgba(255, 255, 255, 0.06)',
  gridGap: '32px',
  nodeBg: '#171717',
  nodeBgNote: '#1c1c1c',
  nodeRadius: '12px',
  nodeBorder: 'rgba(255, 255, 255, 0.1)',
  nodeBorderActive: 'rgba(255, 255, 255, 0.55)',
  nodeBorderNote: 'rgba(34, 211, 238, 0.55)',
  nodeBorderNoteActive: '#22d3ee',
  nodeBorderDoc: 'rgba(44, 127, 255, 0.55)',
  nodeBorderDocActive: '#2c7fff',
  nodeKicker: '#2c7fff',
  nodeShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  edge: 'rgba(255, 255, 255, 0.22)',
  edgeActive: '#e5e5e5',
  edgeWidth: '1.5px',
  edgeHitWidth: '14px',
  edgeLabelHalo: '4px',
  marqueeFill: 'rgba(255, 255, 255, 0.08)',
  marqueeBorder: 'rgba(255, 255, 255, 0.4)',
  groupBg: 'rgba(255, 255, 255, 0.02)',
  groupBorder: 'rgba(255, 255, 255, 0.12)',
} as const;

/** 自绘交通灯（对应 tokens.css 的 --ember-traffic-*） */
export const trafficLights = {
  close: '#ff5f57',
  minimize: '#febc2e',
  zoom: '#28c840',
} as const;

/** 右键菜单与浮层 */
export const overlay = {
  menuBg: '#1f1f1f',
  menuHover: 'rgba(255, 255, 255, 0.08)',
  menuSeparator: 'rgba(255, 255, 255, 0.08)',
  scrim: 'rgba(0, 0, 0, 0.5)',
} as const;

/** 层级；组件里禁止写裸 z-index */
export const layers = {
  canvas: 1,
  sidebar: 40,
  float: 50,
  menu: 60,
  chrome: 70,
} as const;

/**
 * 本里程碑新增的 CSS 变量名清单（用于 tokens.css ↔ tokens.ts 一致性测试）。
 * 只列新增组；既有 token 已由人工 Review 守护。
 */
export const cssVarNames = [
  '--ember-bg-void',
  '--ember-canvas-bg',
  '--ember-canvas-grid',
  '--ember-canvas-grid-major',
  '--ember-canvas-grid-gap',
  '--ember-node-bg',
  '--ember-node-bg-note',
  '--ember-node-radius',
  '--ember-node-border',
  '--ember-node-border-active',
  '--ember-node-border-note',
  '--ember-node-border-note-active',
  '--ember-node-border-doc',
  '--ember-node-border-doc-active',
  '--ember-node-kicker',
  '--ember-node-shadow',
  '--ember-edge',
  '--ember-edge-active',
  '--ember-edge-width',
  '--ember-edge-hit-width',
  '--ember-edge-label-halo',
  '--ember-marquee-fill',
  '--ember-marquee-border',
  '--ember-warning-tint',
  '--ember-warning-border',
  '--ember-danger-tint',
  '--ember-danger-border',
  '--ember-group-bg',
  '--ember-group-border',
  '--ember-menu-bg',
  '--ember-menu-hover',
  '--ember-menu-separator',
  '--ember-overlay-scrim',
  '--menu-width',
  '--menu-item-height',
  '--float-width',
  '--float-height',
  '--float-min-width',
  '--float-min-height',
  '--float-resize-hit',
  '--window-radius',
  '--ember-glass-topbar',
  '--ember-glass-blur',
  '--ember-glass-saturate',
  '--window-control-size',
  '--window-controls-inset',
  '--window-resize-grip',
  '--ember-traffic-close',
  '--ember-traffic-minimize',
  '--ember-traffic-zoom',
  '--layer-canvas',
  '--layer-sidebar',
  '--layer-float',
  '--layer-menu',
  '--layer-chrome',
] as const;
