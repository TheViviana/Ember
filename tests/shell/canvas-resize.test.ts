import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMutations, type CanvasNode, type CanvasRect, type CanvasScene } from '#canvas-engine';
import { asCanvasId } from '#doc-model';
import {
  NODE_MAX,
  NODE_MIN,
  RESIZE_CORNERS,
  RESIZE_HANDLE_PX,
  RESIZE_HIT_PX,
  hitTestResizeCorner,
  resizeHitRadius,
  resizeRect,
} from '../../src/shell/canvas/geometry.ts';

const CANVAS_ID = asCanvasId('01M74JZW7CQFP1CY70HTZFTYZD');
if (CANVAS_ID === null) throw new Error('测试画布 id 必须是合法 ULID');

const ORIGIN: CanvasRect = { x: 100, y: 50, w: 320, h: 200 };
const FREE = { keepAspect: false } as const;
const LOCKED = { keepAspect: true } as const;

void test('缩放手柄常量：视觉 10px、热区 16px，尺寸上下限固定', () => {
  assert.equal(RESIZE_HANDLE_PX, 10);
  assert.equal(RESIZE_HIT_PX, 16);
  assert.deepEqual(NODE_MIN, { w: 160, h: 100 });
  assert.deepEqual(NODE_MAX, { w: 2000, h: 2000 });
  assert.deepEqual([...RESIZE_CORNERS], ['nw', 'ne', 'sw', 'se']);
});

void test('四角缩放：对角固定，拖动边随光标移动', () => {
  assert.deepEqual(resizeRect(ORIGIN, 'se', { x: 500, y: 400 }, FREE), {
    x: 100,
    y: 50,
    w: 400,
    h: 350,
  });
  assert.deepEqual(resizeRect(ORIGIN, 'nw', { x: 0, y: 0 }, FREE), {
    x: 0,
    y: 0,
    w: 420,
    h: 250,
  });
  assert.deepEqual(resizeRect(ORIGIN, 'ne', { x: 500, y: 0 }, FREE), {
    x: 100,
    y: 0,
    w: 400,
    h: 250,
  });
  assert.deepEqual(resizeRect(ORIGIN, 'sw', { x: 0, y: 400 }, FREE), {
    x: 0,
    y: 50,
    w: 420,
    h: 350,
  });
});

void test('尺寸夹紧：低于下限停在 160×100，高于上限停在 2000×2000', () => {
  assert.deepEqual(resizeRect(ORIGIN, 'se', { x: 101, y: 49 }, FREE), {
    x: 100,
    y: 50,
    w: NODE_MIN.w,
    h: NODE_MIN.h,
  });
  assert.deepEqual(resizeRect(ORIGIN, 'se', { x: 99999, y: 99999 }, FREE), {
    x: 100,
    y: 50,
    w: NODE_MAX.w,
    h: NODE_MAX.h,
  });
  // 从左/上拖到极值外：左上角停在对角固定的位置，尺寸只到上限
  assert.deepEqual(resizeRect(ORIGIN, 'nw', { x: -99999, y: -99999 }, FREE), {
    x: ORIGIN.x + ORIGIN.w - NODE_MAX.w,
    y: ORIGIN.y + ORIGIN.h - NODE_MAX.h,
    w: NODE_MAX.w,
    h: NODE_MAX.h,
  });
});

void test('Shift 保持原宽高比：横向为主时按宽，纵向为主时按高', () => {
  // 原比例 320:200 = 1.6；纵向相对变化更大 → 由高度反推宽度
  const tall = resizeRect(ORIGIN, 'se', { x: 500, y: 400 }, LOCKED);
  assert.ok(Math.abs(tall.w / tall.h - 1.6) < 1e-9, `比例应保持，实际 ${tall.w}/${tall.h}`);
  assert.equal(tall.h, 350);
  assert.equal(tall.w, 560);

  // 横向相对变化更大 → 由宽度反推高度
  const wide = resizeRect(ORIGIN, 'se', { x: 900, y: 260 }, LOCKED);
  assert.ok(Math.abs(wide.w / wide.h - 1.6) < 1e-9, `比例应保持，实际 ${wide.w}/${wide.h}`);
  assert.equal(wide.w, 800);
  assert.equal(wide.h, 500);
});

void test('比例锁定时同样夹紧上下限，且宽度不会超过由高度上限反推的值', () => {
  const small = resizeRect(ORIGIN, 'se', { x: 101, y: 51 }, LOCKED);
  assert.deepEqual(small, { x: 100, y: 50, w: NODE_MIN.w, h: NODE_MIN.h });

  const huge = resizeRect(ORIGIN, 'se', { x: 99999, y: 99999 }, LOCKED);
  assert.equal(huge.w, NODE_MAX.w);
  assert.equal(huge.h, NODE_MAX.w / 1.6);

  // 极端宽扁比例：宽度先到 2000 上限，高度按比例停在 100
  const flat = resizeRect({ x: 0, y: 0, w: 2000, h: 100 }, 'se', { x: 99999, y: 99999 }, LOCKED);
  assert.equal(flat.w, NODE_MAX.w);
  assert.equal(flat.h, 100);
});

void test('手柄热区按 1/zoom 换算：zoom=0.25 时仍能点中 16px 屏幕热区', () => {
  for (const zoom of [0.25, 0.5, 1, 4]) {
    const radius = resizeHitRadius(zoom);
    assert.ok(Math.abs(radius * 2 * zoom - RESIZE_HIT_PX) < 1e-9, `zoom=${zoom} 的屏幕热区`);
  }

  const corner = { x: ORIGIN.x + ORIGIN.w, y: ORIGIN.y + ORIGIN.h };
  // 屏幕上 5px（zoom=0.25 → 世界 20px）应命中右下角
  assert.equal(
    hitTestResizeCorner(ORIGIN, { x: corner.x + 20, y: corner.y + 20 }, 0.25),
    'se',
  );
  // 屏幕上 10px（世界 40px）超出 8px 半径
  assert.equal(
    hitTestResizeCorner(ORIGIN, { x: corner.x + 40, y: corner.y + 40 }, 0.25),
    null,
  );
  // zoom=1 时 7px 命中、9px 落空
  assert.equal(hitTestResizeCorner(ORIGIN, { x: corner.x + 7, y: corner.y }, 1), 'se');
  assert.equal(hitTestResizeCorner(ORIGIN, { x: corner.x + 9, y: corner.y }, 1), null);
  // 四个角都能区分
  assert.equal(hitTestResizeCorner(ORIGIN, { x: ORIGIN.x, y: ORIGIN.y }, 1), 'nw');
  assert.equal(hitTestResizeCorner(ORIGIN, { x: ORIGIN.x + ORIGIN.w, y: ORIGIN.y }, 1), 'ne');
  assert.equal(hitTestResizeCorner(ORIGIN, { x: ORIGIN.x, y: ORIGIN.y + ORIGIN.h }, 1), 'sw');
});

const makeNode = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'note',
  docId: null,
  text: null,
  rect: { x: 0, y: 0, w: 200, h: 120 },
  z: 0,
  groupId: null,
  meta: {},
  ...overrides,
});

const makeScene = (nodes: readonly CanvasNode[]): CanvasScene => ({
  id: CANVAS_ID,
  title: '主页',
  viewport: { x: 0, y: 0, zoom: 1 },
  grid: { size: 8, snap: true },
  nodes,
  edges: [],
});

void test('松手提交的 updateNode 确实把缩放结果落进场景', () => {
  const scene = makeScene([makeNode('a', { rect: ORIGIN })]);
  const rect = resizeRect(ORIGIN, 'se', { x: 500, y: 400 }, FREE);
  const result = applyMutations(scene, [{ type: 'updateNode', id: 'a', patch: { rect } }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scene.nodes[0]?.rect, { x: 100, y: 50, w: 400, h: 350 });
});

void test('组节点缩放只改组框，不带动成员（成员是独立节点）', () => {
  const scene = makeScene([
    makeNode('g', { kind: 'group', rect: { x: 0, y: 0, w: 480, h: 320 } }),
    makeNode('m', { rect: { x: 24, y: 24, w: 200, h: 120 }, groupId: 'g' }),
  ]);
  const rect = resizeRect({ x: 0, y: 0, w: 480, h: 320 }, 'se', { x: 960, y: 640 }, FREE);
  const result = applyMutations(scene, [{ type: 'updateNode', id: 'g', patch: { rect } }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scene.nodes[0]?.rect, rect);
  assert.deepEqual(result.scene.nodes[1]?.rect, { x: 24, y: 24, w: 200, h: 120 });
});
