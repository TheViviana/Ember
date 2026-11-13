import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMutations,
  type CanvasEdge,
  type CanvasNode,
  type CanvasScene,
} from '#canvas-engine';
import { asCanvasId } from '#doc-model';
import type { CanvasClipboard } from '../../src/shell/canvas/clipboard.ts';
import { planCommand, planEdgeLabel, type MenuTarget } from '../../src/shell/canvas/commands.ts';
import { buildCanvasMenu, type CanvasMenuItem } from '../../src/shell/canvas/menu-model.ts';

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

const makeEdge = (
  id: string,
  from: string,
  to: string,
  overrides: Partial<CanvasEdge> = {},
): CanvasEdge => ({
  id,
  from,
  to,
  label: null,
  arrow: 'end',
  kind: 'relation',
  meta: {},
  ...overrides,
});

const makeScene = (
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[] = [],
  overrides: Partial<CanvasScene> = {},
): CanvasScene => ({
  id: CANVAS_ID,
  title: '主页',
  viewport: { x: 0, y: 0, zoom: 1 },
  grid: { size: 8, snap: true },
  nodes,
  edges,
  bookmarks: [],
  ...overrides,
});

const idFactory = (): ((prefix: 'n' | 'e') => string) => {
  let seq = 100;
  return (prefix) => `${prefix}${(seq += 1)}`;
};

interface RunOptions {
  readonly selection?: readonly string[];
  readonly clipboard?: CanvasClipboard | null;
  readonly viewportSize?: { readonly w: number; readonly h: number };
}

/**
 * 执行一条命令并真正把变更作用到场景上：
 * 表驱动测试断言的是「场景变了什么」，而不是「命令存在」。
 */
const run = (
  scene: CanvasScene,
  command: string,
  target: MenuTarget,
  options: RunOptions = {},
): { readonly plan: ReturnType<typeof planCommand>; readonly after: CanvasScene } => {
  const plan = planCommand({
    command,
    target,
    scene,
    selection: options.selection ?? [],
    clipboard: options.clipboard ?? null,
    newId: idFactory(),
    viewportSize: options.viewportSize ?? { w: 1200, h: 800 },
  });
  if (plan === null) return { plan, after: scene };
  if (plan.kind !== 'mutate') return { plan, after: scene };
  const result = applyMutations(scene, plan.mutations);
  assert.equal(
    result.ok,
    true,
    `命令 ${command} 的变更应通过场景校验：${JSON.stringify(result.issues)}`,
  );
  return { plan, after: result.scene };
};

const nodeOf = (scene: CanvasScene, id: string): CanvasNode => {
  const node = scene.nodes.find((item) => item.id === id);
  assert.ok(node !== undefined, `场景中应存在节点 ${id}`);
  return node;
};

const edgeOf = (scene: CanvasScene, id: string): CanvasEdge => {
  const edge = scene.edges.find((item) => item.id === id);
  assert.ok(edge !== undefined, `场景中应存在连线 ${id}`);
  return edge;
};

const idsByZ = (scene: CanvasScene): readonly string[] =>
  [...scene.nodes].sort((left, right) => left.z - right.z).map((node) => node.id);

const close = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}：期望 ${expected}，实际 ${actual}`);
};

void test('新建自由文本节点：落点吸附、尺寸固定、选中并进入编辑', () => {
  const scene = makeScene([]);
  const { plan, after } = run(scene, 'node.create-note', {
    kind: 'empty',
    point: { x: 13, y: 21 },
  });
  assert.equal(plan?.kind, 'mutate');
  if (plan?.kind !== 'mutate') return;
  const id = plan.select?.[0];
  assert.ok(id !== undefined);
  const created = nodeOf(after, id);
  assert.equal(after.nodes.length, 1);
  assert.equal(created.kind, 'note');
  assert.deepEqual(created.rect, { x: 16, y: 24, w: 320, h: 200 });
  assert.equal(created.z, 0);
  assert.equal(plan.editNode, id);

  const off = run(makeScene([], [], { grid: { size: 8, snap: false } }), 'node.create-note', {
    kind: 'empty',
    point: { x: 13, y: 21 },
  });
  if (off.plan?.kind !== 'mutate') throw new Error('应生成变更');
  const plain = nodeOf(off.after, off.plan.select?.[0] ?? '');
  assert.deepEqual(plain.rect, { x: 13, y: 21, w: 320, h: 200 });
});

void test('新建分组：默认尺寸且在渲染层位于成员之下', () => {
  const { plan, after } = run(makeScene([makeNode('a')]), 'node.create-group', {
    kind: 'empty',
    point: { x: 40, y: 40 },
  });
  if (plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.equal(after.nodes.length, 2);
  const group = nodeOf(after, plan.select?.[0] ?? '');
  assert.equal(group.kind, 'group');
  assert.equal(group.text, '新分组');
  assert.deepEqual(group.rect, { x: 40, y: 40, w: 480, h: 320 });
  assert.equal(group.z, 1);
});

void test('创建副本：节点数增加、偏移 32、z 置顶、选择集切到副本', () => {
  const scene = makeScene([makeNode('a', { z: 0 }), makeNode('b', { z: 1 })]);
  const { plan, after } = run(
    scene,
    'node.duplicate',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  if (plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.equal(after.nodes.length, 4);
  assert.equal(after.edges.length, 0);
  const clones = (plan.select ?? []).map((id) => nodeOf(after, id));
  assert.equal(clones.length, 2);
  assert.deepEqual(clones.map((node) => [node.rect.x, node.rect.y]), [[32, 32], [32, 32]]);
  assert.deepEqual(clones.map((node) => node.z), [2, 3]);
  assert.deepEqual(idsByZ(after), ['a', 'b', ...(plan.select ?? [])]);

  const groupScene = makeScene([makeNode('g', { kind: 'group' })]);
  const rejected = run(groupScene, 'node.duplicate', { kind: 'node', id: 'g', point: { x: 0, y: 0 } });
  assert.equal(rejected.plan, null);
});

void test('复制只带内部连线；粘贴重映射 id 与 groupId', () => {
  const scene = makeScene(
    [makeNode('a'), makeNode('b'), makeNode('c')],
    [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'c')],
  );
  const { plan } = run(
    scene,
    'node.copy',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  if (plan?.kind !== 'copy') throw new Error('复制应返回剪贴板载荷');
  assert.deepEqual(plan.payload.nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(plan.payload.edges.map((edge) => edge.id), ['e1']);

  const clipboard: CanvasClipboard = {
    nodes: [
      makeNode('g', { kind: 'group', rect: { x: 0, y: 0, w: 480, h: 320 } }),
      makeNode('m', { groupId: 'g', rect: { x: 20, y: 20, w: 200, h: 120 } }),
    ],
    edges: [],
  };
  const pasted = run(makeScene([]), 'node.paste', { kind: 'empty', point: { x: 0, y: 0 } }, { clipboard });
  if (pasted.plan?.kind !== 'mutate') throw new Error('粘贴应生成变更');
  assert.equal(pasted.after.nodes.length, 2);
  const [newGroupId, newMemberId] = pasted.plan.select ?? [];
  assert.ok(newGroupId !== undefined && newMemberId !== undefined);
  assert.notEqual(newGroupId, 'g');
  const member = nodeOf(pasted.after, newMemberId);
  assert.equal(member.groupId, newGroupId);
  assert.deepEqual(member.rect, { x: 52, y: 52, w: 200, h: 120 });

  const empty = run(makeScene([]), 'node.paste', { kind: 'empty', point: { x: 0, y: 0 } });
  assert.equal(empty.plan, null);
});

void test('删除节点：连带删除连线；删除分组后成员保留并脱离组', () => {
  const scene = makeScene([makeNode('a'), makeNode('b')], [makeEdge('e1', 'a', 'b')]);
  const { plan, after } = run(scene, 'node.delete', { kind: 'node', id: 'a', point: { x: 0, y: 0 } });
  if (plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.deepEqual(after.nodes.map((node) => node.id), ['b']);
  assert.equal(after.edges.length, 0);
  assert.deepEqual(plan.select, []);

  const grouped = makeScene([
    makeNode('g', { kind: 'group' }),
    makeNode('m', { groupId: 'g' }),
  ]);
  const removed = run(grouped, 'node.delete', { kind: 'node', id: 'g', point: { x: 0, y: 0 } });
  if (removed.plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.equal(removed.after.nodes.length, 1);
  assert.equal(nodeOf(removed.after, 'm').groupId, null);
});

void test('z 序：置顶 / 置底 / 上移 / 下移确实重排绘制顺序', () => {
  const scene = makeScene([makeNode('a', { z: 0 }), makeNode('b', { z: 1 }), makeNode('c', { z: 2 })]);
  const cases: readonly {
    readonly command: string;
    readonly ids: readonly string[];
    readonly expected: readonly string[];
  }[] = [
    { command: 'node.z.top', ids: ['a'], expected: ['b', 'c', 'a'] },
    { command: 'node.z.bottom', ids: ['c'], expected: ['c', 'a', 'b'] },
    { command: 'node.z.up', ids: ['a'], expected: ['b', 'a', 'c'] },
    { command: 'node.z.down', ids: ['c'], expected: ['a', 'c', 'b'] },
    { command: 'node.z.up', ids: ['c'], expected: ['a', 'b', 'c'] },
    { command: 'node.z.down', ids: ['a'], expected: ['a', 'b', 'c'] },
    { command: 'node.z.top', ids: ['a', 'b'], expected: ['c', 'a', 'b'] },
    { command: 'node.z.bottom', ids: ['b', 'c'], expected: ['b', 'c', 'a'] },
  ];
  for (const item of cases) {
    const { after } = run(
      scene,
      item.command,
      { kind: 'selection', ids: item.ids, point: { x: 0, y: 0 } },
      { selection: item.ids },
    );
    assert.deepEqual(idsByZ(after), item.expected, `${item.command} ${item.ids.join(',')}`);
    assert.deepEqual(
      [...after.nodes].map((node) => node.z).sort((left, right) => left - right),
      [0, 1, 2],
      'z 应保持 0..n-1 连续，避免长期操作后出现空洞',
    );
  }
});

void test('分组：成组包围盒留白 24，解组与移出分组都保留成员', () => {
  const scene = makeScene([
    makeNode('a', { rect: { x: 0, y: 0, w: 200, h: 120 }, z: 0 }),
    makeNode('b', { rect: { x: 400, y: 300, w: 200, h: 120 }, z: 1 }),
  ]);
  const grouped = run(
    scene,
    'node.group-selection',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  if (grouped.plan?.kind !== 'mutate') throw new Error('应生成变更');
  const groupId = grouped.plan.select?.[0];
  assert.ok(groupId !== undefined);
  const group = nodeOf(grouped.after, groupId);
  assert.deepEqual(group.rect, { x: -24, y: -24, w: 648, h: 468 });
  assert.equal(nodeOf(grouped.after, 'a').groupId, groupId);
  assert.equal(nodeOf(grouped.after, 'b').groupId, groupId);

  const ungrouped = run(grouped.after, 'node.ungroup', {
    kind: 'node',
    id: groupId,
    point: { x: 0, y: 0 },
  });
  if (ungrouped.plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.deepEqual(ungrouped.after.nodes.map((node) => node.id), ['a', 'b']);
  assert.deepEqual(ungrouped.plan.select, ['a', 'b']);
  assert.equal(nodeOf(ungrouped.after, 'a').groupId, null);

  const detached = run(grouped.after, 'node.remove-from-group', {
    kind: 'node',
    id: 'a',
    point: { x: 0, y: 0 },
  });
  if (detached.plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.equal(nodeOf(detached.after, 'a').groupId, null);
  assert.equal(nodeOf(detached.after, 'b').groupId, groupId);

  const single = run(
    scene,
    'node.group-selection',
    { kind: 'selection', ids: ['a'], point: { x: 0, y: 0 } },
    { selection: ['a'] },
  );
  assert.equal(single.plan, null);
});

void test('连线：连接、反转、箭头三态、删除与标签', () => {
  const scene = makeScene([makeNode('a'), makeNode('b'), makeNode('c')]);

  const connected = run(
    scene,
    'edge.connect',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  if (connected.plan?.kind !== 'mutate') throw new Error('应生成变更');
  assert.equal(connected.after.edges.length, 1);
  const created = connected.after.edges[0];
  assert.ok(created !== undefined);
  assert.deepEqual([created.from, created.to, created.arrow], ['a', 'b', 'end']);
  assert.equal(connected.plan.selectEdge, created.id);

  for (const pair of [['a'], ['a', 'b', 'c']] as const) {
    const rejected = run(scene, 'edge.connect', {
      kind: 'selection',
      ids: pair,
      point: { x: 0, y: 0 },
    }, { selection: pair });
    assert.equal(rejected.plan, null, `${pair.length} 个节点不应建立连线`);
  }

  const existing = makeScene([makeNode('a'), makeNode('b')], [makeEdge('e1', 'a', 'b')]);
  const duplicate = run(
    existing,
    'edge.connect',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  assert.equal(duplicate.plan, null);

  const reversed = run(existing, 'edge.reverse', { kind: 'edge', id: 'e1', point: { x: 0, y: 0 } });
  if (reversed.plan?.kind !== 'mutate') throw new Error('应生成变更');
  const flipped = edgeOf(reversed.after, 'e1');
  assert.deepEqual([flipped.from, flipped.to], ['b', 'a']);

  const bothWays = makeScene(
    [makeNode('a'), makeNode('b')],
    [makeEdge('e1', 'a', 'b'), makeEdge('e2', 'b', 'a')],
  );
  const refused = run(bothWays, 'edge.reverse', { kind: 'edge', id: 'e1', point: { x: 0, y: 0 } });
  assert.equal(refused.plan, null);

  for (const arrow of ['none', 'end', 'both'] as const) {
    const result = run(existing, `edge.arrow.${arrow}`, { kind: 'edge', id: 'e1', point: { x: 0, y: 0 } });
    assert.equal(edgeOf(result.after, 'e1').arrow, arrow);
  }

  const deleted = run(existing, 'edge.delete', { kind: 'edge', id: 'e1', point: { x: 0, y: 0 } });
  assert.equal(deleted.after.edges.length, 0);

  const labelled = makeScene([makeNode('a'), makeNode('b')], [makeEdge('e1', 'a', 'b', { label: '旧' })]);
  const prompt = run(labelled, 'edge.edit-label', { kind: 'edge', id: 'e1', point: { x: 0, y: 0 } });
  assert.deepEqual(prompt.plan, { kind: 'prompt-edge-label', edgeId: 'e1', value: '旧' });

  const mutation = planEdgeLabel(labelled, 'e1', '  依赖  ');
  assert.ok(mutation !== null);
  const result = applyMutations(labelled, [mutation]);
  assert.equal(result.ok, true);
  assert.equal(edgeOf(result.scene, 'e1').label, '依赖');

  const cleared = planEdgeLabel(labelled, 'e1', '   ');
  assert.ok(cleared !== null);
  const clearedResult = applyMutations(labelled, [cleared]);
  assert.equal(edgeOf(clearedResult.scene, 'e1').label, null);
  assert.equal(planEdgeLabel(labelled, 'missing', 'x'), null);
});

void test('颜色：写入 meta.color，默认清除；非法颜色被拒绝', () => {
  const scene = makeScene([
    makeNode('a', { meta: { color: 'primary' } }),
    makeNode('b'),
  ]);

  const painted = run(
    scene,
    'color:warning',
    { kind: 'selection', ids: ['a', 'b'], point: { x: 0, y: 0 } },
    { selection: ['a', 'b'] },
  );
  assert.equal(nodeOf(painted.after, 'a').meta.color, 'warning');
  assert.equal(nodeOf(painted.after, 'b').meta.color, 'warning');

  const reset = run(scene, 'color:default', { kind: 'node', id: 'a', point: { x: 0, y: 0 } });
  assert.equal(nodeOf(reset.after, 'a').meta.color, null);

  const bogus = run(scene, 'color:bogus', { kind: 'node', id: 'a', point: { x: 0, y: 0 } });
  assert.equal(bogus.plan, null);
});

void test('视口与选择：全选排除组、适应内容居中、重置与吸附开关', () => {
  const scene = makeScene([
    makeNode('a'),
    makeNode('b', { z: 1 }),
    makeNode('g', { kind: 'group', z: 2 }),
  ]);

  const all = run(scene, 'view.select-all', { kind: 'empty', point: { x: 0, y: 0 } });
  assert.equal(all.plan?.kind, 'select');
  if (all.plan?.kind !== 'select') return;
  assert.deepEqual([...all.plan.ids].sort(), ['a', 'b']);

  const content = makeScene([
    makeNode('solo', { rect: { x: 1000, y: 1000, w: 400, h: 300 } }),
  ]);
  const fit = run(content, 'view.fit', { kind: 'empty', point: { x: 0, y: 0 } }, {
    viewportSize: { w: 1000, h: 800 },
  });
  assert.equal(fit.plan?.kind, 'viewport');
  if (fit.plan?.kind !== 'viewport') return;
  assert.ok(fit.plan.viewport.zoom <= 1);
  close(fit.plan.viewport.x + 1200 * fit.plan.viewport.zoom, 500, '适应后内容中心 x');
  close(fit.plan.viewport.y + 1150 * fit.plan.viewport.zoom, 400, '适应后内容中心 y');

  const reset = run(scene, 'view.reset', { kind: 'empty', point: { x: 0, y: 0 } });
  assert.deepEqual(reset.plan, { kind: 'viewport', viewport: { x: 0, y: 0, zoom: 1 } });

  const toggled = run(makeScene([], [], { grid: { size: 16, snap: true } }), 'view.toggle-snap', {
    kind: 'empty',
    point: { x: 0, y: 0 },
  });
  assert.deepEqual(toggled.after.grid, { size: 16, snap: false });
});

const leaves = (items: readonly CanvasMenuItem[]): readonly CanvasMenuItem[] =>
  items.flatMap((item) =>
    item.children === undefined || item.children.length === 0 ? [item] : leaves(item.children),
  );

interface MenuCase {
  readonly name: string;
  readonly scene: CanvasScene;
  readonly target: MenuTarget;
  readonly clipboard: CanvasClipboard | null;
}

void test('菜单完整性：每个条目执行后都产生合法变更，不存在死条目', () => {
  const base = makeScene([makeNode('a'), makeNode('b'), makeNode('c')], [makeEdge('e1', 'a', 'b')]);
  const grouped = makeScene([
    makeNode('g', { kind: 'group', z: 0 }),
    makeNode('m', { groupId: 'g', z: 1 }),
  ]);
  const doc = makeScene([
    makeNode('d', { kind: 'doc', docId: '01M74JZW7CQFP1CY70HTZFTYZD' as CanvasNode['docId'] }),
  ]);
  const clipboard: CanvasClipboard = { nodes: [makeNode('n')], edges: [] };

  const cases: readonly MenuCase[] = [
    { name: '空白（空剪贴板）', scene: base, target: { kind: 'empty', point: { x: 10, y: 10 } }, clipboard: null },
    { name: '空白（有剪贴板）', scene: base, target: { kind: 'empty', point: { x: 10, y: 10 } }, clipboard },
    { name: '自由文本节点', scene: base, target: { kind: 'node', id: 'a', point: { x: 10, y: 10 } }, clipboard },
    { name: '文档节点', scene: doc, target: { kind: 'node', id: 'd', point: { x: 10, y: 10 } }, clipboard },
    { name: '分组节点', scene: grouped, target: { kind: 'node', id: 'g', point: { x: 10, y: 10 } }, clipboard },
    { name: '单选', scene: base, target: { kind: 'selection', ids: ['a'], point: { x: 10, y: 10 } }, clipboard },
    {
      name: '多选（可连线）',
      scene: base,
      target: { kind: 'selection', ids: ['b', 'c'], point: { x: 10, y: 10 } },
      clipboard,
    },
    {
      name: '多选（已有连线）',
      scene: base,
      target: { kind: 'selection', ids: ['a', 'b'], point: { x: 10, y: 10 } },
      clipboard,
    },
    {
      name: '多选（含分组）',
      scene: grouped,
      target: { kind: 'selection', ids: ['g', 'm'], point: { x: 10, y: 10 } },
      clipboard,
    },
    { name: '连线', scene: base, target: { kind: 'edge', id: 'e1', point: { x: 10, y: 10 } }, clipboard },
  ];

  for (const item of cases) {
    const items = buildCanvasMenu({ target: item.target, scene: item.scene, clipboard: item.clipboard });
    assert.ok(items.length > 0, `${item.name} 菜单不应为空`);
    const flat = leaves(items);
    assert.ok(flat.length > 0, `${item.name} 菜单应有可执行条目`);
    for (const leaf of flat) {
      const selection = item.target.kind === 'selection' ? item.target.ids : [];
      const plan = planCommand({
        command: leaf.id,
        target: item.target,
        scene: item.scene,
        selection,
        clipboard: item.clipboard,
        newId: idFactory(),
        viewportSize: { w: 1200, h: 800 },
      });
      assert.notEqual(plan, null, `${item.name} → ${leaf.id} 是死条目`);
      if (plan?.kind === 'mutate') {
        const result = applyMutations(item.scene, plan.mutations);
        assert.equal(
          result.ok,
          true,
          `${item.name} → ${leaf.id} 的变更应合法：${JSON.stringify(result.issues)}`,
        );
        assert.ok(
          plan.mutations.length > 0 || plan.editNode !== undefined,
          `${item.name} → ${leaf.id} 执行后场景与 UI 都必须变化`,
        );
      }
    }
  }

  const docMenu = buildCanvasMenu({
    target: { kind: 'node', id: 'd', point: { x: 0, y: 0 } },
    scene: doc,
    clipboard: null,
  });
  assert.equal(leaves(docMenu).some((item) => item.id === 'node.edit'), false);
  const groupSelection = buildCanvasMenu({
    target: { kind: 'selection', ids: ['g', 'm'], point: { x: 0, y: 0 } },
    scene: grouped,
    clipboard: null,
  });
  assert.equal(leaves(groupSelection).some((item) => item.id === 'node.duplicate'), false);
});

void test('S7：空白菜单可一步新建文章，doc 节点有浮窗入口且不出现无 docId 的死条目', () => {
  const scene = makeScene([makeNode('d', { kind: 'doc', docId: '01M74JZW7CQFP1CY70HTZFTYZD' as CanvasNode['docId'] })]);
  const emptyTarget: MenuTarget = { kind: 'empty', point: { x: 20, y: 40 } };

  const emptyMenu = buildCanvasMenu({ target: emptyTarget, scene, clipboard: null });
  assert.equal(leaves(emptyMenu)[0]?.id, 'node.create-article', '新建文章应是空白菜单第一项');
  const createPlan = planCommand({
    command: 'node.create-article',
    target: emptyTarget,
    scene,
    selection: [],
    clipboard: null,
    newId: idFactory(),
    viewportSize: { w: 1200, h: 800 },
  });
  assert.deepEqual(createPlan, { kind: 'create-article', point: { x: 24, y: 40 } }, '落点应按 8px 网格吸附');

  assert.equal(
    leaves(emptyMenu).some((item) => item.id === 'node.add-doc'),
    true,
    '空白菜单应能从库添加已有文章',
  );
  const pickPlan = planCommand({
    command: 'node.add-doc',
    target: emptyTarget,
    scene,
    selection: [],
    clipboard: null,
    newId: idFactory(),
    viewportSize: { w: 1200, h: 800 },
  });
  assert.deepEqual(pickPlan, { kind: 'pick-doc', point: { x: 24, y: 40 } }, '落点应按 8px 网格吸附');
  assert.equal(
    planCommand({
      command: 'node.add-doc',
      target: { kind: 'node', id: 'd', point: { x: 0, y: 0 } },
      scene,
      selection: ['d'],
      clipboard: null,
      newId: idFactory(),
      viewportSize: { w: 1200, h: 800 },
    }),
    null,
    '非空白目标不应提供从库添加',
  );

  const docMenu = buildCanvasMenu({
    target: { kind: 'node', id: 'd', point: { x: 0, y: 0 } },
    scene,
    clipboard: null,
  });
  assert.equal(leaves(docMenu).some((item) => item.id === 'node.open-float'), true);
  assert.equal(leaves(docMenu).some((item) => item.id === 'node.edit-meta'), true);

  const openPlan = planCommand({
    command: 'node.open-float',
    target: { kind: 'node', id: 'd', point: { x: 0, y: 0 } },
    scene,
    selection: ['d'],
    clipboard: null,
    newId: idFactory(),
    viewportSize: { w: 1200, h: 800 },
  });
  assert.equal(openPlan?.kind, 'open-float');
  assert.equal(openPlan?.kind === 'open-float' ? openPlan.focus : 'x', null);

  const metaPlan = planCommand({
    command: 'node.edit-meta',
    target: { kind: 'node', id: 'd', point: { x: 0, y: 0 } },
    scene,
    selection: ['d'],
    clipboard: null,
    newId: idFactory(),
    viewportSize: { w: 1200, h: 800 },
  });
  assert.equal(metaPlan?.kind === 'open-float' ? metaPlan.focus : 'x', 'title');

  // 没有 docId 的 doc 节点（脏数据）不放出这两个入口
  const orphan = makeScene([makeNode('o', { kind: 'doc', docId: null })]);
  const orphanMenu = buildCanvasMenu({
    target: { kind: 'node', id: 'o', point: { x: 0, y: 0 } },
    scene: orphan,
    clipboard: null,
  });
  assert.equal(leaves(orphanMenu).some((item) => item.id === 'node.open-float'), false);
  assert.equal(leaves(orphanMenu).some((item) => item.id === 'node.edit-meta'), false);
});
