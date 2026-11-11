import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeDocId, type DocId } from '#doc-model';
import {
  activateFloatWindow,
  closeFloatWindow,
  deriveStackOrder,
  evictFloatWindow,
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

const openAll = (ids: readonly DocId[]): FloatStoreData =>
  ids.reduce<FloatStoreData>(
    (state, docId) => openFloatWindow(state, docId, null).state,
    initialFloatData,
  );

const docIds = (state: FloatStoreData): readonly string[] =>
  state.windows.map((window) => String(window.docId));

void test('上限 5：第 6 篇返回 limit，窗口不变，提示指向最久未激活的一扇', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E]);
  assert.equal(full.windows.length, 5);

  const sixth = openFloatWindow(full, DOC_F, 'title');
  assert.equal(sixth.result, 'limit');
  assert.equal(sixth.state.windows.length, 5);
  assert.deepEqual(docIds(sixth.state), [DOC_A, DOC_B, DOC_C, DOC_D, DOC_E].map(String));
  assert.equal(String(sixth.state.activeId), String(DOC_E));
  assert.deepEqual(sixth.state.notice, {
    requestedDocId: DOC_F,
    requestedFocus: 'title',
    evictedDocId: DOC_A,
  });
});

void test('同一篇重复打开只聚焦：nonce 递增、窗口数不变、意图更新', () => {
  const first = openFloatWindow(initialFloatData, DOC_A, null);
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

void test('显式挤掉 LRU：移除最久未激活的一扇，目标进入并成为当前窗', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E]);
  const raised = activateFloatWindow(full, DOC_A);
  assert.equal(String(leastRecentWindow(raised.windows)?.docId), String(DOC_B));

  const evicted = evictFloatWindow(raised, DOC_F, 'title');
  assert.equal(evicted.result, 'opened');
  assert.equal(evicted.state.windows.length, 5);
  assert.deepEqual(docIds(evicted.state), [
    String(DOC_A),
    String(DOC_C),
    String(DOC_D),
    String(DOC_E),
    String(DOC_F),
  ]);
  assert.equal(String(evicted.state.activeId), String(DOC_F));
  assert.equal(evicted.state.notice, null);
});

void test('显式挤掉时目标已打开：退化为聚焦，不挤掉任何窗口', () => {
  const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E]);
  const result = evictFloatWindow(full, DOC_C, 'title');
  assert.equal(result.result, 'focused');
  assert.equal(result.state.windows.length, 5);
  assert.deepEqual(result.state.windows.map((window) => window.nonce), [1, 1, 2, 1, 1]);
  assert.equal(String(result.state.activeId), String(DOC_C));
});

void test('limitNotice 生命周期：满额写入、成功打开清空、关闭清空、dismiss 清空', () => {
  useFloatStore.setState(initialFloatData);
  const store = useFloatStore.getState();
  for (const docId of [DOC_A, DOC_B, DOC_C, DOC_D, DOC_E]) {
    store.open(docId, null);
  }

  assert.equal(store.open(DOC_F, null), 'limit');
  assert.notEqual(useFloatStore.getState().notice, null);

  useFloatStore.getState().dismissNotice();
  assert.equal(useFloatStore.getState().notice, null);

  useFloatStore.getState().open(DOC_F, null);
  assert.notEqual(useFloatStore.getState().notice, null);

  useFloatStore.getState().open(DOC_A, null);
  assert.equal(useFloatStore.getState().notice, null);

  useFloatStore.getState().open(DOC_F, null);
  assert.notEqual(useFloatStore.getState().notice, null);

  useFloatStore.getState().close(DOC_B);
  assert.equal(useFloatStore.getState().notice, null);
});

void test('LRU 跟随激活变化：刚激活过的窗口不会被优先挤掉', () => {
  let state = openAll([DOC_A, DOC_B, DOC_C, DOC_D]);
  state = activateFloatWindow(state, DOC_A);
  state = openFloatWindow(state, DOC_E, null).state;

  const limit = openFloatWindow(state, DOC_F, null);
  assert.equal(limit.result, 'limit');
  assert.equal(String(limit.state.notice?.evictedDocId), String(DOC_B));
  assert.equal(String(state.windows[0]?.docId), String(DOC_A));
  assert.ok((state.windows[0]?.lastActiveAt ?? 0) > (state.windows[1]?.lastActiveAt ?? 0));
});

void test('重复激活当前窗不推进 tick，避免无意义的 z 抖动', () => {
  const state = openAll([DOC_A, DOC_B]);
  assert.equal(activateFloatWindow(state, DOC_B), state);
});

/** 四条既有入口最终都走 store.open：这里逐条验证未开 / 已开 / 已满的 store 结果 */
const ENTRIES = [
  { name: '侧栏点文档', focus: null },
  { name: '画布双击节点', focus: null },
  { name: '节点菜单打开', focus: null },
  { name: '新建文章', focus: 'title' },
] as const;

for (const entry of ENTRIES) {
  void test(`入口「${entry.name}」：未开 → 新开并成为当前窗`, () => {
    const result = openFloatWindow(initialFloatData, DOC_A, entry.focus);
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

  void test(`入口「${entry.name}」：已满 → 拒绝并提示可挤掉 LRU，窗口不变`, () => {
    const full = openAll([DOC_A, DOC_B, DOC_C, DOC_D, DOC_E]);
    const result = openFloatWindow(full, DOC_F, entry.focus);
    assert.equal(result.result, 'limit');
    assert.equal(result.state.windows.length, 5);
    assert.deepEqual(docIds(result.state), [DOC_A, DOC_B, DOC_C, DOC_D, DOC_E].map(String));
    assert.deepEqual(result.state.notice, {
      requestedDocId: DOC_F,
      requestedFocus: entry.focus,
      evictedDocId: DOC_A,
    });
  });
}
