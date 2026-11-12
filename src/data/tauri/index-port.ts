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
 * `available = false` 会让 index-service 的所有方法（除 watch）抛 `index_unavailable`。
 * v1 没有任何界面或能力消费该错误码，因此用户不会看到降级态；
 * 反链由外壳前端扫描全库正文临时实现，不经过本端口。
 * `search` / `outbound` / `backlinks` / `stats` 的空返回在 `guard` 之后不可达，保留只为满足端口形状。
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
