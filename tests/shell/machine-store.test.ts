import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  attachMachineUiPort,
  flushMachineUiWrites,
  hydrateMachineUi,
  parseMachineUi,
  serializeMachineUi,
  useMachineStore,
} from '../../src/data/stores/machine-store.ts';
import { moveFloatFrame, resolveFloatResize, type FloatFrame } from '../../src/shell/editor/float-layout.ts';

interface FakePort {
  readonly read: () => Promise<string | null>;
  readonly write: (json: string) => Promise<void>;
  readonly writes: string[];
  text: string | null;
}

const createFakePort = (initial: string | null): FakePort => {
  const writes: string[] = [];
  const fake: FakePort = {
    text: initial,
    writes,
    read: () => Promise.resolve(fake.text),
    write: (json) => {
      writes.push(json);
      fake.text = json;
      return Promise.resolve();
    },
  };
  return fake;
};

const DOC_A = '01JB8ZQ3K4M5N6P7Q8R9S0T1V2';
const DOC_B = '01JB8ZQ3K4M5N6P7Q8R9S0T1V3';

void test('尺寸记忆往返：水合恢复同一篇，不同篇互不影响', async () => {
  const seed = serializeMachineUi({ [DOC_A]: { width: 720, height: 500 } });
  const port = createFakePort(seed);
  attachMachineUiPort(port);
  await hydrateMachineUi();

  assert.deepEqual(useMachineStore.getState().floatSizes[DOC_A], { width: 720, height: 500 });
  assert.equal(useMachineStore.getState().floatSizes[DOC_B], undefined);

  useMachineStore.getState().rememberFloatSize(DOC_A, { width: 800, height: 540 });
  useMachineStore.getState().rememberFloatSize(DOC_B, { width: 520, height: 360 });
  await flushMachineUiWrites();

  const saved = parseMachineUi(port.text ?? '');
  assert.ok(saved !== null);
  assert.deepEqual(saved.floatSizes[DOC_A], { width: 800, height: 540 });
  assert.deepEqual(saved.floatSizes[DOC_B], { width: 520, height: 360 });

  // 模拟重启：把落盘文本重新解析成内存态，A 仍是自己的尺寸
  const restarted = createFakePort(port.text);
  const restored = parseMachineUi((await restarted.read()) ?? '');
  assert.ok(restored !== null);
  assert.deepEqual(restored.floatSizes[DOC_A], { width: 800, height: 540 });
});

void test('位置记忆往返：松手写一次，重启恢复同一篇的位置', async () => {
  const port = createFakePort(null);
  attachMachineUiPort(port);
  useMachineStore.setState({ floatSizes: {}, floatPositions: {} });

  const start: FloatFrame = { left: 640, top: 120, width: 560, height: 420 };
  let frame = start;
  for (let step = 1; step <= 20; step += 1) {
    frame = moveFloatFrame(start, step * 3, step * 2, { width: 1280, height: 800 });
  }
  await flushMachineUiWrites();
  assert.equal(port.writes.length, 0, '拖动过程不得写 ui.json');

  useMachineStore.getState().rememberFloatPosition(DOC_A, { left: frame.left, top: frame.top });
  await flushMachineUiWrites();
  assert.equal(port.writes.length, 1, '松手只写一次');

  const saved = parseMachineUi(port.text ?? '');
  assert.ok(saved !== null);
  assert.deepEqual(saved.floatPositions[DOC_A], { left: frame.left, top: frame.top });
  assert.equal(saved.floatPositions[DOC_B], undefined);
  // 尺寸与位置互不影响
  assert.equal(saved.floatSizes[DOC_A], undefined);
});

void test('缩放期间不写机器状态，松手才记忆一次', async () => {
  const port = createFakePort(null);
  attachMachineUiPort(port);
  useMachineStore.setState({ floatSizes: {} });

  const start: FloatFrame = { left: 40, top: 40, width: 600, height: 400 };
  let frame = start;
  for (let step = 1; step <= 20; step += 1) {
    frame = resolveFloatResize('se', start, step * 4, step * 3, { maxWidth: 1600, maxHeight: 1000 });
    assert.ok(frame.width >= 480 && frame.height >= 320);
  }
  await flushMachineUiWrites();
  assert.equal(port.writes.length, 0, '拖动过程不得写 ui.json');

  useMachineStore.getState().rememberFloatSize(DOC_A, { width: frame.width, height: frame.height });
  await flushMachineUiWrites();
  assert.equal(port.writes.length, 1, '松手只写一次');
});

void test('尺寸状态不进入编辑器重建依赖，缩放后仍可继续输入', () => {
  const source = readFileSync(new URL('../../src/shell/editor/FloatEditor.tsx', import.meta.url), 'utf8');

  // CodeMirror 会话的 effect 依赖里没有 frame / savedSize / focus，缩放与切窗只重排样式，不重建 EditorView
  assert.ok(source.includes('}, [docId, host, kernel, openWikiLink, queryClient]);'));

  const resizeStart = source.indexOf('const beginResize');
  // 取 beginResize 之后的下一个 effect 作为边界：文件前部可能另有同步 ref 的小 effect
  const resizeEnd = source.indexOf('useEffect(() => {', resizeStart);
  assert.ok(resizeStart >= 0 && resizeEnd > resizeStart);
  const resizeBody = source.slice(resizeStart, resizeEnd);
  assert.ok(!resizeBody.includes('persist'));
  assert.ok(!resizeBody.includes('docs.update'));
  assert.ok(!resizeBody.includes('scheduleSave'));
  // 只有松手时写机器状态
  assert.equal(resizeBody.split('rememberFloatSize(').length - 1, 1);
});
