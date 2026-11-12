import type { DocId } from '#doc-model';
import { EmberError, toEmberError } from './errors.ts';
import type { EventBus } from './events.ts';
import type { IndexPort } from './ports.ts';
import type {
  Disposable,
  IndexEvent,
  IndexStats,
  IndexedDocument,
  LinkRecord,
  Logger,
  SearchQuery,
  SearchResult,
} from './types.ts';

/**
 * 派生数据服务（kernel-contract §4）；目标上唯一可读索引的组件。
 * 说明：v1 还没有索引写入方——Rust 侧 SQLite/FTS5 尚未接入，
 * 启动时注入的是 `createPendingIndexPort` 占位实现（`available: false`）。
 * 此时除 `watch`（空实现）外，所有方法都会抛 `index_unavailable`，包括 `rebuild`。
 */
export interface IndexService {
  document(id: DocId): Promise<IndexedDocument | null>;
  search(query: SearchQuery): Promise<SearchResult>;
  outbound(id: DocId): Promise<readonly LinkRecord[]>;
  backlinks(id: DocId): Promise<readonly LinkRecord[]>;
  stats(): Promise<IndexStats>;
  rebuild(): Promise<IndexStats>;
  watch(listener: (event: IndexEvent) => void): Disposable;
}

export interface IndexServiceOptions {
  readonly port: IndexPort;
  readonly events: EventBus;
  readonly log: Logger;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

const normalizeLimit = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
};

export const createIndexService = (options: IndexServiceOptions): IndexService => {
  const { port, events, log } = options;

  const ensureAvailable = (): void => {
    if (!port.available) {
      throw new EmberError('index_unavailable', '索引不可用，正在重建');
    }
  };

  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    ensureAvailable();
    try {
      return await work();
    } catch (error) {
      if (error instanceof EmberError) throw error;
      const wrapped = toEmberError(error, 'index_unavailable');
      log.error('索引查询失败', { code: wrapped.code, message: wrapped.message });
      throw wrapped;
    }
  };

  return {
    document: (id) => guard(async () => port.document(id)),

    search: (query) =>
      guard(async () => {
        const result = await port.search({
          text: query.text,
          limit: normalizeLimit(query.limit),
          tags: query.tags ?? null,
          pathPrefix: query.pathPrefix ?? null,
        });
        return result;
      }),

    outbound: (id) => guard(async () => port.outbound(id)),
    backlinks: (id) => guard(async () => port.backlinks(id)),
    stats: () => guard(async () => port.stats()),

    rebuild: () =>
      guard(async () => {
        const stats = await port.rebuild();
        events.emit('index:updated', { changedDocIds: [] });
        log.info('索引重建完成', { documents: stats.documents });
        return stats;
      }),

    watch: (listener) => {
      const inner = port.watch((event) => {
        if (event.kind === 'updated') {
          events.emit('index:updated', { changedDocIds: event.changedDocIds });
        }
        listener(event);
      });
      return {
        dispose: (): void => {
          inner.dispose();
        },
      };
    },
  };
};
