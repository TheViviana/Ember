import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMutations, type CanvasNode, type CanvasScene } from '#canvas-engine';
import { asCanvasId } from '#doc-model';
import {
  breadcrumbOf,
  buildAnchorTree,
  filterFolder,
  folderAt,
  menuBack,
  shouldOpenAnchorMenu,
  type AnchorFolder,
} from '../../src/shell/canvas/anchor-menu.ts';
import {
  centeredNodeRect,
  planAnchorEdge,
  planConnection,
} from '../../src/shell/canvas/commands.ts';

const CANVAS_ID = asCanvasId('01M74JZW7CQFP1CY70HTZFTYZD');
if (CANVAS_ID === null) throw new Error('测试画布 id 必须是合法 ULID');

const DOCS = [
  { id: 'd1', path: 'a.md', title: 'A' },
  { id: 'd2', path: 'notes/b.md', title: 'B' },
  { id: 'd3', path: 'notes/deep/c.md', title: 'C' },
  { id: 'd4', path: 'notes/deep/other/d.md', title: 'D' },
  { id: 'd5', path: 'archive/e.md', title: 'E' },
];

void test('目录派生：按 path 的 / 拆树，根层文章与子文件夹分开', () => {
  const root = buildAnchorTree(DOCS);
  assert.deepEqual(
    root.folders.map((folder) => folder.name),
    ['archive', 'notes'],
  );
  assert.deepEqual(
    root.docs.map((doc) => doc.title),
    ['A'],
  );

  const notes = folderAt(root, ['notes']);
  assert.notEqual(notes, null);
  assert.deepEqual(
    notes?.docs.map((doc) => doc.path),
    ['notes/b.md'],
  );

  const deep = folderAt(root, ['notes', 'deep']);
  assert.deepEqual(
    deep?.folders.map((folder) => folder.path),
    ['notes/deep/other'],
  );
  assert.deepEqual(
    deep?.docs.map((doc) => doc.title),
    ['C'],
  );
  assert.equal(folderAt(root, ['missing']), null);
});

void test('下钻路径与面包屑回退深度一致', () => {
  const root = buildAnchorTree(DOCS);
  const segments = 'notes/deep'.split('/');
  assert.equal(folderAt(root, segments)?.path, 'notes/deep');

  assert.deepEqual(breadcrumbOf(segments), [
    { label: '全部文章', depth: 0 },
    { label: 'notes', depth: 1 },
    { label: 'deep', depth: 2 },
  ]);
  // 点击面包屑 depth=1 → 回到 notes 层
  assert.equal(folderAt(root, segments.slice(0, 1))?.path, 'notes');
});

void test('关键字过滤命中文章标题 / 路径 / 文件夹名，无命中时区分「空文件夹」与「无匹配」', () => {
  const root = buildAnchorTree(DOCS);
  const notes = folderAt(root, ['notes']);
  assert.notEqual(notes, null);
  if (notes === null) return;

  assert.deepEqual(
    filterFolder(notes, 'b').docs.map((doc) => doc.title),
    ['B'],
  );
  assert.deepEqual(
    filterFolder(root, 'not').folders.map((folder) => folder.name),
    ['notes'],
  );
  // 路径命中：deep 层内按完整 path 过滤到 c.md
  const deep = folderAt(root, ['notes', 'deep']);
  assert.notEqual(deep, null);
  assert.deepEqual(
    deep === null ? [] : filterFolder(deep, 'deep/c').docs.map((doc) => doc.title),
    ['C'],
  );

  const miss = filterFolder(root, 'zzz');
  assert.deepEqual(miss.docs, []);
  assert.deepEqual(miss.folders, []);
  assert.equal(miss.empty, false);

  const emptyFolder: AnchorFolder = { name: 'empty', path: 'empty', folders: [], docs: [] };
  assert.equal(filterFolder(emptyFolder, '').empty, true);
  assert.equal(filterFolder(emptyFolder, 'zzz').empty, true);
});

void test('Esc 逐级退回：清过滤 → 退出文章列表 → 返回上层 → 根菜单再 Esc 关闭', () => {
  assert.deepEqual(menuBack({ view: 'browse', segments: ['notes'], keyword: 'c' }), {
    view: 'browse',
    segments: ['notes'],
    keyword: '',
  });
  assert.deepEqual(menuBack({ view: 'docs', segments: ['notes'], keyword: '' }), {
    view: 'browse',
    segments: ['notes'],
    keyword: '',
  });
  assert.deepEqual(menuBack({ view: 'browse', segments: ['notes', 'deep'], keyword: '' }), {
    view: 'browse',
    segments: ['notes'],
    keyword: '',
  });
  assert.deepEqual(menuBack({ view: 'browse', segments: [], keyword: '' }), {
    view: 'root',
    segments: [],
    keyword: '',
  });
  // 根菜单 Esc = 关闭：返回 null，调用方不应创建节点 / 连线
  assert.equal(menuBack({ view: 'root', segments: [], keyword: '' }), null);
});

const makeScene = (nodes: readonly CanvasNode[]): CanvasScene => ({
  id: CANVAS_ID,
  title: '主页',
  viewport: { x: 0, y: 0, zoom: 1 },
  grid: { size: 8, snap: true },
  nodes,
  edges: [],
bookmarks: [],
});

const anchorNode: CanvasNode = {
  id: 'n_anchor',
  kind: 'note',
  rect: { x: 0, y: 0, w: 200, h: 120 },
  z: 0,
  docId: null,
  text: null,
  groupId: null,
  meta: {},
};

void test('空白松手：planConnection 返回 null（触发就地菜单），场景不新增边', () => {
  const scene = makeScene([anchorNode]);
  const plan = planConnection(scene, 'n_anchor', 'right', null, (prefix) => `${prefix}_x`);
  assert.equal(plan, null);
  // 空白松手 → 就地菜单；命中目标且有落地方案时不弹
  assert.equal(shouldOpenAnchorMenu(null, plan !== null), true);
  assert.equal(shouldOpenAnchorMenu('n_target', true), false);
  // Esc 取消后没有任何 mutation：边数保持为 0，也就没有残留预览
  const result = applyMutations(scene, []);
  assert.equal(result.ok, true);
  assert.equal(result.scene.edges.length, 0);
  assert.equal(result.scene.nodes.length, 1);
});

void test('新节点中心对齐引线末端（世界坐标）', () => {
  const rect = centeredNodeRect({ x: 600, y: 400 });
  assert.deepEqual(rect, { x: 440, y: 300, w: 320, h: 200 });
  assert.equal(rect.x + rect.w / 2, 600);
  assert.equal(rect.y + rect.h / 2, 400);
});

void test('边方向：右锚点拖出为起点 → 新节点，左锚点反之', () => {
  const right = planAnchorEdge('n_anchor', 'right', 'n_new', 'e_1');
  assert.equal(right.from, 'n_anchor');
  assert.equal(right.to, 'n_new');
  assert.equal(right.arrow, 'end');

  const left = planAnchorEdge('n_anchor', 'left', 'n_new', 'e_2');
  assert.equal(left.from, 'n_new');
  assert.equal(left.to, 'n_anchor');
});

void test('锚点新建：addNode + addEdge 一批落盘，边确实指向新节点', () => {
  const scene = makeScene([anchorNode]);
  const rect = centeredNodeRect({ x: 600, y: 400 });
  const node: CanvasNode = {
    id: 'n_new',
    kind: 'note',
    docId: null,
    text: '',
    rect,
    z: 1,
    groupId: null,
    meta: {},
  };
  const edge = planAnchorEdge('n_anchor', 'right', node.id, 'e_1');
  const result = applyMutations(scene, [
    { type: 'addNode', node },
    { type: 'addEdge', edge },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.scene.nodes.find((item) => item.id === 'n_new')?.rect, rect);
  assert.deepEqual(result.scene.edges, [edge]);
});
