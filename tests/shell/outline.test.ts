import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeOutlineIndex,
  collectOutline,
  type OutlineHeading,
} from '../../src/shell/editor/outline.ts';

void test('大纲提取：按行号收集 1–6 级标题，保留层级与文本', () => {
  const source = [
    '# 一级标题',
    '',
    '正文段落',
    '## 二级标题',
    '### 三级标题',
    '###### 六级标题',
  ].join('\n');

  assert.deepEqual(collectOutline(source), [
    { level: 1, text: '一级标题', line: 1 },
    { level: 2, text: '二级标题', line: 4 },
    { level: 3, text: '三级标题', line: 5 },
    { level: 6, text: '六级标题', line: 6 },
  ]);
});

void test('大纲提取：去掉结尾闭合 #，空标题保留为空文本', () => {
  const source = ['## 带闭合 ##', '##', '# 末尾空格   ###  '].join('\n');
  assert.deepEqual(collectOutline(source), [
    { level: 2, text: '带闭合', line: 1 },
    { level: 2, text: '', line: 2 },
    { level: 1, text: '末尾空格', line: 3 },
  ]);
});

void test('大纲提取：围栏代码块里的 # 行不算标题，闭合后恢复提取', () => {
  const source = [
    '# 真标题',
    '```ts',
    '# 代码里的注释',
    '```',
    '## 代码块之后',
    '~~~',
    '### 也算代码',
    '~~~~',
    '### 波浪线之后',
  ].join('\n');

  assert.deepEqual(collectOutline(source), [
    { level: 1, text: '真标题', line: 1 },
    { level: 2, text: '代码块之后', line: 5 },
    { level: 3, text: '波浪线之后', line: 9 },
  ]);
});

void test('大纲提取：不把无空格、超 6 级或 4 空格缩进的行当标题', () => {
  const source = ['#没有空格', '####### 七级', '    # 缩进代码', '# 合法'].join('\n');
  assert.deepEqual(collectOutline(source), [{ level: 1, text: '合法', line: 4 }]);
});

void test('当前标题：取最后一个起始行不晚于视口顶部的标题', () => {
  const headings: readonly OutlineHeading[] = [
    { level: 1, text: 'A', line: 3 },
    { level: 2, text: 'B', line: 10 },
    { level: 2, text: 'C', line: 20 },
  ];
  assert.equal(activeOutlineIndex(headings, 1), -1);
  assert.equal(activeOutlineIndex(headings, 3), 0);
  assert.equal(activeOutlineIndex(headings, 9), 0);
  assert.equal(activeOutlineIndex(headings, 10), 1);
  assert.equal(activeOutlineIndex(headings, 19), 1);
  assert.equal(activeOutlineIndex(headings, 999), 2);
});

void test('当前标题：空大纲返回 -1', () => {
  assert.equal(activeOutlineIndex([], 1), -1);
  assert.equal(activeOutlineIndex([], 999), -1);
});
