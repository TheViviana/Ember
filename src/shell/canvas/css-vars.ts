import type { CSSProperties } from 'react';

/**
 * 画布几何只能由数据驱动（世界坐标、缩放、网格步长），无法预先写进 CSS Module。
 * 这里只允许传 CSS 变量名，视觉值（颜色 / 字体 / 间距）仍然只能来自 tokens.css。
 */
export const cssVars = (
  values: Readonly<Record<`--${string}`, string | number>>,
): CSSProperties => values;
