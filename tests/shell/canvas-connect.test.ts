import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasEdge, CanvasNode, CanvasScene } from '#canvas-engine';
import { asCanvasId } from '#doc-model';
import { planConnection } from '../../src/shell/canvas/commands.ts';
import {
  ANCHOR_HIT_PX,
  ANCHOR_INSET_PX,
  anchorHitRadius,
  anchorPoint,
  hitTestNodeWithAnchors,
  previewPath,
} from '../../src/shell/canvas/geometry.ts';

const CANVAS_ID = asCanvasId('01M74JZW7CQFP1CY70HTZFTYZD');
if (CANVAS_ID === null) throw new Error('测试画布 id 必须是合法 ULID');

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

const makeEdge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  from,
  to,
  label: null,
  arrow: 'end',
  kind: 'relation',
  meta: {},
});

const makeScene = (nodes: readonly CanvasNode[], edges: readonly CanvasEdge[] = []): CanvasScene => ({
  id: CANVAS_ID,
  title: '主页',
  viewport: { x: 0, y: 0, zoom: 1 },
  grid: { size: 8, snap: true },
  nodes,
  edges,
  bookmarks: [],
});

const idFactory = (): ((prefix: 'n' | 'e') => string) => {
  let seq = 0;
  return (prefix) => `${prefix}-${(seq += 1)}`;
};

void test('左锚点拖出 = 本节点指向目标；右锚点拖出 = 目标指向本节点', () => {
  const scene = makeScene([makeNode('a'), makeNode('b', { rect: { x: 400, y: 0, w: 200, h: 120 } })]);

  const left = planConnection(scene, 'a', 'left', 'b', idFactory());
  assert.equal(left?.kind, 'edge');
  assert.deepEqual(
    left?.kind === 'edge' ? { from: left.edge.from, to: left.edge.to, arrow: left.edge.arrow } : null,
    { from: 'a', to: 'b', arrow: 'end' },
  );

  const right = planConnection(scene, 'a', 'right', 'b', idFactory());
  assert.equal(right?.kind, 'edge');
  assert.deepEqual(
    right?.kind === 'edge' ? { from: right.edge.from, to: right.edge.to } : null,
    { from: 'b', to: 'a' },
  );
});

void test('松开在空白处（target=null）不建边', () => {
  const scene = makeScene([makeNode('a')]);
  assert.equal(planConnection(scene, 'a', 'left', null, idFactory()), null);
});

void test('拖回自己、拖到组、端点不存在都不建边', () => {
  const scene = makeScene([makeNode('a'), makeNode('g', { kind: 'group' })]);
  assert.equal(planConnection(scene, 'a', 'left', 'a', idFactory()), null);
  assert.equal(planConnection(scene, 'a', 'left', 'g', idFactory()), null);
  assert.equal(planConnection(scene, 'a', 'left', 'missing', idFactory()), null);
});

void test('反方向已有连线也算重复：返回已有边 id 而不是新建', () => {
  const scene = makeScene([makeNode('a'), makeNode('b')], [makeEdge('e1', 'a', 'b')]);
  const again = planConnection(scene, 'b', 'right', 'a', idFactory());
  assert.deepEqual(again, { kind: 'duplicate', edgeId: 'e1' });

  const reverse = planConnection(
    makeScene([makeNode('a'), makeNode('b')], [makeEdge('e2', 'b', 'a')]),
    'a',
    'left',
    'b',
    idFactory(),
  );
  assert.deepEqual(reverse, { kind: 'duplicate', edgeId: 'e2' });
});

void test('锚点坐标按 1/zoom 换算：屏幕上始终距节点边缘 4px', () => {
  const rect = { x: 100, y: 50, w: 200, h: 120 };
  for (const zoom of [0.1, 0.5, 1, 2, 4]) {
    const left = anchorPoint(rect, 'left', zoom);
    const right = anchorPoint(rect, 'right', zoom);
    assert.ok(Math.abs((rect.x - left.x) * zoom - ANCHOR_INSET_PX) < 1e-9, `zoom=${zoom} 左锚点偏移`);
    assert.ok(Math.abs((right.x - (rect.x + rect.w)) * zoom - ANCHOR_INSET_PX) < 1e-9, `zoom=${zoom} 右锚点偏移`);
    assert.equal(left.y, rect.y + rect.h / 2);
  }
});

void test('锚点热区不随缩小而变小：zoom=0.1 时世界半径放大，屏幕仍是 16px', () => {
  for (const zoom of [0.1, 0.25, 1, 4]) {
    const radius = anchorHitRadius(zoom);
    assert.ok(Math.abs(radius * 2 * zoom - ANCHOR_HIT_PX) < 1e-9, `zoom=${zoom} 热区屏幕尺寸`);
  }
});

void test('命中目标时把锚点外伸部分算进去（缩到 0.1 也能点到）', () => {
  const nodes = [makeNode('a', { rect: { x: 0, y: 0, w: 200, h: 120 } })];
  const zoom = 0.1;
  // 节点右侧边缘外 6 个屏幕像素处：世界坐标 60px，已经超出节点本体
  const point = { x: 200 + 6 / zoom, y: 60 };
  assert.equal(hitTestNodeWithAnchors(nodes, point, anchorHitRadius(zoom))?.id, 'a');
  // 再远 40 个屏幕像素就落空
  assert.equal(hitTestNodeWithAnchors(nodes, { x: 200 + 40 / zoom, y: 60 }, anchorHitRadius(zoom)), null);
});

void test('预览线是三次贝塞尔，起点终点与光标一致', () => {
  const path = previewPath({ x: 10, y: 20 }, { x: 310, y: 80 });
  assert.ok(path.startsWith('M 10 20 C '), `起点不对：${path}`);
  assert.ok(path.endsWith(', 310 80'), `终点不对：${path}`);
  // 反向拖动时控制点也翻到左侧，避免出现回勾
  assert.ok(previewPath({ x: 310, y: 80 }, { x: 10, y: 20 }).includes('C 160 80'));
});
