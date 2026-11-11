import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampVisible,
  growVisible,
  paletteWindow,
} from '../../src/shell/components/list-window.ts';

void test('paletteWindow：total 为 0 收敛为空窗口', () => {
  assert.deepEqual(paletteWindow(0, 0), { start: 0, end: 0 });
});

void test('paletteWindow：total 小于窗口时全量渲染', () => {
  assert.deepEqual(paletteWindow(10, 3, 60), { start: 0, end: 10 });
});

void test('paletteWindow：中间选中项两侧各留半窗', () => {
  // chunk=60，active=500 → start=470，end=530
  assert.deepEqual(paletteWindow(2000, 500, 60), { start: 470, end: 530 });
});

void test('paletteWindow：靠近头部时不越出左界', () => {
  assert.deepEqual(paletteWindow(2000, 0, 60), { start: 0, end: 60 });
  assert.deepEqual(paletteWindow(2000, 10, 60), { start: 0, end: 60 });
});

void test('paletteWindow：靠近尾部时不越出右界', () => {
  assert.deepEqual(paletteWindow(2000, 1999, 60), { start: 1940, end: 2000 });
  assert.deepEqual(paletteWindow(2000, 1980, 60), { start: 1940, end: 2000 });
});

void test('paletteWindow：active 越界被安全夹紧', () => {
  assert.deepEqual(paletteWindow(100, -5, 60), { start: 0, end: 60 });
  assert.deepEqual(paletteWindow(100, 999, 60), { start: 40, end: 100 });
});

void test('paletteWindow：窗口始终包含 active', () => {
  for (let active = 0; active < 300; active += 17) {
    const { start, end } = paletteWindow(300, active, 60);
    assert.ok(start <= active && active < end, `active=${active} 应在 [${start},${end}) 内`);
  }
});

void test('growVisible：按批增长并夹到 total', () => {
  assert.equal(growVisible(100, 1000), 250);
  assert.equal(growVisible(900, 1000), 1000, '不足一批时只到 total');
  assert.equal(growVisible(1000, 1000), 1000, '已到 total 不再增长');
});

void test('clampVisible：total 收缩时回落，扩张时保留已增长的数量', () => {
  assert.equal(clampVisible(500, 200), 200);
  assert.equal(clampVisible(500, 800), 500);
  assert.equal(clampVisible(500, 0), 0);
});
