import type { IndexPort } from '../../kernel/ports.ts';
import type { IndexStats, SearchResult } from '../../kernel/types.ts';

const EMPTY_STATS: IndexStats = {
  documents: 0,
  links: 0,
  unresolved: 0,
  ambiguous: 0,
  lastBuiltAt: '1970-01-01T00:00:00Z',
  tokenizerVersion: 0,
};

const EMPTY_RESULT: SearchResult = { hits: [], total: 0, truncated: false };

/**
 * 索引端口：SQLite + FTS5 在 Rust 侧尚未接入时使用。
 * `available = false` 会让 index-service 统一抛 index_unavailable，界面据此展示降级态，
 * 而不是静默返回空结果骗过用户。
 */
export const createPendingIndexPort = (reason: string): IndexPort => {
  const reject = (): Promise<never> => Promise.reject(new Error(reason));
  return {
    available: false,
    document: reject,
    search: () => Promise.resolve(EMPTY_RESULT),
    outbound: () => Promise.resolve([]),
    backlinks: () => Promise.resolve([]),
    stats: () => Promise.resolve(EMPTY_STATS),
    rebuild: reject,
    watch: () => ({ dispose: (): void => {} }),
  };
};
