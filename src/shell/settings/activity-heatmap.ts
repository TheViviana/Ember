/**
 * 写作活动热力图数据：按文档 updated 日期聚合到天，铺成周 × 星期网格。
 * 与 GitHub 贡献图同构：列 = 周（对齐周一），行 = 星期（周一到周日）。
 * 口径：一天内多篇文档更新按篇数计；同一篇改多次只计 1。
 */

export interface HeatmapDay {
  /** YYYY-MM-DD */
  readonly key: string;
  /** 该日更新的文档篇数（同一篇多次修改只计 1） */
  readonly count: number;
  /** 相对强度 0-4：0 = 无活动 */
  readonly level: 0 | 1 | 2 | 3 | 4;
  /** 是否为今天之后的格子（渲染为空位） */
  readonly future: boolean;
}

export interface HeatmapGrid {
  /** 列 = 周，每周恒 7 格 */
  readonly weeks: readonly (readonly HeatmapDay[])[];
  readonly maxCount: number;
  readonly activeDays: number;
  readonly totalDocs: number;
}

const MS_DAY = 86_400_000;

const dayKey = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');

/** 周一 = 0 … 周日 = 6 */
const mondayIndex = (date: Date): number => (date.getDay() + 6) % 7;

const levelOf = (count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 => {
  if (count === 0) return 0;
  if (maxCount <= 1) return 4;
  const ratio = count / maxCount;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
};

export interface HeatmapDoc {
  /** 文档 id：同一天去重用 */
  readonly id: string;
  /** updated ISO 字符串（允许 Z 结尾），按本地日历日聚合 */
  readonly updatedAt: string;
}

export const buildHeatmap = (
  docs: readonly HeatmapDoc[],
  today: Date,
  weeks = 26,
): HeatmapGrid => {
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  // 一天内一篇文档只计一次
  const byDay = new Map<string, Set<string>>();
  for (const doc of docs) {
    const parsed = new Date(doc.updatedAt);
    if (Number.isNaN(parsed.getTime())) continue;
    const key = dayKey(parsed);
    const set = byDay.get(key) ?? new Set<string>();
    set.add(doc.id);
    byDay.set(key, set);
  }

  const todayWeekStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - mondayIndex(today),
  );
  const startMs = todayWeekStart.getTime() - (weeks - 1) * 7 * MS_DAY;

  const weeks_: HeatmapDay[][] = [];
  let maxCount = 0;
  let activeDays = 0;
  let totalDocs = 0;

  for (let week = 0; week < weeks; week += 1) {
    const column: HeatmapDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const ms = startMs + (week * 7 + day) * MS_DAY;
      const date = new Date(ms);
      const key = dayKey(date);
      const future = ms > todayMs;
      const count = future ? 0 : (byDay.get(key)?.size ?? 0);
      if (count > 0) {
        maxCount = Math.max(maxCount, count);
        activeDays += 1;
        totalDocs += count;
      }
      column.push({ key, count, level: levelOf(count, 0), future });
    }
    weeks_.push(column);
  }

  // level 依赖全局 maxCount：收集完再回填
  for (const column of weeks_) {
    for (const day of column) {
      if (!day.future) {
        (day as { level: 0 | 1 | 2 | 3 | 4 }).level = levelOf(day.count, maxCount);
      }
    }
  }

  return { weeks: weeks_, maxCount, activeDays, totalDocs };
};
