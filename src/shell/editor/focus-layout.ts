import { MIN_FLOAT_SIZE, type FloatContainer, type FloatFrame } from './float-layout.ts';

/** 专注视图与容器边缘的留白：48 是既有 24 的整数倍，视觉节奏与 --space-xl 一致 */
export const FOCUS_MARGIN_PX = 48;

/**
 * 专注几何：在容器内居中并尽量放大，四周留出固定留白。
 * 容器比浮窗最小尺寸还小时先保证铺满容器，不产生负尺寸；
 * 纯函数，不读写机器状态 —— 专注期间的真实几何只活在内存里。
 */
export const focusedFloatFrame = (
  container: FloatContainer,
  margin: number = FOCUS_MARGIN_PX,
): FloatFrame => {
  const width = Math.max(1, Math.round(container.width));
  const height = Math.max(1, Math.round(container.height));
  const gap = Math.max(0, Math.round(margin));
  const frameWidth = Math.min(width, Math.max(MIN_FLOAT_SIZE.width, width - gap * 2));
  const frameHeight = Math.min(height, Math.max(MIN_FLOAT_SIZE.height, height - gap * 2));
  return {
    left: Math.round((width - frameWidth) / 2),
    top: Math.round((height - frameHeight) / 2),
    width: frameWidth,
    height: frameHeight,
  };
};
