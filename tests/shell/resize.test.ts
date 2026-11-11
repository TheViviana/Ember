import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_WINDOW_SIZE,
  RESIZE_ZONES,
  resolveResize,
  type ResizeZone,
  type WindowFrame,
} from '../../src/shell/window/resize.ts';

const START: WindowFrame = { x: 100, y: 80, width: 1280, height: 820 };

interface Case {
  readonly zone: ResizeZone;
  readonly dx: number;
  readonly dy: number;
  readonly expected: WindowFrame;
}

void test('八向缩放：东/南只改尺寸，西/北同时挪左上角', () => {
  const cases: readonly Case[] = [
    { zone: 'e', dx: 40, dy: 0, expected: { x: 100, y: 80, width: 1320, height: 820 } },
    { zone: 'e', dx: -40, dy: 0, expected: { x: 100, y: 80, width: 1240, height: 820 } },
    { zone: 'w', dx: 40, dy: 0, expected: { x: 140, y: 80, width: 1240, height: 820 } },
    { zone: 'w', dx: -40, dy: 0, expected: { x: 60, y: 80, width: 1320, height: 820 } },
    { zone: 's', dx: 0, dy: 30, expected: { x: 100, y: 80, width: 1280, height: 850 } },
    { zone: 's', dx: 0, dy: -30, expected: { x: 100, y: 80, width: 1280, height: 790 } },
    { zone: 'n', dx: 0, dy: 30, expected: { x: 100, y: 110, width: 1280, height: 790 } },
    { zone: 'n', dx: 0, dy: -30, expected: { x: 100, y: 50, width: 1280, height: 850 } },
    { zone: 'se', dx: 25, dy: 15, expected: { x: 100, y: 80, width: 1305, height: 835 } },
    { zone: 'nw', dx: -25, dy: -15, expected: { x: 75, y: 65, width: 1305, height: 835 } },
    { zone: 'ne', dx: 25, dy: -15, expected: { x: 100, y: 65, width: 1305, height: 835 } },
    { zone: 'sw', dx: -25, dy: 15, expected: { x: 75, y: 80, width: 1305, height: 835 } },
  ];

  for (const item of cases) {
    assert.deepEqual(
      resolveResize(item.zone, START, item.dx, item.dy),
      item.expected,
      `${item.zone} 方向 dx=${item.dx} dy=${item.dy}`,
    );
  }
});

void test('缩到下限时尺寸夹紧，被拖动的边停在原位而不是继续反向移动', () => {
  const base: WindowFrame = { x: 100, y: 80, width: 1000, height: 700 };

  // 西边右移 500：宽度只能到 960，左边停在 100 + (1000 - 960) = 140
  assert.deepEqual(resolveResize('w', base, 500, 0), { x: 140, y: 80, width: 960, height: 700 });
  // 北边下移 500：高度只能到 640，上边停在 80 + (700 - 640) = 140
  assert.deepEqual(resolveResize('n', base, 0, 500), { x: 100, y: 140, width: 1000, height: 640 });
  // 左上角同时夹紧（向右下拖 = 缩小）
  assert.deepEqual(resolveResize('nw', base, 500, 500), {
    x: 140,
    y: 140,
    width: 960,
    height: 640,
  });
});

void test('结果按整数像素取整，避免半像素抖动', () => {
  const frame = resolveResize('w', START, 10.6, 0);
  assert.equal(frame.width, 1269);
  assert.equal(frame.x, 111);
  assert.deepEqual(resolveResize('s', START, 0, 0), START);
});

void test('八个方向各一个，且最小尺寸与 tauri.conf.json 一致', () => {
  assert.equal(RESIZE_ZONES.length, 8);
  assert.equal(new Set(RESIZE_ZONES).size, 8);
  assert.deepEqual(MIN_WINDOW_SIZE, { width: 960, height: 640 });
});
