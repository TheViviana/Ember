import assert from 'node:assert/strict';
import test from 'node:test';
import { findOccurrences, planReplace } from '../../src/shell/replace/global-replace.ts';

void test('findOccurrences：字面量全量命中并给出行号', () => {
  const body = 'alpha 与 beta。\n第二行 alpha，再次 alpha。';
  const hits = findOccurrences(body, 'alpha', false);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((hit) => hit.line), [1, 2, 2]);
});

void test('findOccurrences：忽略大小写', () => {
  const body = 'Alpha alpha ALPHa';
  assert.equal(findOccurrences(body, 'alpha', true).length, 3);
  assert.equal(findOccurrences(body, 'alpha', false).length, 1);
});

void test('findOccurrences：空查询与无命中返回空', () => {
  assert.deepEqual(findOccurrences('正文', '', false), []);
  assert.deepEqual(findOccurrences('正文', '不存在', false), []);
});

void test('planReplace：跨文档计划并生成替换后的正文', () => {
  const plan = planReplace(
    [
      { id: 'a', path: 'notes/a.md', title: 'A', body: 'alpha 与 alpha' },
      { id: 'b', path: 'notes/b.md', title: 'B', body: '没有命中' },
      { id: 'c', path: 'notes/c.md', title: 'C', body: 'alpha 单次' },
    ],
    'alpha',
    'beta',
    false,
  );
  assert.equal(plan.totalOccurrences, 3);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0]?.newBody, 'beta 与 beta');
  assert.equal(plan.items[1]?.newBody, 'beta 单次');
});

void test('planReplace：替换词包含查询词时不会死循环', () => {
  const plan = planReplace([{ id: 'a', path: 'p', title: 'A', body: 'go' }], 'go', 'gogo', false);
  assert.equal(plan.items[0]?.newBody, 'gogo');
});

void test('planReplace：忽略大小写时各命中都替换为同一文本', () => {
  const plan = planReplace([{ id: 'a', path: 'p', title: 'A', body: 'Alpha 与 alpha' }], 'alpha', 'X', true);
  assert.equal(plan.items[0]?.newBody, 'X 与 X');
});
