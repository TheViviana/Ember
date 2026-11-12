import type { WindowFrame } from '../../kernel/ports.ts';

export type ResizeZone = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 坐标定义在 kernel 端口层，这里转出以保持既有导入路径不变 */
export type { WindowFrame };

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/** 与 tauri.conf.json 的 minWidth / minHeight 保持一致 */
export const MIN_WINDOW_SIZE: WindowSize = { width: 960, height: 640 };

export const RESIZE_ZONES: readonly ResizeZone[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * 自绘窗口缩放的核心几何：给定起始 frame 与指针位移，算出新 frame。
 * 纯函数，便于单测；西/北方向缩放时同步修正左上角坐标，并夹紧最小尺寸。
 */
export const resolveResize = (
  zone: ResizeZone,
  start: WindowFrame,
  deltaX: number,
  deltaY: number,
  min: WindowSize = MIN_WINDOW_SIZE,
): WindowFrame => {
  let width = start.width;
  let height = start.height;

  if (zone.includes('e')) width = start.width + deltaX;
  if (zone.includes('w')) width = start.width - deltaX;
  if (zone.includes('s')) height = start.height + deltaY;
  if (zone.includes('n')) height = start.height - deltaY;

  width = Math.max(min.width, width);
  height = Math.max(min.height, height);

  const x = zone.includes('w') ? start.x + (start.width - width) : start.x;
  const y = zone.includes('n') ? start.y + (start.height - height) : start.y;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
};

export const ZONE_CURSOR: Readonly<Record<ResizeZone, string>> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};
