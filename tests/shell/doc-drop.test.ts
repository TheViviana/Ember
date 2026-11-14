import assert from 'node:assert/strict';
import test from 'node:test';
import { DOC_DRAG_MIME, docDropRect, hasDocPayload, readDocId, type DragPayload } from '../../src/shell/canvas/doc-drop.ts';
import { DEFAULT_NODE_SIZE } from '../../src/shell/canvas/geometry.ts';
import { layout } from '../../src/shell/theme/tokens.ts';

/** DataTransfer 替身：只实现拖放链路真正用到的那一面 */
const payload = (entries: Readonly<Record<string, string>>): DragPayload => ({
  types: Object.keys(entries),
  getData: (type) => entries[type] ?? '',
});

const GRID_ON = { size: 8, snap: true } as const;
const GRID_OFF = { size: 8, snap: false } as const;
const CANVAS = { width: 1200, height: 800 } as const;
const ZERO_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;

void test('载荷识别：只有带 application/x-ember-doc 的拖拽才算文稿拖拽', () => {
  assert.equal(hasDocPayload(payload({ [DOC_DRAG_MIME]: 'notes/a.md' })), true);
  assert.equal(hasDocPayload(payload({ Files: '' })), false);
  assert.equal(hasDocPayload(payload({ 'text/plain': 'notes/a.md' })), false, '纯文本不算：避免把选中文字当成拖文章');
  assert.equal(hasDocPayload(payload({})), false);
});

void test('载荷读取：只认规范化的文档路径，非法值一律卸掉', () => {
  const read = (value: string) => readDocId(payload({ [DOC_DRAG_MIME]: value }));
  assert.equal(read('notes/a.md'), 'notes/a.md');
  assert.equal(read('a.md'), 'a.md');
  assert.equal(read(''), null, '没有载荷');
  assert.equal(read('notes/a.txt'), null, '非 Markdown');
  assert.equal(read('../escape.md'), null, '越出库根');
  assert.equal(read('media/a.md'), null, '内核保留目录');
  assert.equal(read('.workbench/a.md'), null, '隐藏目录');
});

void test('落点：未吸附时卡片中心就在鼠标处，吸附后按网格对齐', () => {
  const loose = docDropRect({ point: { x: 500, y: 400 }, viewport: ZERO_VIEWPORT, canvas: CANVAS, grid: GRID_OFF });
  assert.deepEqual(loose, {
    x: 500 - DEFAULT_NODE_SIZE.w / 2,
    y: 400 - DEFAULT_NODE_SIZE.h / 2,
    w: DEFAULT_NODE_SIZE.w,
    h: DEFAULT_NODE_SIZE.h,
  });

  const snapped = docDropRect({ point: { x: 500, y: 400 }, viewport: ZERO_VIEWPORT, canvas: CANVAS, grid: GRID_ON });
  assert.equal(snapped.x, 344, '340 吸附到 8 的倍数');
  assert.equal(snapped.y, 304, '300 吸附到 8 的倍数');
  assert.equal(snapped.w, DEFAULT_NODE_SIZE.w);
  assert.equal(snapped.h, DEFAULT_NODE_SIZE.h);
});

void test('落点：贴着左上角放下时卡片被夹进可视区，不压顶栏', () => {
  const rect = docDropRect({ point: { x: 0, y: 0 }, viewport: ZERO_VIEWPORT, canvas: CANVAS, grid: GRID_OFF });
  assert.equal(rect.x, 8, '左侧留 8px');
  assert.equal(rect.y, layout.topbarHeight + 8, '顶部让开顶栏');
  assert.ok(rect.x >= 0 && rect.y >= 0);
});

void test('落点：缩放后换算回世界坐标，仍是「鼠标处居中」', () => {
  const zoomed = { x: 0, y: 0, zoom: 2 } as const;
  const rect = docDropRect({ point: { x: 600, y: 400 }, viewport: zoomed, canvas: CANVAS, grid: GRID_OFF });
  assert.deepEqual([rect.x, rect.y], [600 / 2 - DEFAULT_NODE_SIZE.w / 2, 400 / 2 - DEFAULT_NODE_SIZE.h / 2]);
});

void test('落点：平移后的视口按世界坐标落点，不随滚动漂移', () => {
  const panned = { x: -200, y: -100, zoom: 1 } as const;
  const rect = docDropRect({ point: { x: 500, y: 400 }, viewport: panned, canvas: CANVAS, grid: GRID_OFF });
  assert.deepEqual([rect.x, rect.y], [700 - DEFAULT_NODE_SIZE.w / 2, 500 - DEFAULT_NODE_SIZE.h / 2]);
});
