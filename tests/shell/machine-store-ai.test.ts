import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_PANEL_BOTTOM_RESERVE,
  attachMachineUiPort,
  clampAiPanelRect,
  DEFAULT_AI,
  DEFAULT_AI_PANEL,
  defaultAiPanelRect,
  flushMachineUiWrites,
  hydrateMachineUi,
  parseAi,
  parseAiPanel,
  parseMachineUi,
  useMachineStore,
} from '../../src/data/stores/machine-store.ts';

const LEGACY = JSON.stringify({
  schemaVersion: 1,
  floatSizes: { doc: { width: 700, height: 480 } },
  floatPositions: { doc: { left: 40, top: 60 } },
  recall: { day: '2026-11-11', ids: ['a', 'b', 'c'] },
  pomodoro: { focusMinutes: 45, breakMinutes: 10, segment: 2, phase: 'break', endTs: null },
  futureField: { note: '另一路写入的字段' },
  panels: { legacyPanel: { pinned: true } },
});

void test('老文件缺 AI 字段时取默认值，既有字段一个不丢', () => {
  const parsed = parseMachineUi(LEGACY);
  assert.ok(parsed !== null);
  assert.deepEqual(parsed.floatSizes.doc, { width: 700, height: 480 });
  assert.deepEqual(parsed.floatPositions.doc, { left: 40, top: 60 });
  assert.deepEqual(parsed.recall, { day: '2026-11-11', ids: ['a', 'b', 'c'] });
  assert.deepEqual(parsed.pomodoro, {
    focusMinutes: 45,
    breakMinutes: 10,
    segment: 2,
    phase: 'break',
    endTs: null,
    noise: 'off',
    noiseVolume: 0.3,
  });
  assert.deepEqual(parsed.ai, DEFAULT_AI);
  assert.deepEqual(parsed.panels, { ai: DEFAULT_AI_PANEL });
});

void test('写回时未知/他人字段原样保留，AI 字段覆盖写', async () => {
  let stored = LEGACY;
  attachMachineUiPort({
    read: () => Promise.resolve(stored),
    write: (json) => {
      stored = json;
      return Promise.resolve();
    },
  });
  await hydrateMachineUi();

  const restored = useMachineStore.getState();
  assert.deepEqual(restored.ai, DEFAULT_AI);
  assert.deepEqual(restored.panels.ai, DEFAULT_AI_PANEL);
  assert.deepEqual(restored.floatSizes.doc, { width: 700, height: 480 });

  useMachineStore.getState().setAi({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'demo-model',
  });
  useMachineStore.getState().setAiPanel({ open: true, x: 844, y: 208, width: 420, height: 480 });
  await flushMachineUiWrites();

  const raw = JSON.parse(stored) as Record<string, unknown>;
  assert.deepEqual(raw.futureField, { note: '另一路写入的字段' });
  assert.deepEqual(raw.panels, {
    legacyPanel: { pinned: true },
    ai: { open: true, x: 844, y: 208, width: 420, height: 480 },
  });
  assert.deepEqual(raw.floatSizes, { doc: { width: 700, height: 480 } });
  assert.deepEqual(raw.floatPositions, { doc: { left: 40, top: 60 } });
  assert.deepEqual(raw.recall, { day: '2026-11-11', ids: ['a', 'b', 'c'] });
  assert.deepEqual(raw.ai, {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'demo-model',
  });

  const reread = parseMachineUi(stored);
  assert.ok(reread !== null);
  assert.deepEqual(reread.ai, {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'demo-model',
  });
  assert.deepEqual(reread.panels.ai, { open: true, x: 844, y: 208, width: 420, height: 480 });
});

void test('非法 AI 字段回落到默认值，面板尺寸夹到合法区间', () => {
  assert.deepEqual(parseAi({ provider: 'unknown', baseUrl: 42, model: null }), DEFAULT_AI);
  assert.deepEqual(parseAiPanel({ open: 'yes', width: 9999 }), {
    open: false,
    x: 16,
    y: 208,
    width: 720,
    height: 480,
  });
  assert.deepEqual(parseAiPanel({ open: true, width: 1 }), {
    open: true,
    x: 944,
    y: 208,
    width: 320,
    height: 480,
  });
});

void test('老文件只有 { open, width } 时补默认 x/y/height，停右下角', () => {
  const parsed = parseAiPanel({ open: true, width: 400 });
  assert.deepEqual(parsed, { open: true, x: 864, y: 208, width: 400, height: 480 });
  assert.equal(parsed.x + parsed.width, 1280 - 16);
  assert.equal(parsed.y + parsed.height, 740 - AI_PANEL_BOTTOM_RESERVE);
});

void test('越界位置与尺寸被夹回窗口内，且不侵占底部 HUD / 横排', () => {
  const area = { width: 700, height: 520 };
  const rect = clampAiPanelRect({ x: -100, y: 9999, width: 9999, height: 9999 }, area);
  assert.deepEqual(rect, { x: 16, y: 16, width: 668, height: 452 });
  assert.ok(rect.x >= 16);
  assert.ok(rect.y >= 16);
  assert.equal(rect.x + rect.width, 700 - 16);
  assert.equal(rect.y + rect.height, 520 - AI_PANEL_BOTTOM_RESERVE);

  const narrow = clampAiPanelRect({ x: 0, y: 0, width: 360, height: 480 }, { width: 300, height: 400 });
  assert.ok(narrow.x + narrow.width <= 300 - 16);
  assert.ok(narrow.y + narrow.height <= 400 - AI_PANEL_BOTTOM_RESERVE);
});

void test('默认位置随可用区域变化：小窗口也落在底部上方', () => {
  const small = defaultAiPanelRect({ width: 900, height: 600 });
  assert.deepEqual(small, { x: 524, y: 68, width: 360, height: 480 });
  assert.equal(small.y + small.height, 600 - AI_PANEL_BOTTOM_RESERVE);
  assert.deepEqual(parseAiPanel(null, { width: 900, height: 600 }), { open: false, ...small });
});
