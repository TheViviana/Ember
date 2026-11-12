import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasGrid, CanvasNode, CanvasRect } from '#canvas-engine';
import { changedRectOps, dragDrafts, snapDrafts } from '../../src/shell/canvas/gestures.ts';
import { resolveResizeCorner } from '../../src/shell/canvas/surface-hit.ts';

const rect = (x: number, y: number, w = 100, h = 60): CanvasRect => ({ x, y, w, h });

const node = (id: string, value: CanvasRect): CanvasNode => ({
  id,
  kind: 'note',
  rect: value,
  z: 0,
  docId: null,
  text: null,
  groupId: null,
  meta: {},
});

void test('dragDrafts 按同一位移平移全部选中节点，且不改动原始矩形', () => {
  const origins = new Map<string, CanvasRect>([
    ['a', rect(10, 20)],
    ['b', rect(-30, 5)],
  ]);

  const drafts = dragDrafts(origins, 12.5, -8);

  assert.deepEqual(drafts.get('a'), rect(22.5, 12));
  assert.deepEqual(drafts.get('b'), rect(-17.5, -3));
  assert.deepEqual(origins.get('a'), rect(10, 20), '拖动草稿不能原地修改 origins');
  assert.notEqual(drafts, origins);
});

void test('snapDrafts 按网格吸附位置但保留尺寸', () => {
  const drafts = new Map<string, CanvasRect>([['a', rect(10, 22, 133, 77)]]);

  const snapped = snapDrafts(drafts, { size: 16, snap: true });
  assert.deepEqual(snapped.get('a'), rect(16, 16, 133, 77), '只吸附 x/y，宽高原样保留');

  const off = snapDrafts(drafts, { size: 16, snap: false });
  assert.deepEqual(off.get('a'), rect(10, 22, 133, 77), '关闭吸附时原值返回');
});

void test('snapDrafts 的网格尺寸决定对齐步长', () => {
  const drafts = new Map<string, CanvasRect>([['a', rect(7, 9)]]);
  const eight: CanvasGrid = { size: 8, snap: true };
  const thirtyTwo: CanvasGrid = { size: 32, snap: true };

  assert.deepEqual(snapDrafts(drafts, eight).get('a'), rect(8, 8));
  assert.deepEqual(snapDrafts(drafts, thirtyTwo).get('a'), rect(0, 0));
});

void test('changedRectOps 只提交位置真正变化的节点', () => {
  const origins = new Map<string, CanvasRect>([
    ['moved', rect(0, 0)],
    ['same', rect(40, 40)],
  ]);
  const final = new Map<string, CanvasRect>([
    ['moved', rect(20, 30)],
    ['same', rect(40, 40)],
  ]);

  assert.deepEqual(changedRectOps(final, origins), [
    { type: 'updateNode', id: 'moved', patch: { rect: rect(20, 30) } },
  ]);
});

void test('changedRectOps 忽略没有原矩形的节点，尺寸变化也算变化', () => {
  const origins = new Map<string, CanvasRect>([['resized', rect(0, 0, 100, 60)]]);
  const final = new Map<string, CanvasRect>([
    ['resized', rect(0, 0, 120, 60)],
    ['unknown', rect(5, 5)],
  ]);

  assert.deepEqual(changedRectOps(final, origins), [
    { type: 'updateNode', id: 'resized', patch: { rect: rect(0, 0, 120, 60) } },
  ]);
});

void test('resolveResizeCorner 优先采用显式手柄属性', () => {
  const target = node('a', rect(0, 0));

  assert.equal(resolveResizeCorner(target, 'ne', { x: 500, y: 500 }, 1), 'ne');
  assert.equal(resolveResizeCorner(target, 'sw', { x: 0, y: 0 }, 1), 'sw', '属性优先于几何距离');
});

void test('resolveResizeCorner 无显式属性时按几何热区兜底', () => {
  const target = node('a', rect(0, 0));

  assert.equal(resolveResizeCorner(target, null, { x: 99, y: 59 }, 1), 'se');
  assert.equal(resolveResizeCorner(target, 'center', { x: 2, y: 3 }, 1), 'nw', '非法属性回落到几何命中');
  assert.equal(resolveResizeCorner(target, null, { x: 50, y: 30 }, 1), null, '节点中心不在任何手柄热区');
});

void test('resolveResizeCorner 对缺失节点返回 null', () => {
  assert.equal(resolveResizeCorner(undefined, 'se', { x: 100, y: 50 }, 1), null);
});
