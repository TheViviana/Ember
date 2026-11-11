import { unsafeVaultPath, type VaultPath } from '#doc-model';
import { layout } from '../theme/tokens.ts';

/** 浮窗几何与标题/文件名规则的纯函数，便于单测。 */

export interface FloatSize {
  readonly width: number;
  readonly height: number;
}

export interface FloatFrame extends FloatSize {
  readonly left: number;
  readonly top: number;
}

/** 只有四角可缩放：四边不设手柄（避免与拖窗、文本选择混淆） */
export type FloatZone = 'ne' | 'nw' | 'se' | 'sw';

export const FLOAT_ZONES: readonly FloatZone[] = ['ne', 'nw', 'se', 'sw'];

export const MIN_FLOAT_SIZE: FloatSize = {
  width: layout.floatMinWidth,
  height: layout.floatMinHeight,
};

export interface FloatBounds {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export interface FloatInset {
  readonly right: number;
  readonly bottom: number;
}

export interface FloatContainer {
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** 夹紧到 [最小值, 当前显示器工作区]；非有限值回落到最小值。 */
export const clampFloatSize = (size: FloatSize, bounds: FloatBounds): FloatSize => {
  const minWidth = bounds.minWidth ?? MIN_FLOAT_SIZE.width;
  const minHeight = bounds.minHeight ?? MIN_FLOAT_SIZE.height;
  const maxWidth = Math.max(minWidth, bounds.maxWidth);
  const maxHeight = Math.max(minHeight, bounds.maxHeight);
  const width = Number.isFinite(size.width) ? size.width : minWidth;
  const height = Number.isFinite(size.height) ? size.height : minHeight;
  return {
    width: Math.round(clamp(width, minWidth, maxWidth)),
    height: Math.round(clamp(height, minHeight, maxHeight)),
  };
};

/**
 * 四角缩放：对角固定。
 * 西/北方向被夹紧时，左上角停在原位置减去最终宽高的位置，手柄不会越过对角。
 */
export const resolveFloatResize = (
  zone: FloatZone,
  start: FloatFrame,
  deltaX: number,
  deltaY: number,
  bounds: FloatBounds,
): FloatFrame => {
  const width = zone.includes('e') ? start.width + deltaX : start.width - deltaX;
  const height = zone.includes('s') ? start.height + deltaY : start.height - deltaY;

  const size = clampFloatSize({ width, height }, bounds);
  const left = zone.includes('w') ? start.left + (start.width - size.width) : start.left;
  const top = zone.includes('n') ? start.top + (start.height - size.height) : start.top;

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: size.width,
    height: size.height,
  };
};

/**
 * 拖动浮窗：整块留在容器内；比容器还大时，横向压到容器边界、纵向钉住顶边，
 * 保证标题栏始终可见（不会把窗口拖出可视区后找不回来）。
 */
const clampAxis = (value: number, size: number, span: number, floorAtStart: boolean): number => {
  if (!Number.isFinite(span) || span <= 0) return value;
  const room = span - size;
  if (room >= 0) return clamp(value, 0, room);
  return floorAtStart ? 0 : clamp(value, room, 0);
};

export const moveFloatFrame = (
  start: FloatFrame,
  deltaX: number,
  deltaY: number,
  container: FloatContainer,
): FloatFrame => ({
  left: Math.round(clampAxis(start.left + deltaX, start.width, container.width, false)),
  top: Math.round(clampAxis(start.top + deltaY, start.height, container.height, true)),
  width: start.width,
  height: start.height,
});

/** 首次打开时靠右下角摆放；之后尺寸与位置由 docId 记忆恢复。 */
export const initialFloatFrame = (
  container: FloatContainer,
  size: FloatSize,
  inset: FloatInset,
): FloatFrame => ({
  left: Math.round(container.width - size.width - inset.right),
  top: Math.round(container.height - size.height - inset.bottom),
  width: Math.round(size.width),
  height: Math.round(size.height),
});

/** 默认层叠步长：新窗相对上一扇向左上偏移的像素 */
export const CASCADE_STEP_PX = 32;

/** 默认层叠最多尝试的额外步数；仍冲突时接受重合，交给窗口切换器兜底 */
export const CASCADE_MAX_STEPS = 5;

/**
 * 没有位置记忆时的默认层叠：从右下角起，按槽位向左上偏移，并夹紧在容器内。
 * `occupied` 传入当前已开窗口的矩形；完全重合时继续步进，最多额外试 5 次。
 */
export const cascadeFloatFrame = (
  container: FloatContainer,
  size: FloatSize,
  inset: FloatInset,
  slot: number,
  occupied: readonly FloatFrame[] = [],
): FloatFrame => {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const roomLeft = Math.max(0, Math.round(container.width - width));
  const roomTop = Math.max(0, Math.round(container.height - height));
  const originLeft = container.width - width - inset.right;
  const originTop = container.height - height - inset.bottom;
  const at = (index: number): FloatFrame => ({
    left: Math.round(clamp(originLeft - index * CASCADE_STEP_PX, 0, roomLeft)),
    top: Math.round(clamp(originTop - index * CASCADE_STEP_PX, 0, roomTop)),
    width,
    height,
  });
  const start = Math.max(0, Math.trunc(slot));
  for (let attempt = 0; attempt <= CASCADE_MAX_STEPS; attempt += 1) {
    const candidate = at(start + attempt);
    const collides = occupied.some(
      (other) => other.left === candidate.left && other.top === candidate.top,
    );
    if (!collides) return candidate;
  }
  return at(start + CASCADE_MAX_STEPS);
};

/**
 * 标题过长时中间省略：前半段可收缩并带省略号，后半段保持可见。
 * 拆分只发生在字符之间，不改变原始标题。
 */
export const splitTitleForEllipsis = (title: string): { readonly head: string; readonly tail: string } => {
  const chars = [...title];
  if (chars.length <= 2) return { head: title, tail: '' };
  const split = Math.ceil(chars.length / 2);
  return { head: chars.slice(0, split).join(''), tail: chars.slice(split).join('') };
};

const NAME_MAX = 80;
const UNTITLED = '未命名';
const MAX_NAME_ATTEMPTS = 50;

/** 文件名只保留安全字符；空标题回落「未命名」。 */
export const titleFileName = (title: string): string => {
  const cleaned = [...title]
    .map((char) => ('\\/:*?"<>|'.includes(char) || char.charCodeAt(0) < 32 ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/\.md$/i, '')
    .trim();
  return cleaned.length === 0 ? UNTITLED : cleaned.slice(0, NAME_MAX);
};

/**
 * 标题改名时同步文件名：保留原目录与 .md 后缀。
 * 同名冲突依次尝试 `名称-2.md`、`名称-3.md`……；与当前路径相同的候选优先返回（无需 rename）。
 */
export const titlePathCandidates = (currentPath: VaultPath, title: string): readonly VaultPath[] => {
  const text = String(currentPath);
  const slash = text.lastIndexOf('/');
  const dir = slash >= 0 ? text.slice(0, slash + 1) : '';
  const currentName = slash >= 0 ? text.slice(slash + 1) : text;
  const name = titleFileName(title);
  const currentStem = currentName.replace(/\.md$/i, '');

  const candidates: VaultPath[] = [];
  if (currentStem === name) candidates.push(currentPath);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    candidates.push(unsafeVaultPath(`${dir}${name}${suffix}.md`));
  }
  return candidates;
};
