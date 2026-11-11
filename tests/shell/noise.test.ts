import assert from 'node:assert/strict';
import test from 'node:test';
import { fillNoiseSamples } from '../../src/shell/tools/noise.ts';

/** 确定性随机源：同一 seed 产出同一序列，便于比较白/粉噪声 */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

void test('白噪声样本：长度一致、取值在 [-1,1]、不是常量', () => {
  const samples = fillNoiseSamples('white', 4096, seeded(1));
  assert.equal(samples.length, 4096);
  assert.ok(samples.every((value) => value >= -1 && value <= 1));
  assert.ok(new Set(samples).size > 1000);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  assert.ok(Math.abs(mean) < 0.1);
});

void test('粉噪声样本：与白噪声序列不同、取值被夹在 [-1,1]', () => {
  const rand = seeded(7);
  const white = fillNoiseSamples('white', 8192, rand);
  const pink = fillNoiseSamples('pink', 8192, seeded(7));
  assert.equal(pink.length, white.length);
  assert.ok(pink.every((value) => value >= -1 && value <= 1));
  const diff = white.reduce((sum, value, index) => sum + Math.abs(value - (pink[index] ?? 0)), 0);
  assert.ok(diff > 100, '粉噪声应明显区别于白噪声');
});

void test('长度非法时不产生样本', () => {
  assert.equal(fillNoiseSamples('white', 0, seeded(1)).length, 0);
  assert.equal(fillNoiseSamples('pink', -20, seeded(1)).length, 0);
});
