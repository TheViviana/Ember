import assert from 'node:assert/strict';
import test from 'node:test';
import { merge3 } from '../../packages/doc-model/src/merge.ts';

const labels = { local: 'local (Ember)', disk: 'disk (mtime)' };

void test('不重叠的修改自动合并', () => {
  const result = merge3('a\nb\nc', 'A\nb\nc', 'a\nb\nC', labels);
  assert.equal(result.kind, 'clean');
  if (result.kind === 'clean') assert.deepEqual(result.lines, ['A', 'b', 'C']);
});

void test('两侧相同修改不产生冲突', () => {
  const result = merge3('a\nb', 'a\nX', 'a\nX', labels);
  assert.equal(result.kind, 'clean');
  if (result.kind === 'clean') assert.deepEqual(result.lines, ['a', 'X']);
});

void test('同行冲突生成标记并计数', () => {
  const result = merge3('a\nb\nc', 'a\nL\nc', 'a\nD\nc', labels);
  assert.equal(result.kind, 'conflict');
  if (result.kind === 'conflict') {
    assert.equal(result.conflicts, 1);
    assert.deepEqual(result.lines, ['a', '<<<<<<< local (Ember)', 'L', '=======', 'D', '>>>>>>> disk (mtime)', 'c']);
  }
});

void test('一侧插入与另一侧修改互不干扰', () => {
  const result = merge3('one\ntwo', 'one\ninserted\ntwo', 'one\nTWO', labels);
  assert.equal(result.kind, 'clean');
  if (result.kind === 'clean') assert.deepEqual(result.lines, ['one', 'inserted', 'TWO']);
});
