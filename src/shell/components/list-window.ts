/**
 * 大列表的轻量窗口化（不引入第三方依赖）：
 * - `paletteWindow`：固定行高列表（命令面板）以选中项为锚渲染一个窗口，
 *   键盘/hover 移动选中项时窗口随之平移，窗口外的命令不进 DOM。
 * - `growVisible`：可变行高列表（侧栏文档列表）用哨兵分批渲染，
 *   滚动到底部的哨兵进入视野时按块增长可见数量。
 */

export interface ListWindow {
  /** 渲染起点（含） */
  readonly start: number;
  /** 渲染终点（不含） */
  readonly end: number;
}

/** 面板单窗口渲染的命令数：62vh 容器内约 15 行可见，60 覆盖数屏滚动 */
export const PALETTE_WINDOW_CHUNK = 60;
/** 侧栏文档列表每批增长的数量 */
export const SIDEBAR_CHUNK = 150;
/** 侧栏首批渲染的数量 */
export const SIDEBAR_INITIAL = 100;

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max);

/** 以 `active` 为锚计算 [start, end) 窗口；total 为 0 或 active 越界时安全收敛 */
export const paletteWindow = (
  total: number,
  active: number,
  chunk: number = PALETTE_WINDOW_CHUNK,
): ListWindow => {
  const safeTotal = Math.max(0, Math.trunc(total));
  if (safeTotal === 0) return { start: 0, end: 0 };
  const safeActive = clampInt(active, 0, safeTotal - 1);
  const safeChunk = clampInt(chunk, 1, safeTotal);
  const start = Math.max(0, Math.min(safeActive - Math.floor(safeChunk / 2), safeTotal - safeChunk));
  return { start, end: start + safeChunk };
};

/** 哨兵分批：从 current 增长一批，夹到 total；total 收缩时调用方负责回落 */
export const growVisible = (
  current: number,
  total: number,
  chunk: number = SIDEBAR_CHUNK,
): number => {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeCurrent = clampInt(current, 0, safeTotal);
  return Math.min(safeTotal, safeCurrent + Math.max(1, Math.trunc(chunk)));
};

/** total 收缩（刷新/过滤）时把可见数夹回合法区间 */
export const clampVisible = (current: number, total: number): number => {
  const safeTotal = Math.max(0, Math.trunc(total));
  return clampInt(current, Math.min(1, safeTotal), safeTotal);
};
