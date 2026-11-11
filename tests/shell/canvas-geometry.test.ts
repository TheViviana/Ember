import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasEdge, CanvasNode, CanvasRect, CanvasScene, Viewport } from '#canvas-engine';
import { asCanvasId } from '#doc-model';
import {
  boundsOfRects,
  clampZoom,
  distanceToEdge,
  edgeGeometry,
  fitViewport,
  hitTestEdge,
  hitTestNode,
  nodesInRect,
  normalizeRect,
  orderedNodes,
  rectsIntersect,
  screenToWorld,
  snapRect,
  snapValue,
  worldToScreen,
  zoomAt,
} from '../../src/shell/canvas/geometry.ts';

const node = (
  id: string,
  rect: CanvasRect,
  z = 0,
  kind: CanvasNode['kind'] = 'note',
): CanvasNode => ({
  id,
  kind,
  rect,
  z,
  docId: null,
  text: null,
  groupId: null,
  meta: {},
});

const close = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}：期望 ${expected}，实际 ${actual}`);
};

void test('屏幕坐标与世界坐标互为逆变换', () => {
  const viewport: Viewport = { x: 120, y: -40, zoom: 2.5 };
  const world = screenToWorld({ x: 400, y: 300 }, viewport);
  close(world.x, 112, 'world.x');
  close(world.y, 136, 'world.y');

  const back = worldToScreen(world, viewport);
  close(back.x, 400, 'screen.x');
  close(back.y, 300, 'screen.y');

  assert.deepEqual(worldToScreen({ x: 0, y: 0 }, viewport), { x: 120, y: -40 });
});

void test('以光标为锚点缩放：锚点下的世界坐标保持不动', () => {
  const base: Viewport = { x: 30, y: -15, zoom: 1 };
  const anchors = [
    { x: 0, y: 0 },
    { x: 640, y: 360 },
    { x: 123.5, y: 77.25 },
  ];
  for (const anchor of anchors) {
    const before = screenToWorld(anchor, base);
    for (const factor of [1.25, 0.5, 2.4]) {
      const next = zoomAt(base, anchor, factor);
      close(next.zoom, clampZoom(base.zoom * factor), `锚点 ${anchor.x}/${anchor.y} 缩放`);
      const after = screenToWorld(anchor, next);
      close(after.x, before.x, `锚点 ${anchor.x}/${anchor.y} factor ${factor} 的 x`);
      close(after.y, before.y, `锚点 ${anchor.x}/${anchor.y} factor ${factor} 的 y`);
    }
  }
});

void test('缩放被夹紧在 0.1–4，到边界时返回原对象', () => {
  const cases: readonly { zoom: number; factor: number; expected: number }[] = [
    { zoom: 0.05, factor: 1, expected: 0.1 },
    { zoom: 0.1, factor: 0.5, expected: 0.1 },
    { zoom: 1, factor: 1, expected: 1 },
    { zoom: 3, factor: 4, expected: 4 },
    { zoom: 9, factor: 2, expected: 4 },
  ];
  for (const item of cases) {
    assert.equal(clampZoom(item.zoom * item.factor), item.expected);
  }

  const maxed: Viewport = { x: 5, y: 6, zoom: 4 };
  assert.equal(zoomAt(maxed, { x: 10, y: 10 }, 2), maxed);
  const minimum: Viewport = { x: 5, y: 6, zoom: 0.1 };
  assert.equal(zoomAt(minimum, { x: 10, y: 10 }, 0.5), minimum);
});

void test('网格吸附只改位置：关闭时原样返回同一对象', () => {
  const grid = { size: 16 as const, snap: true };
  assert.equal(snapValue(23, grid), 16);
  assert.equal(snapValue(25, grid), 32);
  assert.equal(snapValue(-9, grid), -16);

  const rect: CanvasRect = { x: 23, y: 25, w: 320, h: 200 };
  assert.deepEqual(snapRect(rect, grid), { x: 16, y: 32, w: 320, h: 200 });

  const off = { size: 16 as const, snap: false };
  assert.equal(snapValue(23, off), 23);
  assert.equal(snapRect(rect, off), rect);
});

void test('两点归一化：四个方向都得到左上角原点 + 非负宽高', () => {
  const expected: CanvasRect = { x: 10, y: 20, w: 90, h: 80 };
  assert.deepEqual(normalizeRect({ x: 10, y: 20 }, { x: 100, y: 100 }), expected);
  assert.deepEqual(normalizeRect({ x: 100, y: 100 }, { x: 10, y: 20 }), expected);
  assert.deepEqual(normalizeRect({ x: 100, y: 20 }, { x: 10, y: 100 }), expected);
  assert.deepEqual(normalizeRect({ x: 10, y: 100 }, { x: 100, y: 20 }), expected);
});

void test('矩形相交：部分重叠与贴边算命中，完全错开不算', () => {
  const base: CanvasRect = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(rectsIntersect(base, { x: 50, y: 50, w: 100, h: 100 }), true);
  assert.equal(rectsIntersect(base, { x: 100, y: 0, w: 20, h: 20 }), true);
  assert.equal(rectsIntersect(base, { x: 101, y: 0, w: 20, h: 20 }), false);
  assert.equal(rectsIntersect(base, { x: 200, y: 200, w: 10, h: 10 }), false);
});

void test('框选排除组节点，组仍然可以被点击命中', () => {
  const nodes = [
    node('n1', { x: 0, y: 0, w: 100, h: 100 }, 1),
    node('n2', { x: 400, y: 400, w: 100, h: 100 }, 2),
    node('g1', { x: -50, y: -50, w: 600, h: 600 }, 0, 'group'),
  ];
  const marquee: CanvasRect = { x: -10, y: -10, w: 150, h: 150 };
  assert.deepEqual(
    nodesInRect(nodes, marquee).map((item) => item.id),
    ['n1'],
  );
  assert.equal(hitTestNode(nodes, { x: 20, y: 20 })?.id, 'n1');
  // 没有成员覆盖时，组本身仍然可点
  assert.equal(hitTestNode(nodes, { x: 540, y: 540 })?.id, 'g1');
});

void test('绘制顺序：组永远在非组之下，同层按 z 升序', () => {
  const nodes = [
    node('n1', { x: 0, y: 0, w: 10, h: 10 }, 5),
    node('g1', { x: 0, y: 0, w: 10, h: 10 }, 9, 'group'),
    node('n0', { x: 0, y: 0, w: 10, h: 10 }, -1),
    node('g0', { x: 0, y: 0, w: 10, h: 10 }, 2, 'group'),
  ];
  assert.deepEqual(
    orderedNodes(nodes).map((item) => item.id),
    ['g0', 'g1', 'n0', 'n1'],
  );
  assert.deepEqual(nodes.map((item) => item.id), ['n1', 'g1', 'n0', 'g0'], '不修改入参');
});

void test('连线命中：按贝塞尔距离判定，阈值内取最近一条', () => {
  const canvasId = asCanvasId('01M74JZW7CQFP1CY70HTZFTYZD');
  if (canvasId === null) throw new Error('测试画布 id 必须是合法 ULID');
  const from: CanvasRect = { x: 528, y: 280, w: 320, h: 200 };
  const to: CanvasRect = { x: 328, y: 584, w: 320, h: 200 };

  assert.ok(distanceToEdge(from, to, { x: 588, y: 532 }) < 1, '贝塞尔中点应落在路径上');
  const offset = distanceToEdge(from, to, { x: 588, y: 562 });
  assert.ok(offset > 20 && offset < 40, `垂直偏移 30 时距离应接近 30，实际 ${offset}`);

  const edge: CanvasEdge = {
    id: 'e1',
    from: 'a',
    to: 'b',
    label: null,
    arrow: 'end',
    kind: 'relation',
    meta: {},
  };
  const scene: CanvasScene = {
    id: canvasId,
    title: '主页',
    viewport: { x: 0, y: 0, zoom: 1 },
    grid: { size: 8, snap: true },
    nodes: [node('a', from, 0), node('b', to, 1)],
    edges: [edge],
  };
  assert.equal(hitTestEdge(scene, { x: 600, y: 532 }, 12), 'e1');
  assert.equal(hitTestEdge(scene, { x: 588, y: 562 }, 12), null);
  assert.equal(hitTestEdge(scene, { x: 600, y: 532 }, 5), 'e1');
});

void test('包围盒与适应视口：内容居中，缩放不超过 100% 且不低于下限', () => {
  assert.equal(boundsOfRects([]), null);
  assert.deepEqual(
    boundsOfRects([
      { x: 10, y: 20, w: 100, h: 50 },
      { x: 200, y: 30, w: 50, h: 200 },
    ]),
    { x: 10, y: 20, w: 240, h: 210 },
  );

  const fitted = fitViewport({ x: 1000, y: 1000, w: 400, h: 300 }, { w: 1000, h: 800 }, 80);
  close(fitted.zoom, 1, '内容小于可视区时不放大');
  close(fitted.x + 1200 * fitted.zoom, 500, '内容中心 x');
  close(fitted.y + 1150 * fitted.zoom, 400, '内容中心 y');

  const shrunk = fitViewport({ x: 0, y: 0, w: 4000, h: 3000 }, { w: 1000, h: 800 }, 80);
  assert.ok(shrunk.zoom < 1);
  const clamped = fitViewport({ x: 0, y: 0, w: 1e7, h: 1e7 }, { w: 100, h: 100 }, 80);
  assert.equal(clamped.zoom, 0.1);
});

void test('点击命中取 z 最大的节点，空白返回 null', () => {
  const nodes = [
    node('low', { x: 0, y: 0, w: 200, h: 200 }, 1),
    node('high', { x: 50, y: 50, w: 200, h: 200 }, 5),
  ];
  assert.equal(hitTestNode(nodes, { x: 60, y: 60 })?.id, 'high');
  assert.equal(hitTestNode(nodes, { x: 10, y: 10 })?.id, 'low');
  assert.equal(hitTestNode(nodes, { x: 900, y: 900 }), null);
});

void test('连线从面向对方的边出发，反向与纵向都成立', () => {
  const left: CanvasRect = { x: 0, y: 0, w: 100, h: 100 };
  const right: CanvasRect = { x: 300, y: 0, w: 100, h: 100 };

  const forward = edgeGeometry(left, right);
  assert.equal(forward.path, 'M 100 50 C 200 50, 200 50, 300 50');
  assert.deepEqual(forward.label, { x: 200, y: 50 });

  const backward = edgeGeometry(right, left);
  assert.equal(backward.path, 'M 300 50 C 200 50, 200 50, 100 50');

  const down = edgeGeometry(left, { x: 0, y: 300, w: 100, h: 100 });
  assert.equal(down.path, 'M 50 100 C 50 200, 50 200, 50 300');
  assert.deepEqual(down.label, { x: 50, y: 200 });
});
