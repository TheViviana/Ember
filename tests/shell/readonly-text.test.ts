import assert from 'node:assert/strict';
import test from 'node:test';
import { readonlyText } from '../../src/shell/components/readonly-text.ts';

void test('两种只读原因各自映射到具体文案', () => {
  assert.equal(readonlyText('lockedByOther'), '只读：另一实例已打开');
  assert.equal(readonlyText('lockLost'), '只读：库锁已丢失');
});

void test('原因缺失或未知时回退到通用文案', () => {
  assert.equal(readonlyText(null), '只读模式');
  assert.equal(readonlyText('somethingNew'), '只读模式');
});
