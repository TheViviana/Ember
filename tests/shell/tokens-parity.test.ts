import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canvas, cssVarNames, layers, trafficLights } from '../../src/shell/theme/tokens.ts';

const css = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
const declared = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]));

void test('tokens.ts 声明的每个变量都在 tokens.css 中定义', () => {
  const missing = cssVarNames.filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});

void test('cssVarNames 无重复，且新增变量命名符合 --ember-* / --layer-* 约定', () => {
  assert.equal(new Set(cssVarNames).size, cssVarNames.length);
  for (const name of cssVarNames) {
    assert.match(name, /^--(ember-|layer-|menu-|float-|sidebar-|window-)/);
  }
});

void test('窗口底色与层级 token 的取值与 TS 镜像一致', () => {
  const voidValue = /--ember-bg-void:\s*([^;]+);/.exec(css)?.[1]?.trim();
  assert.equal(voidValue, canvas.bgVoid);
  assert.equal(canvas.bgVoid, '#000000');
  assert.deepEqual(
    ['canvas', 'sidebar', 'float', 'menu', 'chrome'].map((key) => layers[key as keyof typeof layers]),
    [1, 40, 50, 60, 70],
  );
});

void test('自绘交通灯颜色与 TS 镜像一致', () => {
  for (const key of ['close', 'minimize', 'zoom'] as const) {
    const value = new RegExp(`--ember-traffic-${key}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
    assert.equal(value, trafficLights[key]);
  }
});
