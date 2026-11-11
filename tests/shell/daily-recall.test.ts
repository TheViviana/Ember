import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deterministicPick,
  recallDayKey,
  resolveRecall,
  type RecallCandidate,
} from '../../src/shell/tools/daily-recall.ts';

const pool = (ids: readonly string[]): readonly RecallCandidate[] =>
  ids.map((id) => ({ id, title: `标题 ${id}`, summary: `摘要 ${id}`, path: `${id}.md` }));

void test('日期键按本地日补零：同一天稳定，不影响跨天', () => {
  assert.equal(recallDayKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(recallDayKey(new Date(2026, 10, 11)), '2026-11-11');
});

void test('确定性洗牌：同一天同一批 id 顺序完全相同', () => {
  const ids = 'abcdefghijkl'.split('');
  const first = deterministicPick(ids, '2026-11-11');
  const second = deterministicPick([...ids].reverse(), '2026-11-11');
  assert.deepEqual(first, second, '结果不依赖输入顺序');
  assert.deepEqual(first, deterministicPick(ids, '2026-11-11'));
  assert.deepEqual(first, ['e', 'c', 'l']);
});

void test('确定性洗牌：不同日期得到不同组合', () => {
  const ids = 'abcdefghijkl'.split('');
  assert.notDeepEqual(deterministicPick(ids, '2026-11-11'), deterministicPick(ids, '2026-11-12'));
});

void test('池子不足三条时按实际数量返回，空池返回空', () => {
  assert.deepEqual(deterministicPick(['a', 'b'], '2026-11-11'), ['a', 'b']);
  assert.deepEqual(deterministicPick([], '2026-11-11'), []);
});

void test('当天缓存命中时原样使用，并保留当日缓存对象', () => {
  const cache = { day: '2026-11-11', ids: ['c', 'a', 'b'] };
  const result = resolveRecall(pool(['a', 'b', 'c', 'd']), '2026-11-11', cache);
  assert.deepEqual(
    result.picks.map((item) => item.id),
    ['c', 'a', 'b'],
  );
  assert.equal(result.cache, cache);
});

void test('缓存里的文档被删掉时保留剩余命中，不拿别的文档补位', () => {
  const cache = { day: '2026-11-11', ids: ['a', 'x', 'b'] };
  const result = resolveRecall(pool(['a', 'b', 'c', 'd']), '2026-11-11', cache);
  assert.deepEqual(
    result.picks.map((item) => item.id),
    ['a', 'b'],
  );
  assert.equal(result.cache, cache);
});

void test('缓存全部落空时按日期重新抽，并给出新缓存', () => {
  const cache = { day: '2026-11-11', ids: ['x', 'y', 'z'] };
  const result = resolveRecall(pool('abcdefghijkl'.split('')), '2026-11-11', cache);
  assert.deepEqual(
    result.picks.map((item) => item.id),
    ['e', 'c', 'l'],
  );
  assert.deepEqual(result.cache, { day: '2026-11-11', ids: ['e', 'c', 'l'] });
});

void test('跨天后重新抽，不沿用昨天的 id', () => {
  const cache = { day: '2026-11-10', ids: ['a', 'b', 'c'] };
  const result = resolveRecall(pool('abcdefghijkl'.split('')), '2026-11-11', cache);
  assert.notDeepEqual(
    result.picks.map((item) => item.id),
    ['a', 'b', 'c'],
  );
  assert.equal(result.cache.day, '2026-11-11');
});

void test('空池不覆盖已有缓存内容', () => {
  const cache = { day: '2026-11-11', ids: ['a', 'b'] };
  const result = resolveRecall([], '2026-11-11', cache);
  assert.deepEqual(result.picks, []);
  assert.equal(result.cache, cache);
});
