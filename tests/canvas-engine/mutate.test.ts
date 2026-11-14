import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMutations } from '../../packages/canvas-engine/src/mutate.ts';
import type { CanvasEdge, CanvasNode, CanvasScene } from '../../packages/canvas-engine/src/types.ts';
import { validateScene } from '../../packages/canvas-engine/src/validate.ts';
import { asCanvasId, unsafeDocId } from '../../packages/doc-model/src/ids.ts';

const node = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'note',
  docId: null,
  text: null,
  rect: { x: 0, y: 0, w: 200, h: 150 },
  z: 0,
  groupId: null,
  meta: {},
  ...overrides,
});

const edge = (id: string, from: string, to: string, overrides: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id,
  from,
  to,
  label: null,
  arrow: 'end',
  kind: 'relation',
  meta: {},
  ...overrides,
});

const scene = (): CanvasScene => ({
  id: asCanvasId('01JB8ZQ3K4M5N6P7Q8R9S0T1V5') ?? (undefined as never),
  title: '测试画布',
  viewport: { x: 0, y: 0, zoom: 1 },
  grid: { size: 8, snap: true },
  nodes: [node('n1'), node('n2'), node('g1', { kind: 'group', rect: { x: 0, y: 0, w: 400, h: 300 } }), node('m1', { groupId: 'g1' })],
  edges: [edge('e1', 'n1', 'n2')],
bookmarks: [],
});

void test('整批拒绝：批次里任何一步非法，整批不生效并返回原场景（V5）', () => {
  const base = scene();
  const result = applyMutations(base, [
    { type: 'addNode', node: node('n3') },
    { type: 'updateNode', id: 'missing', patch: { text: 'x' } },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.scene, base, '失败时返回入参原样场景');
  assert.deepEqual(result.scene.nodes.map((item) => item.id), ['n1', 'n2', 'g1', 'm1'], 'addNode 也被整批回滚');
});

void test('removeNodes 级联：删节点连带删边，删组解散成员', () => {
  const base = scene();
  const result = applyMutations(base, [{ type: 'removeNodes', ids: ['n1', 'g1'] }]);
  assert.equal(result.ok, true);
  // n1 被删 → e1（端点 n1）连带删除；g1 被删 → m1 解散组但保留
  assert.deepEqual(result.scene.nodes.map((item) => item.id), ['n2', 'm1']);
  assert.deepEqual(result.scene.edges, []);
  assert.equal(result.scene.nodes.find((item) => item.id === 'm1')?.groupId, null);
});

void test('updateNode 可把文档节点转为普通 note：kind/docId 同步变更，其它字段与连线不动', () => {
  const docNode = node('d1', { kind: 'doc', docId: unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V6'), text: null });
  const base: CanvasScene = {
    ...scene(),
    nodes: [docNode, node('n2')],
    edges: [edge('e1', 'd1', 'n2')],
  };
  const result = applyMutations(base, [
    { type: 'updateNode', id: 'd1', patch: { kind: 'note', docId: null, text: '已删除的文章' } },
  ]);
  assert.equal(result.ok, true);
  const converted = result.scene.nodes.find((item) => item.id === 'd1');
  assert.equal(converted?.kind, 'note');
  assert.equal(converted?.docId, null);
  assert.equal(converted?.text, '已删除的文章');
  assert.deepEqual(converted?.rect, docNode.rect, '位置尺寸不变');
  assert.deepEqual(result.scene.edges, base.edges, '连线不受影响');
  assert.deepEqual(validateScene(result.scene), [], '转换后的整场景必须通过 validate');
});

void test('只改 kind 不改 docId 会被整场景校验拒绝（§8.2）', () => {
  const base: CanvasScene = {
    ...scene(),
    nodes: [node('d1', { kind: 'doc', docId: unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V6'), text: null })],
    edges: [],
  };
  const result = applyMutations(base, [{ type: 'updateNode', id: 'd1', patch: { kind: 'note' } }]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_node_doc'));
});

void test('addNode 重复 id 被整场景校验拒绝', () => {
  const result = applyMutations(scene(), [{ type: 'addNode', node: node('n1', { text: '重复' }) }]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate_node_id'));
});

void test('updateEdge：空串标签归一化为 null，与清空同义（§8.2）', () => {
  const withLabel: CanvasScene = {
    ...scene(),
    edges: [edge('e1', 'n1', 'n2', { label: '引用' })],
  bookmarks: [],
  };

  const cleared = applyMutations(withLabel, [
    { type: 'updateEdge', id: 'e1', patch: { label: '' } },
  ]);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.scene.edges[0]?.label, null);

  const relabeled = applyMutations(withLabel, [
    { type: 'updateEdge', id: 'e1', patch: { label: '新标签' } },
  ]);
  assert.equal(relabeled.scene.edges[0]?.label, '新标签');
});

void test('viewportOnly：纯 setViewport 批次只标记视口变更', () => {
  const viewportOnly = applyMutations(scene(), [
    { type: 'setViewport', viewport: { x: 10, y: 20, zoom: 1.5 } },
  ]);
  assert.equal(viewportOnly.ok, true);
  assert.equal(viewportOnly.viewportOnly, true);

  const mixed = applyMutations(scene(), [
    { type: 'setViewport', viewport: { x: 10, y: 20, zoom: 1.5 } },
    { type: 'setTitle', title: '改名' },
  ]);
  assert.equal(mixed.viewportOnly, false);
});

void test('updateNode meta 按键合并而不是整体替换', () => {
  // 断开与默认场景的连线，避免端点缺失干扰本用例
  const base: CanvasScene = {
    ...scene(),
    nodes: [node('n1', { meta: { color: 'red', keep: 1 } })],
    edges: [],
  bookmarks: [],
  };
  const result = applyMutations(base, [
    { type: 'updateNode', id: 'n1', patch: { meta: { color: 'blue' } } },
  ]);
  assert.deepEqual(result.scene.nodes[0]?.meta, { color: 'blue', keep: 1 });
});

void test('doc 节点必须带 docId 且 text 为 null（invalid_node_doc）', () => {
  const result = applyMutations(scene(), [
    { type: 'addNode', node: node('n9', { kind: 'doc', docId: unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V7'), text: '不允许' }) },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_node_doc'));
});

void test('updateEdge 空串标签：direct patch 不需要断言类型', () => {
  const cleared = applyMutations(scene(), [
    { type: 'updateEdge', id: 'e1', patch: { label: '' } },
  ]);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.scene.edges[0]?.label, null);
});
