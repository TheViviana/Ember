import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeDocId, type DocId } from '#doc-model';
import {
  activateFloatWindow,
  clampFloatLimit,
  closeFloatWindow,
  deriveStackOrder,
  initialFloatData,
  leastRecentWindow,
  openFloatWindow,
  useFloatStore,
  type FloatStoreData,
} from '../../src/shell/editor/float-store.ts';

const DOC_A = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
const DOC_B = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V3');
const DOC_C = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V4');
const DOC_D = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V5');
const DOC_E = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V6');
const DOC_F = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V7');
const DOC_G = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V8');
const DOC_H = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V9');
const DOC_I = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1W2');

/** 以自定义上限构造初始状态（上限来自设置，测试不依赖全局默认值） */
const withLimit = (limit: number): FloatStoreData => ({ ...initialFloatData, limit });

const openAll = (ids: readonly DocId[], limit = 8): FloatStoreData =>
  ids.reduce<FloatStoreData>(
    (state, docId) => openFloatWindow(state, docId, null).state,
    withLimit(limit),
  );

const docIds = (state: FloatStoreData): readonly string[] =>
  state.windows.map((window) => String(window.docId));

void test('默认上限 8：第 9 篇静默挤掉最久未激活的一扇，无提示', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E, DOC_F, DOC_G, DOC_H], 8);
  assert.equal(full.windows.length, 8);

  const ninth = openFloatWindow(full, DOC_I, 'title');
  assert.equal(ninth.result, 'opened');
  assert.equal(ninth.state.windows.length, 8, '挤掉一扇后仍是 8 扇');
  assert.ok(!docIds(ninth.state).includes(String(DOC_A)), '最久未激活的 A 被挤掉');
  assert.equal(String(ninth.state.activeId), String(DOC_I));
});

void test('上限 5：满额打开自动挤掉 LRU，返回 opened 而不是拒绝', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
  assert.equal(full.windows.length, 5);

  const sixth = openFloatWindow(full, DOC_F, 'title');
  assert.equal(sixth.result, 'opened');
  assert.equal(sixth.state.windows.length, 5);
  assert.deepEqual(docIds(sixth.state), [DOC_B, DOC_C, DOC_D, DOC_E, DOC_F].map(String));
  assert.equal(String(sixth.state.activeId), String(DOC_F));
});

void test('同一篇重复打开只聚焦：nonce 递增、窗口数不变、意图更新', () => {
  const first = openFloatWindow(withLimit(8), DOC_A, null);
  assert.equal(first.result, 'opened');

  const again = openFloatWindow(first.state, DOC_A, 'title');
  assert.equal(again.result, 'focused');
  assert.equal(again.state.windows.length, 1);
  assert.equal(again.state.windows[0]?.nonce, 2);
  assert.equal(again.state.windows[0]?.focus, 'title');
  assert.equal(String(again.state.activeId), String(DOC_A));
});

void test('激活顺序派生 z：后激活者 z 更大，且不单独存 z', () => {
  const state = openAll([DOC_A, DOC_B, DOC_C]);
  assert.deepEqual(
    deriveStackOrder(state.windows).map((entry) => [String(entry.docId), entry.z]),
    [
      [String(DOC_A), 1],
      [String(DOC_B), 2],
      [String(DOC_C), 3],
    ],
  );

  const raised = activateFloatWindow(state, DOC_A);
  assert.equal(String(raised.activeId), String(DOC_A));
  assert.deepEqual(
    deriveStackOrder(raised.windows).map((entry) => [String(entry.docId), entry.z]),
    [
      [String(DOC_B), 1],
      [String(DOC_C), 2],
      [String(DOC_A), 3],
    ],
  );
});

void test('关闭当前窗：激活回退到剩余窗口中最近激活的一扇', () => {
  const state = openAll([DOC_A, DOC_B, DOC_C]);
  const closed = closeFloatWindow(state, DOC_C);
  assert.deepEqual(docIds(closed), [String(DOC_A), String(DOC_B)]);
  assert.equal(String(closed.activeId), String(DOC_B));
});

void test('关闭不存在或非当前窗：窗口集合正确，当前窗保持不变', () => {
  const state = openAll([DOC_A, DOC_B]);
  assert.equal(closeFloatWindow(state, DOC_C), state);

  const closed = closeFloatWindow(state, DOC_A);
  assert.equal(String(closed.activeId), String(DOC_B));
  assert.deepEqual(docIds(closed), [String(DOC_B)]);
});

void test('LRU 跟随激活变化：刚激活过的窗口不会被优先挤掉', () => {
  const state = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
  const raised = activateFloatWindow(state, DOC_A);
  assert.equal(String(leastRecentWindow(raised.windows)?.docId), String(DOC_B));

  const opened = openFloatWindow(raised, DOC_F, 'title');
  assert.equal(opened.result, 'opened');
  assert.deepEqual(docIds(opened.state), [
    String(DOC_A),
    String(DOC_C),
    String(DOC_D),
    String(DOC_E),
    String(DOC_F),
  ]);
  assert.equal(String(opened.state.activeId), String(DOC_F));
});

void test('重复激活当前窗不推进 tick，避免无意义的 z 抖动', () => {
  const state = openAll([DOC_A, DOC_B]);
  assert.equal(activateFloatWindow(state, DOC_B), state);
});

void test('clampFloatLimit：上限夹取到 1..12，非整数向下取整', () => {
  assert.equal(clampFloatLimit(0), 1);
  assert.equal(clampFloatLimit(13), 12);
  assert.equal(clampFloatLimit(8.9), 8);
  assert.equal(clampFloatLimit(6), 6);
});

/** 四条既有入口最终都走 store.open：这里逐条验证未开 / 已开 / 已满的 store 结果 */
const ENTRIES = [
  { name: '文档列表点文档', focus: null },
  { name: '画布双击节点', focus: null },
  { name: '节点菜单打开', focus: null },
  { name: '新建文章', focus: 'title' },
] as const;

for (const entry of ENTRIES) {
  void test(`入口「${entry.name}」：未开 → 新开并成为当前窗`, () => {
    const result = openFloatWindow(withLimit(8), DOC_A, entry.focus);
    assert.equal(result.result, 'opened');
    assert.equal(result.state.windows.length, 1);
    assert.equal(result.state.windows[0]?.nonce, 1);
    assert.equal(result.state.windows[0]?.focus, entry.focus);
    assert.equal(String(result.state.activeId), String(DOC_A));
  });

  void test(`入口「${entry.name}」：已开（后台） → 聚焦置顶，不新增窗口`, () => {
    const state = openAll([DOC_A, DOC_B]);
    assert.equal(String(state.activeId), String(DOC_B));

    const result = openFloatWindow(state, DOC_A, entry.focus);
    assert.equal(result.result, 'focused');
    assert.equal(result.state.windows.length, 2);
    assert.equal(result.state.windows[0]?.nonce, 2);
    assert.equal(result.state.windows[0]?.focus, entry.focus);
    assert.equal(String(result.state.activeId), String(DOC_A));
    const order = deriveStackOrder(result.state.windows);
    assert.equal(String(order[order.length - 1]?.docId), String(DOC_A), '聚焦后 z 最大');
  });

  void test(`入口「${entry.name}」：已满 → 静默挤掉 LRU 并打开目标`, () => {
    const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
    const result = openFloatWindow(full, DOC_F, entry.focus);
    assert.equal(result.result, 'opened');
    assert.equal(result.state.windows.length, 5);
    assert.ok(!docIds(result.state).includes(String(DOC_A)), 'LRU 被挤掉');
    assert.ok(docIds(result.state).includes(String(DOC_F)), '目标已打开');
  });
}

void test('store.setLimit：运行中调整上限并夹取', () => {
  useFloatStore.setState(initialFloatData);
  useFloatStore.getState().setLimit(3);
  assert.equal(useFloatStore.getState().limit, 3);

  const store = useFloatStore.getState();
  for (const docId of [DOC_A, DOC_B, DOC_C]) {
    store.open(docId, null);
  }
  // 第 4 篇：上限 3 → 挤掉最久未激活的 A
  assert.equal(store.open(DOC_D, null), 'opened');
  assert.equal(useFloatStore.getState().windows.length, 3);
  assert.ok(!docIds(useFloatStore.getState()).includes(String(DOC_A)));

  useFloatStore.getState().setLimit(99);
  assert.equal(useFloatStore.getState().limit, 12);
  useFloatStore.setState(initialFloatData);
});
