import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMutations,
  parseCanvasDocument,
  toCanvasFile,
  validateScene,
  type CanvasEdge,
  type CanvasNode,
  type CanvasScene,
} from '#canvas-engine';
import { asCanvasId, createUlid } from '#doc-model';

const scene = (overrides: Partial<CanvasScene> = {}): CanvasScene => {
  const id = asCanvasId(String(createUlid(1_700_000_000_000)));
  if (id === null) throw new Error('ULID 非法');
  return {
    id,
    title: '主页',
    viewport: { x: 0, y: 0, zoom: 1 },
    grid: { size: 16, snap: false },
    nodes: [],
    edges: [],
    ...overrides,
  };
};

const node = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'note',
  rect: { x: 10, y: 20, w: 200, h: 120 },
  z: 0,
  docId: null,
  text: '便签',
  groupId: null,
  meta: {},
  ...overrides,
});

const edge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  from,
  to,
  label: null,
  arrow: 'end',
  kind: 'relation',
  meta: {},
});

void test('解析磁盘格式：扁平 x/y/w/h 收成 rect，缺 grid 用默认值', () => {
  const id = String(createUlid(1_700_000_000_000));
  const parsed = parseCanvasDocument({
    schemaVersion: 1,
    id,
    title: '主页',
    viewport: { x: 1, y: 2, zoom: 1 },
    nodes: [{ id: 'n1', kind: 'note', text: 'hi', x: 5, y: 6, w: 200, h: 120, z: 3 }],
    edges: [],
  });

  assert.equal(parsed.ok, true);
  const document = parsed.document;
  assert.ok(document !== null);
  assert.deepEqual(document.scene.grid, { size: 8, snap: true });
  assert.deepEqual(document.scene.nodes[0]?.rect, { x: 5, y: 6, w: 200, h: 120 });
  assert.equal(document.scene.nodes[0]?.groupId, null);
  assert.equal(document.scene.edges.length, 0);
});

void test('序列化再解析保持节点/边/网格/能力数据不变', () => {
  const base = scene({
    nodes: [
      node('g1', { kind: 'group', rect: { x: 0, y: 0, w: 640, h: 480 }, text: '组' }),
      node('n1', { z: 1, groupId: 'g1', meta: { color: 'blue' } }),
      node('n2', { z: 2 }),
    ],
    edges: [{ ...edge('e1', 'n1', 'n2'), label: '引用', arrow: 'both', meta: { weight: 2 } }],
  });
  const document = {
    schemaVersion: 1 as const,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T01:00:00.000Z',
    scene: base,
    capabilityData: { 'ember.graph': { pinned: true } },
  };

  const parsed = parseCanvasDocument(toCanvasFile(document));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.document?.scene, base);
  assert.deepEqual(parsed.document?.capabilityData, { 'ember.graph': { pinned: true } });
  assert.equal(parsed.document?.createdAt, '2026-11-11T00:00:00.000Z');
});

void test('校验：组不能嵌套、不能悬空 groupId、不能重复同向边、边不能连组', () => {
  const nested = scene({
    nodes: [
      node('g1', { kind: 'group' }),
      node('g2', { kind: 'group', groupId: 'g1' }),
      node('n1', { groupId: 'ghost' }),
    ],
  });
  const codes = validateScene(nested).map((issue) => issue.code);
  assert.ok(codes.includes('group_nesting'));
  assert.ok(codes.includes('group_missing'));

  const duplicate = scene({
    nodes: [node('n1'), node('n2'), node('g1', { kind: 'group' })],
    edges: [edge('e1', 'n1', 'n2'), edge('e2', 'n1', 'n2'), edge('e3', 'n1', 'g1')],
  });
  const duplicateCodes = validateScene(duplicate).map((issue) => issue.code);
  assert.ok(duplicateCodes.includes('duplicate_edge'));
  assert.ok(duplicateCodes.includes('edge_group_endpoint'));
});

void test('applyMutations 是纯函数：不改入参，失败时原样返回', () => {
  const base = scene({ nodes: [node('n1')] });
  const frozen = JSON.stringify(base);

  const moved = applyMutations(base, [
    { type: 'updateNode', id: 'n1', patch: { rect: { x: 100, y: 100, w: 300, h: 200 } } },
  ]);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.scene.nodes[0]?.rect, { x: 100, y: 100, w: 300, h: 200 });
  assert.equal(JSON.stringify(base), frozen);

  const rejected = applyMutations(base, [
    { type: 'addEdge', edge: edge('e1', 'n1', 'n1') },
  ]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.scene, base);
  assert.equal(rejected.issues[0]?.code, 'edge_self_loop');
});

void test('整批 mutation 只允许视口变更时才标记 viewportOnly', () => {
  const base = scene({ nodes: [node('n1')] });
  assert.equal(applyMutations(base, [{ type: 'setViewport', viewport: { x: 1, y: 1, zoom: 2 } }]).viewportOnly, true);
  assert.equal(
    applyMutations(base, [
      { type: 'setViewport', viewport: { x: 1, y: 1, zoom: 2 } },
      { type: 'setTitle', title: '新标题' },
    ]).viewportOnly,
    false,
  );
});
