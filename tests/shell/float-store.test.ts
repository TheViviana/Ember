import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeDocId, type DocId } from '#doc-model';
import {
  activateFloatWindow,
  clampFloatLimit,
  closeFloatWindow,
  deriveStackOrder,
  evictLeastRecentAndOpen,
  initialFloatData,
  leastRecentWindow,
  openFloatWindow,
  useFloatStore,
  type FloatStoreData,
} from '../../src/shell/editor/float-store.ts';

const DOC_A = unsafeDocId('笔记/A.md');
const DOC_B = unsafeDocId('笔记/B.md');
const DOC_C = unsafeDocId('笔记/C.md');
const DOC_D = unsafeDocId('笔记/D.md');
const DOC_E = unsafeDocId('笔记/E.md');
const DOC_F = unsafeDocId('笔记/F.md');
const DOC_G = unsafeDocId('笔记/G.md');
const DOC_H = unsafeDocId('笔记/H.md');
const DOC_I = unsafeDocId('笔记/I.md');

/** 以自定义上限构造初始状态（上限来自设置，测试不依赖全局默认值） */
const withLimit = (limit: number): FloatStoreData => ({
  ...initialFloatData,
  limit,
  notice: null,
});

const openAll = (ids: readonly DocId[], limit = 8): FloatStoreData =>
  ids.reduce<FloatStoreData>(
    (state, docId) => openFloatWindow(state, docId, null).state,
    withLimit(limit),
  );

const docIds = (state: FloatStoreData): readonly string[] =>
  state.windows.map((window) => String(window.docId));

void test('默认上限 5：第 6 篇被拒绝并记录提示，窗口列表不动', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
  assert.equal(full.windows.length, 5);

  const sixth = openFloatWindow(full, DOC_F, 'title');
  assert.equal(sixth.result, 'limit');
  assert.deepEqual(docIds(sixth.state), docIds(full), '满额拒绝：不挤掉任何一扇');
  assert.equal(String(sixth.state.activeId), String(full.activeId), '当前窗不变');
  assert.equal(sixth.state.notice?.requestedDocId, DOC_F);
  assert.equal(sixth.state.notice?.requestedFocus, 'title');
  assert.equal(sixth.state.notice?.evictedDocId, DOC_A, '提示里给出最久未激活的候选');
});

void test('默认上限 8：第 9 篇同样拒绝并记录提示', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E, DOC_F, DOC_G, DOC_H], 8);
  assert.equal(full.windows.length, 8);

  const ninth = openFloatWindow(full, DOC_I, null);
  assert.equal(ninth.result, 'limit');
  assert.equal(ninth.state.windows.length, 8, '窗口列表原样保留');
  assert.equal(ninth.state.notice?.evictedDocId, DOC_A);
});

void test('显式挤掉：只关最久未激活的一扇并打开目标，提示清空', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
  const raised = activateFloatWindow(full, DOC_A);

  const next = evictLeastRecentAndOpen(raised, DOC_F, 'title');
  assert.equal(next.result, 'opened');
  assert.deepEqual(docIds(next.state), [
    String(DOC_A),
    String(DOC_C),
    String(DOC_D),
    String(DOC_E),
    String(DOC_F),
  ].map(String), '刚激活过的 A 保留，LRU 的 B 被挤掉');
  assert.equal(String(next.state.activeId), String(DOC_F));
  assert.equal(next.state.notice, null);
});

void test('显式挤掉在窗口列表为空时退化为普通打开', () => {
  const next = evictLeastRecentAndOpen(withLimit(5), DOC_A, null);
  assert.equal(next.result, 'opened');
  assert.deepEqual(docIds(next.state), [String(DOC_A)]);
});

void test('同一篇重复打开只聚焦：nonce 递增、窗口数不变、意图更新、提示清空', () => {
  const first = openFloatWindow(withLimit(8), DOC_A, null);
  assert.equal(first.result, 'opened');

  const again = openFloatWindow(first.state, DOC_A, 'title');
  assert.equal(again.result, 'focused');
  assert.equal(again.state.windows.length, 1);
  assert.equal(again.state.windows[0]?.nonce, 2);
  assert.equal(again.state.windows[0]?.focus, 'title');
  assert.equal(String(again.state.activeId), String(DOC_A));
  assert.equal(again.state.notice, null);
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

  const rejected = openFloatWindow(raised, DOC_F, 'title');
  assert.equal(rejected.result, 'limit', '满额只拒绝，不自动挤掉');
  assert.equal(rejected.state.notice?.evictedDocId, DOC_B, '候选是最久未激活的 B');
});

void test('重复激活当前窗不推进 tick，避免无意义的 z 抖动', () => {
  const state = openAll([DOC_A, DOC_B]);
  assert.equal(activateFloatWindow(state, DOC_B), state);
});

void test('提示条生命周期：关闭请求窗或候选窗都会让提示失效', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
  const rejected = openFloatWindow(full, DOC_F, null);
  assert.notEqual(rejected.state.notice, null);

  // 关闭待挤掉的那扇 → 提示失效
  const closedCandidate = closeFloatWindow(rejected.state, rejected.state.notice?.evictedDocId ?? DOC_A);
  assert.equal(closedCandidate.notice, null);

  // 关闭请求中的那扇不存在于列表，重新构造：关闭其它窗不影响提示
  const stillThere = closeFloatWindow(rejected.state, DOC_C);
  assert.notEqual(stillThere.notice, null, '无关窗口关闭不影响提示');
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
    assert.equal(result.state.notice, null);
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

  void test(`入口「${entry.name}」：已满 → 拒绝并出提示，不自动挤掉`, () => {
    const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E], 5);
    const result = openFloatWindow(full, DOC_F, entry.focus);
    assert.equal(result.result, 'limit');
    assert.deepEqual(docIds(result.state), docIds(full), '窗口列表原样保留');
    assert.ok(!docIds(result.state).includes(String(DOC_F)), '目标未打开');
    assert.equal(result.state.notice?.requestedDocId, DOC_F);
    assert.equal(result.state.notice?.requestedFocus, entry.focus);
    assert.equal(result.state.notice?.evictedDocId, DOC_A);
  });
}

void test('store.setLimit：运行中调整上限并夹取，不裁剪已开浮窗', () => {
  useFloatStore.setState(initialFloatData);
  useFloatStore.getState().setLimit(3);
  assert.equal(useFloatStore.getState().limit, 3);

  const store = useFloatStore.getState();
  for (const docId of [DOC_A, DOC_B, DOC_C]) {
    store.open(docId, null);
  }
  // 上限 3 已满：第 4 篇被拒绝，已开的 3 扇原样保留
  assert.equal(store.open(DOC_D, null), 'limit');
  assert.equal(useFloatStore.getState().windows.length, 3);
  assert.deepEqual(docIds(useFloatStore.getState()), [String(DOC_A), String(DOC_B), String(DOC_C)]);

  // 调小上限也不裁剪：超出部分保持打开，后续新开被拒绝
  useFloatStore.getState().setLimit(2);
  assert.equal(useFloatStore.getState().windows.length, 3, '已开浮窗不被静默关闭');
  assert.equal(useFloatStore.getState().open(DOC_D, null), 'limit');

  useFloatStore.getState().setLimit(99);
  assert.equal(useFloatStore.getState().limit, 12);
  assert.equal(useFloatStore.getState().open(DOC_D, null), 'opened');
  useFloatStore.setState(initialFloatData);
});

void test('store.evictLeastRecentAndOpen 与 dismissNotice', () => {
  useFloatStore.setState(initialFloatData);
  useFloatStore.getState().setLimit(2);
  const store = useFloatStore.getState();
  store.open(DOC_A, null);
  store.open(DOC_B, null);
  assert.equal(store.open(DOC_C, null), 'limit');
  assert.notEqual(useFloatStore.getState().notice, null);

  // 知道了：只清提示，不动窗口
  useFloatStore.getState().dismissNotice();
  assert.equal(useFloatStore.getState().notice, null);
  assert.equal(useFloatStore.getState().windows.length, 2);

  // 显式挤掉：关掉 LRU 的 A，打开 C
  assert.equal(useFloatStore.getState().evictLeastRecentAndOpen(DOC_C, null), 'opened');
  assert.deepEqual(docIds(useFloatStore.getState()), [String(DOC_B), String(DOC_C)]);
  useFloatStore.setState(initialFloatData);
});
