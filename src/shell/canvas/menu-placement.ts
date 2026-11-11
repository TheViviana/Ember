/** 子菜单贴边留白与父菜单重叠量（与 ContextMenu.module.css 的视觉间隙一致） */
export const MENU_EDGE_INSET = 8;
export const SUBMENU_OVERLAP = 4;

export interface MenuSize {
  readonly width: number;
  readonly height: number;
}

export interface MenuLevelBox {
  /** 相对容器（画布可视区）的坐标 */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SubmenuPlacementInput {
  /** 容器尺寸：画布可视区 */
  readonly container: MenuSize;
  /** 当前菜单层相对容器的位置与尺寸 */
  readonly level: MenuLevelBox;
  /** 鼠标所在项相对容器的上下边缘 */
  readonly anchor: { readonly top: number; readonly bottom: number };
  /** 子菜单自然尺寸 */
  readonly submenu: MenuSize;
}

export interface SubmenuPlacement {
  /** 右缘放不下时向左翻 */
  readonly side: 'left' | 'right';
  /** 相对容器的绝对坐标（测试与调试用） */
  readonly left: number;
  readonly top: number;
  /** 相对当前菜单层的偏移：top 与水平偏移 */
  readonly relativeTop: number;
  readonly horizontalOffset: number;
  /** 高度夹紧后的上限，超出部分由调用方滚动 */
  readonly maxHeight: number;
}

/**
 * 子菜单定位：贴住鼠标所在项、右缘不够向左翻、下缘不够向上移、高度夹紧在容器内。
 * 纯函数，多级菜单每级都以父层为参照递归调用。
 */
export const placeSubmenu = ({
  container,
  level,
  anchor,
  submenu,
}: SubmenuPlacementInput): SubmenuPlacement => {
  const inset = MENU_EDGE_INSET;
  const overlap = SUBMENU_OVERLAP;
  const containerWidth = Math.max(inset * 2 + 1, container.width);
  const containerHeight = Math.max(inset * 2 + 1, container.height);

  // 优先向右展开；右侧放不下且左侧放得下时向左翻
  const rightLeft = level.left + level.width - overlap;
  const leftLeft = level.left + overlap - submenu.width;
  const fitsRight = rightLeft + submenu.width <= containerWidth - inset;
  const fitsLeft = leftLeft >= inset;
  const side: 'left' | 'right' = fitsRight || !fitsLeft ? 'right' : 'left';
  const maxLeft = Math.max(inset, containerWidth - inset - submenu.width);
  const left = Math.min(Math.max(side === 'right' ? rightLeft : leftLeft, inset), maxLeft);

  // 高度先夹紧到容器内，再按项位置放下；下缘不够时整体上移
  const maxHeight = containerHeight - inset * 2;
  const height = Math.min(submenu.height, maxHeight);
  const limit = containerHeight - inset;
  let top = anchor.top - overlap;
  if (top + height > limit) {
    top = Math.min(anchor.bottom + overlap - height, limit - height);
  }
  top = Math.max(inset, Math.min(top, limit - height));

  return {
    side,
    left,
    top,
    relativeTop: top - level.top,
    horizontalOffset: level.width - overlap,
    maxHeight,
  };
};
