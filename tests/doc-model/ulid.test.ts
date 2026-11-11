import assert from 'node:assert/strict';
import test from 'node:test';
import { createUlid, isUlid, ulidTime } from '../../packages/doc-model/src/ulid.ts';

void test('ULID 长度与字符集合法', () => {
  const id = createUlid();
  assert.equal(id.length, 26);
  assert.ok(isUlid(id));
  assert.ok(!isUlid('01JB8ZQ3K4M5N6P7Q8R9S0T1V'));
  assert.ok(!isUlid('01JB8ZQ3K4M5N6P7Q8R9S0T1UI'));
});

void test('同毫秒内单调递增且不重复', () => {
  const stamp = 4_000_000_000_000;
  const ids = Array.from({ length: 64 }, () => createUlid(stamp));
  const seen = new Set(ids);
  assert.equal(seen.size, ids.length);
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
  for (const id of ids) assert.equal(ulidTime(id), stamp);
});

void test('时钟回拨不破坏单调性', () => {
  const first = createUlid(2_000);
  const second = createUlid(1_000);
  assert.ok(second > first);
});

void test('ulidTime 解析回原始毫秒', () => {
  const stamp = 4_000_000_001_234;
  assert.equal(ulidTime(createUlid(stamp)), stamp);
  assert.ok(Number.isNaN(ulidTime('not-a-ulid')));
});
