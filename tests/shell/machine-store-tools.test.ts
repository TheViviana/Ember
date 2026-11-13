import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachMachineUiPort,
  DEFAULT_AI,
  DEFAULT_AI_PANEL,
  DEFAULT_POMODORO,
  flushMachineUiWrites,
  hydrateMachineUi,
  parseMachineUi,
  parsePomodoro,
  serializeMachineUi,
  useMachineStore,
} from '../../src/data/stores/machine-store.ts';

const writes: string[] = [];
let stored: string | null = null;

attachMachineUiPort({
  read: () => Promise.resolve(stored),
  write: (json) => {
    writes.push(json);
    stored = json;
    return Promise.resolve();
  },
});

void test('老 v1 文件缺 pomodoro 时按默认值补齐，浮窗数据不丢', () => {
  const legacy = JSON.stringify({
    schemaVersion: 1,
    floatSizes: { doc: { width: 700, height: 480 } },
    floatPositions: { doc: { left: 40, top: 60 } },
  });
  const parsed = parseMachineUi(legacy);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.floatSizes.doc, { width: 700, height: 480 });
  assert.deepEqual(parsed.pomodoro, DEFAULT_POMODORO);
});

void test('pomodoro 与 canvasFlags 序列化后可完整读回', async () => {
  const pomodoro = {
    focusMinutes: 45,
    breakMinutes: 10,
    segment: 3,
    phase: 'break' as const,
    endTs: 1_800_000_000_000,
    noise: 'pink' as const,
    noiseVolume: 0.45,
  };
  const canvasFlags = { '01JCANVAS0000000000000000': { recentEdits: true } };
  const json = serializeMachineUi({}, {}, pomodoro, DEFAULT_AI, DEFAULT_AI_PANEL, canvasFlags);
  const parsed = parseMachineUi(json);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.pomodoro, pomodoro);
  assert.deepEqual(parsed.canvasFlags, canvasFlags);

  useMachineStore.getState().setPomodoro(pomodoro);
  useMachineStore.getState().setCanvasFlag('01JCANVAS0000000000000000', { recentEdits: true });
  await flushMachineUiWrites();
  // 水合门禁之下，写入只在 hydrate 之后发生（水合前会整份覆盖 ui.json）
  await hydrateMachineUi();
  useMachineStore.getState().setCanvasFlag('01JCANVAS0000000000000000', { recentEdits: true });
  await flushMachineUiWrites();
  assert.ok(writes.length > 0);
  const saved = parseMachineUi(stored ?? '');
  assert.ok(saved !== null);
  assert.deepEqual(saved.pomodoro, pomodoro);
  assert.deepEqual(saved.canvasFlags, canvasFlags);
});

void test('非法 pomodoro 字段被丢弃或夹到合法区间', () => {
  const parsed = parsePomodoro({
    focusMinutes: 999,
    breakMinutes: 0,
    segment: -2,
    phase: 'unknown',
    endTs: 'tomorrow',
  });
  assert.equal(parsed.focusMinutes, 180);
  assert.equal(parsed.breakMinutes, 1);
  assert.equal(parsed.segment, 1);
  assert.equal(parsed.phase, 'focus');
  assert.equal(parsed.endTs, null);
});

void test('白噪音字段：未知类型回落到关闭，音量夹到 0–1', () => {
  const fallback = parsePomodoro({ noise: 'rain', noiseVolume: 9 });
  assert.equal(fallback.noise, 'off');
  assert.equal(fallback.noiseVolume, 1);

  const clamped = parsePomodoro({ noise: 'white', noiseVolume: -3 });
  assert.equal(clamped.noise, 'white');
  assert.equal(clamped.noiseVolume, 0);

  const legacy = parsePomodoro({ focusMinutes: 25 });
  assert.equal(legacy.noise, 'off');
  assert.equal(legacy.noiseVolume, 0.3);
});

void test('水合前的写入不落盘（防默认态覆盖 ui.json），水合后恢复', async () => {
  // 用查询串拿一份全新的模块实例，避免与上方测试共享 hydrated 模块状态
  type MachineStoreModule = {
    attachMachineUiPort: typeof attachMachineUiPort;
    hydrateMachineUi: typeof hydrateMachineUi;
    flushMachineUiWrites: typeof flushMachineUiWrites;
    useMachineStore: typeof useMachineStore;
  };
  const spec = '../../src/data/stores/machine-store.ts?gate';
  const fresh = (await import(spec)) as MachineStoreModule;
  const freshWrites: string[] = [];
  let freshStored: string | null = JSON.stringify({
    schemaVersion: 1,
    floatSizes: { doc: { width: 640, height: 420 } },
    canvasFlags: { '01JCANVASOLD000000000000': { recentEdits: true } },
  });
  fresh.attachMachineUiPort({
    read: () => Promise.resolve(freshStored),
    write: (json: string) => {
      freshWrites.push(json);
      freshStored = json;
      return Promise.resolve();
    },
  });

  // 水合前：写入被丢弃，磁盘保持旧内容
  fresh.useMachineStore.getState().setCanvasFlag('01JCANVASNEW0000000000000', { recentEdits: true });
  await fresh.flushMachineUiWrites();
  assert.equal(freshWrites.length, 0);
  assert.ok(freshStored?.includes('01JCANVASOLD000000000000'), '磁盘仍是旧内容');

  // 水合后：磁盘状态进内存，写入照常
  await fresh.hydrateMachineUi();
  assert.deepEqual(
    fresh.useMachineStore.getState().canvasFlags['01JCANVASOLD000000000000'],
    { recentEdits: true },
  );
  fresh.useMachineStore.getState().setCanvasFlag('01JCANVASNEW0000000000000', { recentEdits: true });
  await fresh.flushMachineUiWrites();
  assert.equal(freshWrites.length, 1);
  assert.ok(freshStored?.includes('01JCANVASNEW0000000000000'), '新内容落盘');
});

void test('未来版本的 ui.json：本会话只读不回写', async () => {
  type MachineStoreModule = {
    attachMachineUiPort: typeof attachMachineUiPort;
    hydrateMachineUi: typeof hydrateMachineUi;
    flushMachineUiWrites: typeof flushMachineUiWrites;
    useMachineStore: typeof useMachineStore;
  };
  const spec = '../../src/data/stores/machine-store.ts?future-doc';
  const fresh = (await import(spec)) as MachineStoreModule;
  const writes: string[] = [];
  const futureText = JSON.stringify({
    schemaVersion: 2,
    floatSizes: {},
    futureOnly: { newField: true },
  });
  fresh.attachMachineUiPort({
    read: () => Promise.resolve(futureText),
    write: (json: string) => {
      writes.push(json);
      return Promise.resolve();
    },
  });
  await fresh.hydrateMachineUi();
  fresh.useMachineStore.getState().setCanvasFlag('01JCANVASNEW0000000000000', { recentEdits: true });
  await fresh.flushMachineUiWrites();
  assert.equal(writes.length, 0, '未来版本文档禁止回写，新字段不得被旧版应用抹掉');
});
