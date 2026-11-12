import assert from 'node:assert/strict';
import test from 'node:test';
import { readonlyText } from '../../src/shell/components/readonly-text.ts';

void test('五种只读原因各自映射到具体文案', () => {
  assert.equal(readonlyText('lockedByOther'), '只读：另一实例已打开');
  assert.equal(readonlyText('lockedByStalled'), '只读：另一实例无响应，请关闭后重试');
  assert.equal(readonlyText('claimFailed'), '只读：抢锁失败，请重试');
  assert.equal(readonlyText('lockLost'), '只读：库锁已丢失');
  assert.equal(readonlyText('journalCorrupt'), '只读：journal 损坏，已保留现场，需人工处理');
});

void test('journal 损坏必须提示已保留现场、需人工处理', () => {
  assert.match(readonlyText('journalCorrupt'), /已保留现场/);
  assert.match(readonlyText('journalCorrupt'), /需人工处理/);
});

void test('原因缺失或未知时回退到通用文案', () => {
  assert.equal(readonlyText(null), '只读模式');
  assert.equal(readonlyText('somethingNew'), '只读模式');
});
