import {
  clampFloatSize,
  type FloatBounds,
  type FloatFrame,
  type FloatSize,
} from '../editor/float-layout.ts';

/**
 * 图库常驻浮窗的几何规则。
 * 位置与尺寸沿用文章浮窗的两张既有表：floatPositions.gallery = { left, top }，
 * floatSizes.gallery = { width, height }；不新增键、不占 FLOAT_LIMIT 名额。
 * 拖动与缩放本身复用 float-layout 的 moveFloatFrame / resolveFloatResize，这里只补安全区夹紧。
 */

export const GALLERY_KEY = 'gallery';
/** 与文章浮窗的右下 INSET 一致 */
export const GALLERY_MARGIN = 16;
/** 顶栏 */
export const GALLERY_TOP_RESERVE = 52;
/** 状态栏 28 + 左下横排 52 */
export const GALLERY_BOTTOM_RESERVE = 80;

export const GALLERY_MIN_WIDTH = 360;
export const GALLERY_MIN_HEIGHT = 280;
export const GALLERY_DEFAULT_WIDTH = 560;
export const GALLERY_DEFAULT_HEIGHT = 560;

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 安全区：扣掉顶栏、底部横排与状态栏、左右留白 */
export const galleryBounds = (viewport: Viewport): FloatBounds => {
  const maxWidth = Math.max(1, Math.round(viewport.width) - GALLERY_MARGIN * 2);
  const maxHeight = Math.max(
    1,
    Math.round(viewport.height) - GALLERY_TOP_RESERVE - GALLERY_BOTTOM_RESERVE,
  );
  return {
    maxWidth,
    maxHeight,
    // 窗口比下限还小时优先保证不压住结构件，允许继续收缩
    minWidth: Math.min(GALLERY_MIN_WIDTH, maxWidth),
    minHeight: Math.min(GALLERY_MIN_HEIGHT, maxHeight),
  };
};

/** 尺寸先夹到安全区，再把左上角夹回四边之内 */
export const clampGalleryFrame = (frame: FloatFrame, viewport: Viewport): FloatFrame => {
  const size = clampFloatSize(frame, galleryBounds(viewport));
  const maxLeft = Math.max(GALLERY_MARGIN, Math.round(viewport.width) - size.width - GALLERY_MARGIN);
  const maxTop = Math.max(
    GALLERY_TOP_RESERVE,
    Math.round(viewport.height) - GALLERY_BOTTOM_RESERVE - size.height,
  );
  return {
    left: Math.round(Math.min(maxLeft, Math.max(GALLERY_MARGIN, frame.left))),
    top: Math.round(Math.min(maxTop, Math.max(GALLERY_TOP_RESERVE, frame.top))),
    width: size.width,
    height: size.height,
  };
};

/** 默认停靠：安全区右下角，正好在横排与 HUD 上方 */
export const defaultGalleryFrame = (viewport: Viewport): FloatFrame =>
  clampGalleryFrame(
    {
      left: Math.round(viewport.width) - GALLERY_DEFAULT_WIDTH - GALLERY_MARGIN,
      top: Math.round(viewport.height) - GALLERY_BOTTOM_RESERVE - GALLERY_DEFAULT_HEIGHT,
      width: GALLERY_DEFAULT_WIDTH,
      height: GALLERY_DEFAULT_HEIGHT,
    },
    viewport,
  );

/** 记忆恢复：位置是 { left, top }、尺寸是 { width, height }，任缺一项按默认值补齐 */
export const galleryFrameFromMemory = (
  position: { readonly left: number; readonly top: number } | undefined,
  size: FloatSize | undefined,
  viewport: Viewport,
): FloatFrame => {
  if (position === undefined && size === undefined) return defaultGalleryFrame(viewport);
  const fallback = defaultGalleryFrame(viewport);
  return clampGalleryFrame(
    {
      left: position?.left ?? fallback.left,
      top: position?.top ?? fallback.top,
      width: size?.width ?? fallback.width,
      height: size?.height ?? fallback.height,
    },
    viewport,
  );
};
