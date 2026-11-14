/** 菜单与视口边缘的最小间距（与画布右键子菜单的留白一致） */
export const DOC_MENU_INSET = 8;

/** 内容再窄也不低于此宽度（与 CSS 的 min-width 保持一致） */
export const DOC_MENU_MIN_WIDTH = 160;

/** 锚点：被右键条目的 getBoundingClientRect（视口坐标） */
export interface DocMenuAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export interface DocMenuViewport {
  readonly width: number;
  readonly height: number;
}

export interface DocMenuPlacement {
  readonly left: number;
  readonly top: number;
  /** 右缘到视口留白的可用宽度；菜单自身宽度由内容决定 */
  readonly maxWidth: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * 右键菜单定位：菜单挂在 body 上（position: fixed），所以坐标一律按视口算。
 * 左边对齐被右键的条目，宽度交给内容自适应（不继承行宽，允许越过面板边界）；
 * 下方放不下时整体上移，使底边对齐条目底边；四边超出视口时夹住不出界。
 */
export const placeDocMenu = (
  anchor: DocMenuAnchor,
  height: number,
  viewport: DocMenuViewport,
): DocMenuPlacement => {
  const left = clamp(
    anchor.left,
    DOC_MENU_INSET,
    Math.max(DOC_MENU_INSET, viewport.width - DOC_MENU_INSET - DOC_MENU_MIN_WIDTH),
  );
  const bottomLimit = viewport.height - DOC_MENU_INSET;
  const top =
    anchor.top + height <= bottomLimit
      ? anchor.top
      : clamp(anchor.bottom - height, DOC_MENU_INSET, Math.max(DOC_MENU_INSET, bottomLimit - height));
  const maxWidth = Math.max(DOC_MENU_MIN_WIDTH, viewport.width - DOC_MENU_INSET - left);
  return { left, top, maxWidth };
};
