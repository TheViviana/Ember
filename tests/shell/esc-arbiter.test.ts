import assert from 'node:assert/strict';
import test from 'node:test';
import { escLayerPush, escLayerRemove, isEscTop } from '../../src/shell/esc-arbiter.ts';

void test('后入栈者持有 Esc 栈顶', () => {
  escLayerPush('a');
  escLayerPush('b');
  assert.equal(isEscTop('b'), true);
  assert.equal(isEscTop('a'), false);
  assert.equal(isEscTop('unknown'), false);
  escLayerRemove('b');
  escLayerRemove('a');
});

void test('移除中间层后栈顶回落', () => {
  escLayerPush('base');
  escLayerPush('top');
  escLayerRemove('top');
  assert.equal(isEscTop('base'), true);
  escLayerRemove('base');
});

void test('重复 push 同一浮层只保留一份并置顶', () => {
  escLayerPush('a');
  escLayerPush('b');
  escLayerPush('a'); // a 复活到顶
  assert.equal(isEscTop('a'), true);
  assert.equal(isEscTop('b'), false);
  escLayerRemove('a');
  assert.equal(isEscTop('b'), true, 'a 出栈后栈顶应回到 b，不能残留第二份 a');
  escLayerRemove('b');
  assert.equal(isEscTop('b'), false);
});

void test('空栈时任何 id 都不是栈顶', () => {
  assert.equal(isEscTop('anything'), false);
});
