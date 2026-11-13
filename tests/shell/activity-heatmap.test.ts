import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHeatmap } from '../../src/shell/settings/activity-heatmap.ts';

/** 固定基准日：2026-11-14（周六） */
const TODAY = new Date(2026, 10, 14);

const iso = (year: number, month: number, day: number, hour = 12): string =>
  new Date(year, month - 1, day, hour).toISOString();

void test('网格恒为 weeks × 7，且今天之后全是 future 空位', () => {
  const grid = buildHeatmap([], TODAY, 26);
  assert.equal(grid.weeks.length, 26);
  for (const week of grid.weeks) assert.equal(week.length, 7);
  const lastWeek = grid.weeks[grid.weeks.length - 1];
  assert.notEqual(lastWeek, undefined);
  // 今天是周六（周一序 5），周日是 future
  assert.equal(lastWeek?.[5]?.future, false);
  assert.equal(lastWeek?.[6]?.future, true);
  // 今天格子键正确
  assert.equal(lastWeek?.[5]?.key, '2026-11-14');
});

void test('同一天多篇文档按篇计；同一篇多次更新只计 1', () => {
  const grid = buildHeatmap(
    [
      { id: 'a', updatedAt: iso(2026, 11, 14, 9) },
      { id: 'b', updatedAt: iso(2026, 11, 14, 10) },
      { id: 'a', updatedAt: iso(2026, 11, 14, 11) },
    ],
    TODAY,
    2,
  );
  const lastWeek = grid.weeks[grid.weeks.length - 1];
  assert.equal(lastWeek?.[5]?.count, 2);
  assert.equal(grid.maxCount, 2);
  assert.equal(grid.totalDocs, 2);
});

void test('相对强度分级：maxCount 4 时 1/2/3/4 分属 1-4 级', () => {
  const grid = buildHeatmap(
    [
      { id: 'a', updatedAt: iso(2026, 11, 14) },
      { id: 'b', updatedAt: iso(2026, 11, 14) },
      { id: 'c', updatedAt: iso(2026, 11, 14) },
      { id: 'd', updatedAt: iso(2026, 11, 14) },
      { id: 'e', updatedAt: iso(2026, 11, 13) },
      { id: 'f', updatedAt: iso(2026, 11, 13) },
      { id: 'g', updatedAt: iso(2026, 11, 12) },
      { id: 'h', updatedAt: iso(2026, 11, 11) },
      { id: 'i', updatedAt: iso(2026, 11, 10) },
    ],
    TODAY,
    2,
  );
  const last = grid.weeks[grid.weeks.length - 1];
  assert.equal(last?.[5]?.level, 4); // 4/4
  assert.equal(last?.[4]?.level, 2); // 2/4 = 0.5
  assert.equal(last?.[3]?.level, 1); // 1/4 = 0.25
  assert.equal(last?.[2]?.level, 1); // 1/4
  assert.equal(last?.[1]?.level, 1); // 1/4
});

void test('对齐周一：首列第一格一定是周一', () => {
  const grid = buildHeatmap([], TODAY, 8);
  const first = grid.weeks[0]?.[0];
  assert.notEqual(first, undefined);
  assert.equal(new Date(`${first?.key}T00:00:00`).getDay(), 1);
});

void test('非法日期被忽略', () => {
  const grid = buildHeatmap([{ id: 'a', updatedAt: 'not-a-date' }], TODAY, 4);
  assert.equal(grid.totalDocs, 0);
  assert.equal(grid.activeDays, 0);
});
