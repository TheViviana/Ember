/** 菜单与视口边缘的最小间距（与画布右键子菜单的留白一致） */
export const DOC_MENU_INSET = 8;

/** 锚点：被右键条目的 getBoundingClientRect（视口坐标） */
export interface DocMenuAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

export interface DocMenuViewport {
  readonly width: number;
  readonly height: number;
}

export interface DocMenuPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * 右键菜单定位：菜单挂在 body 上（position: fixed），所以坐标一律按视口算。
 * 顶边对齐被右键的条目；下方放不下时整体上移，使底边对齐条目底边；
 * 四边超出视口时夹住不出界，宽度继承条目宽度并随视口收窄。
 */
export const placeDocMenu = (
  anchor: DocMenuAnchor,
  height: number,
  viewport: DocMenuViewport,
): DocMenuPlacement => {
  const width = Math.min(anchor.width, Math.max(0, viewport.width - DOC_MENU_INSET * 2));
  const left = clamp(anchor.left, DOC_MENU_INSET, Math.max(DOC_MENU_INSET, viewport.width - DOC_MENU_INSET - width));
  const bottomLimit = viewport.height - DOC_MENU_INSET;
  const top =
    anchor.top + height <= bottomLimit
      ? anchor.top
      : clamp(anchor.bottom - height, DOC_MENU_INSET, Math.max(DOC_MENU_INSET, bottomLimit - height));
  return { left, top, width };
};
