import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeDocId } from '#doc-model';
import { FOCUS_MARGIN_PX, focusedFloatFrame } from '../../src/shell/editor/focus-layout.ts';
import { useFocusStore } from '../../src/shell/editor/focus-store.ts';

const DOC_A = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
const DOC_B = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V3');

void test('专注几何：1280×820 容器四周留 48，居中放大', () => {
  assert.deepEqual(focusedFloatFrame({ width: 1280, height: 820 }), {
    left: 48,
    top: 48,
    width: 1184,
    height: 724,
  });
});

void test('专注几何：忽略容器比最小浮窗还小的场景，先保证铺满容器', () => {
  assert.deepEqual(focusedFloatFrame({ width: 400, height: 300 }), {
    left: 0,
    top: 0,
    width: 400,
    height: 300,
  });
});

void test('专注几何：宽度够放下最小浮窗但高度不够时只压高度', () => {
  const frame = focusedFloatFrame({ width: 900, height: 300 });
  assert.equal(frame.width, 804);
  assert.equal(frame.height, 300);
  assert.equal(frame.left, 48);
  assert.equal(frame.top, 0);
});

void test('专注几何：最小尺寸触顶导致差值为奇数时取整，不产生半像素', () => {
  const frame = focusedFloatFrame({ width: 601, height: 701 }, 100);
  assert.equal(frame.width, 480);
  assert.equal(frame.height, 501);
  // (601 - 480) / 2 = 60.5 → 61
  assert.equal(frame.left, 61);
  assert.equal(frame.top, 100);
});

void test('专注几何：留白可取 0，等价于铺满容器', () => {
  assert.deepEqual(focusedFloatFrame({ width: 640, height: 480 }, 0), {
    left: 0,
    top: 0,
    width: 640,
    height: 480,
  });
});

void test('专注几何：默认留白常量与 24 的既有节奏一致', () => {
  assert.equal(FOCUS_MARGIN_PX, 48);
});

void test('专注 store：enter 记录目标，exit 只清会话态', () => {
  useFocusStore.setState({ active: false, docId: null });
  useFocusStore.getState().enter(DOC_A);
  assert.equal(useFocusStore.getState().active, true);
  assert.equal(String(useFocusStore.getState().docId), String(DOC_A));

  useFocusStore.getState().enter(DOC_B);
  assert.equal(String(useFocusStore.getState().docId), String(DOC_B));

  useFocusStore.getState().exit();
  assert.equal(useFocusStore.getState().active, false);
  assert.equal(useFocusStore.getState().docId, null);
});
