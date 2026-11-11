import type { RecallCache } from '../../data/stores/machine-store.ts';

/** 每天回顾的条数 */
export const RECALL_SIZE = 3;

export interface RecallCandidate {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly path: string;
}

export interface RecallResolution {
  readonly picks: readonly RecallCandidate[];
  /** 需要落盘时与入参不同；同一天且仍有命中时原样返回 */
  readonly cache: RecallCache;
}

/** 本地日期键；按本机时区切日，跨时区不共享当天结果 */
export const recallDayKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** 日期做种子的确定性洗牌：同一天、同一批 id 永远得到同一顺序 */
export const deterministicPick = (
  ids: readonly string[],
  day: string,
  count: number = RECALL_SIZE,
): readonly string[] => {
  if (ids.length === 0 || count <= 0) return [];
  // 先排序，保证结果与调用方给的文档顺序无关
  const pool = [...ids].sort((left, right) => left.localeCompare(right));
  let seed = 0;
  for (const char of day) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    const current = pool[index];
    const other = pool[swapWith];
    if (current === undefined || other === undefined) continue;
    pool[index] = other;
    pool[swapWith] = current;
  }
  return pool.slice(0, Math.min(count, pool.length));
};

/**
 * 当天结果优先用缓存；缓存里的文档被删除/改名后仍保留剩下的命中，
 * 全部落空才按日期重新抽。绝不从池子里“猜”一个来补位。
 */
export const resolveRecall = (
  pool: readonly RecallCandidate[],
  day: string,
  cache: RecallCache | null,
): RecallResolution => {
  if (pool.length === 0) {
    return { picks: [], cache: cache ?? { day, ids: [] } };
  }
  if (cache !== null && cache.day === day && cache.ids.length > 0) {
    const byId = new Map(pool.map((item) => [item.id, item]));
    const picks = cache.ids
      .map((id) => byId.get(id))
      .filter((item): item is RecallCandidate => item !== undefined);
    if (picks.length > 0) return { picks, cache };
  }
  const ids = deterministicPick(
    pool.map((item) => item.id),
    day,
  );
  const byId = new Map(pool.map((item) => [item.id, item]));
  return {
    picks: ids
      .map((id) => byId.get(id))
      .filter((item): item is RecallCandidate => item !== undefined),
    cache: { day, ids },
  };
};
