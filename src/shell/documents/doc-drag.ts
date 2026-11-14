/**
 * 文档面板拖拽的全局标志：dragstart 置位，dragend / drop 清除。
 * 面板的「点外面关闭」监听 window pointerdown；拖拽期间不得把面板关掉，
 * 否则拖到画布的一瞬间源列表消失、dragend 也可能丢失。
 */
let active = false;

export const beginDocDrag = (): void => {
  active = true;
};

export const endDocDrag = (): void => {
  active = false;
};

export const isDocDragActive = (): boolean => active;
