import { createUlid, isUlid, type DocId } from '#doc-model';
import { utcNow } from './doc-text.ts';
import { EmberError } from './errors.ts';
import type { DocServiceInternal } from './doc-service.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort, VaultStatePort } from './ports.ts';
import type { Logger, SettingsService } from './types.ts';

const SNAPSHOT_ROOT = 'migrations';
const SNAPSHOTS_KEPT = 10;

/** 迁移/回滚的结果；`noop` 表示库已迁移或没有旧 ULID 引用 */
export interface DocIdMigrationReport {
  readonly status: 'noop' | 'migrated' | 'rolledBack';
  readonly snapshotId: string | null;
  /** 旧 `id` 指向的文档数 */
  readonly docs: number;
  /** 实际重写的画布数 */
  readonly canvases: number;
  /** 实际重写的画布节点数 */
  readonly nodes: number;
  /** 转成 `kind:'note'` 占位的节点数 */
  readonly placeholders: number;
  /** 实际重写的 linkOverrides 条目数 */
  readonly overrides: number;
  /** 映射不到唯一文档而丢弃的 linkOverrides 条目数 */
  readonly droppedOverrides: number;
  readonly warnings: readonly string[];
}

export interface DocIdMigrationStatus {
  readonly migrated: boolean;
  readonly snapshots: readonly string[];
}

export interface MigrationService {
  /** 启动时调用；已迁移（settings.docIdScheme === 'path'）时直接返回 noop */
  migrate(): Promise<DocIdMigrationReport>;
  /** 从快照恢复画布 docId、linkOverrides 与 settings.docIdScheme；默认最近一份 */
  rollback(snapshotId?: string): Promise<DocIdMigrationReport>;
  status(): Promise<DocIdMigrationStatus>;
}

export interface MigrationServiceOptions {
  readonly port: VaultPort;
  readonly state: VaultStatePort;
  readonly paths: PathTools;
  readonly settings: SettingsService;
  readonly docs: DocServiceInternal;
  readonly log: Logger;
  readonly now?: () => Date;
}

interface SnapshotCanvas {
  readonly path: string;
  readonly text: string;
}

interface SnapshotFile {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly at: string;
  readonly legacy: Readonly<Record<string, readonly string[]>>;
  readonly canvases: readonly SnapshotCanvas[];
  readonly linkOverrides: Readonly<Record<string, string>>;
  readonly placeholders: readonly string[];
  readonly warnings: readonly string[];
}

const emptyReport = (status: DocIdMigrationReport['status']): DocIdMigrationReport => ({
  status,
  snapshotId: null,
  docs: 0,
  canvases: 0,
  nodes: 0,
  placeholders: 0,
  overrides: 0,
  droppedOverrides: 0,
  warnings: [],
});

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 旧 ULID → 路径的一次性迁移（P1b 阶段 2）。
 *
 * 顺序刻意固定：
 * 1. 快照先原子写库外（`vaults/<key>/migrations/<ULID>/snapshot.json`）；
 * 2. 逐画布重写 docId 并原子落盘；
 * 3. 最后整表替换 linkOverrides 并写入 `settings.docIdScheme='path'`。
 *
 * 任一步失败都不会写 `docIdScheme`，下次启动可重试；回滚只依赖快照，
 * 不碰任何 `.md`（D8：正文与 frontmatter 一个字节都不动）。
 */
export const createMigrationService = (options: MigrationServiceOptions): MigrationService => {
  const { port, state, paths, settings, docs, log } = options;
  const now = options.now ?? ((): Date => new Date());

  const snapshotPath = (id: string): string => `${SNAPSHOT_ROOT}/${id}/snapshot.json`;

  const readSnapshot = async (id: string): Promise<SnapshotFile> => {
    const bytes = await state.read(snapshotPath(id));
    if (bytes === null) {
      throw new EmberError('doc_not_found', `迁移快照不存在：${id}`, { snapshotId: id });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes)) as unknown;
    } catch (error) {
      throw new EmberError('invalid_payload', `迁移快照不是合法 JSON：${id}`, {
        snapshotId: id,
        reason: String(error),
      });
    }
    if (!isRecord(raw) || raw['schemaVersion'] !== 1) {
      throw new EmberError('invalid_payload', `迁移快照版本不支持：${id}`, { snapshotId: id });
    }
    return raw as unknown as SnapshotFile;
  };

  /** 旧历史桶（D6：原样保留）只用来补 basename 线索；读不到就算了 */
  let indexesCache: ReadonlyMap<string, string> | null = null;
  const historyIndexes = async (): Promise<ReadonlyMap<string, string>> => {
    if (indexesCache !== null) return indexesCache;
    const found = new Map<string, string>();
    const inventory = await port.scan();
    for (const entry of inventory) {
      const match = /^\.workbench\/history\/documents\/([^/]+)\/index\.json$/.exec(String(entry.path));
      if (match !== null && match[1] !== undefined) found.set(match[1], String(entry.path));
    }
    indexesCache = found;
    return found;
  };

  const basenamesFromHistory = async (
    ulid: string,
    indexes: ReadonlyMap<string, string>,
  ): Promise<string | null> => {
    const path = indexes.get(ulid);
    if (path === undefined) return null;
    const bytes = await port.read(paths.normalize(path));
    if (bytes === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(raw) || !Array.isArray(raw['versions'])) return null;
    const names = new Set<string>();
    for (const item of raw['versions'] as readonly unknown[]) {
      if (!isRecord(item) || typeof item['path'] !== 'string') continue;
      const normalized = paths.normalize(item['path']);
      names.add(paths.basename(normalized));
    }
    return names.size === 1 ? ([...names][0] ?? null) : null;
  };

  const clueText = (ulid: string, basename: string | null): string =>
    basename === null
      ? `原文档引用已失效\n\n原文档 id：${ulid}`
      : `原文档引用已失效\n\n原文档 id：${ulid}\n原文件名：${basename}`;

  const migrate = async (): Promise<DocIdMigrationReport> => {
    const current = await settings.read();
    if (current.docIdScheme === 'path') return emptyReport('noop');

    const legacy = await docs.legacyIds();
    const warnings: string[] = [];
    const overrides = current.linkOverrides;
    const oldOverrides = Object.entries(overrides).filter(([, value]) => isUlid(String(value)));

    const canvases = await port.listCanvases();
    const pending: { path: string; text: string; nextText: string }[] = [];
    const placeholders: string[] = [];
    let nodes = 0;
    let placeholderCount = 0;

    if (canvases.length > 0) {
      for (const canvasPath of canvases) {
        const bytes = await port.read(canvasPath);
        if (bytes === null) continue;
        let text: string;
        try {
          text = decoder.decode(bytes);
        } catch {
          warnings.push(`画布不是合法 UTF-8，跳过：${String(canvasPath)}`);
          continue;
        }
        // 直接在原始 JSON 上改节点：旧画布的 `docId` 是 ULID，已经过不了
        // parseCanvasDocument 的路径校验；整份重排还会顺手改掉无关字段。
        let raw: unknown;
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          warnings.push(`画布 JSON 无法解析，跳过：${String(canvasPath)}`);
          continue;
        }
        if (!isRecord(raw) || !Array.isArray(raw['nodes'])) {
          warnings.push(`画布结构不合法，跳过：${String(canvasPath)}`);
          continue;
        }
        let changed = false;
        for (const item of raw['nodes'] as readonly unknown[]) {
          if (!isRecord(item)) continue;
          if (item['kind'] !== 'doc') continue;
          const rawDocId = item['docId'];
          if (typeof rawDocId !== 'string' || !isUlid(rawDocId)) continue;
          const candidates = legacy.get(rawDocId) ?? [];
          if (candidates.length === 1) {
            item['docId'] = String(candidates[0]);
            nodes += 1;
            changed = true;
            continue;
          }
          // 映射不到唯一文档（0 个或多个）：转 note 占位，正文留可追溯线索
          const indexes = candidates.length === 0 ? await historyIndexes() : new Map();
          const basename =
            candidates.length === 0
              ? await basenamesFromHistory(rawDocId, indexes)
              : null;
          item['kind'] = 'note';
          item['docId'] = null;
          item['text'] = clueText(rawDocId, basename);
          placeholders.push(`${String(canvasPath)}#${String(item['id'])}: ${rawDocId}`);
          placeholderCount += 1;
          nodes += 1;
          changed = true;
        }
        if (changed) {
          pending.push({
            path: canvasPath,
            text,
            nextText: `${JSON.stringify(raw, null, 2)}\n`,
          });
        }
      }
    }

    if (
      legacy.size === 0 &&
      pending.length === 0 &&
      oldOverrides.length === 0
    ) {
      // 全新库：没有旧 ULID 可迁，不写 settings、不制造快照
      return emptyReport('noop');
    }

    const snapshotId = createUlid(now().getTime());
    const snapshot: SnapshotFile = {
      schemaVersion: 1,
      snapshotId,
      at: utcNow(now()),
      legacy: Object.fromEntries([...legacy.entries()].map(([key, list]) => [key, list.map(String)])),
      canvases: pending.map((item) => ({ path: String(item.path), text: item.text })),
      linkOverrides: Object.fromEntries(
        Object.entries(overrides).map(([key, value]) => [key, String(value)]),
      ),
      placeholders,
      warnings,
    };
    await state.write(snapshotPath(snapshotId), encoder.encode(`${JSON.stringify(snapshot, null, 2)}\n`));
    await trimSnapshots();

    for (const item of pending) {
      await port.write(paths.normalize(item.path), encoder.encode(item.nextText), 'system');
    }

    const nextOverrides: Record<string, DocId> = {};
    let rewritten = 0;
    let dropped = 0;
    for (const [key, value] of Object.entries(overrides)) {
      if (!isUlid(String(value))) {
        nextOverrides[key] = value;
        continue;
      }
      const candidates = legacy.get(String(value)) ?? [];
      const only = candidates[0];
      if (candidates.length === 1 && only !== undefined) {
        nextOverrides[key] = only as unknown as DocId;
        rewritten += 1;
      } else {
        dropped += 1;
        warnings.push(`linkOverrides「${key}」指向的旧 id 无法唯一映射，已丢弃：${String(value)}`);
        log.warn('linkOverrides 指向的旧 id 无法唯一映射，已丢弃', { key, value: String(value) });
      }
    }

    await settings.applyDocIdScheme({ linkOverrides: nextOverrides, scheme: 'path' });

    const report: DocIdMigrationReport = {
      status: 'migrated',
      snapshotId,
      docs: legacy.size,
      canvases: pending.length,
      nodes,
      placeholders: placeholderCount,
      overrides: rewritten,
      droppedOverrides: dropped,
      warnings,
    };
    log.info('文档身份迁移完成', {
      snapshotId,
      docs: report.docs,
      canvases: report.canvases,
      nodes: report.nodes,
      placeholders: report.placeholders,
      overrides: report.overrides,
      droppedOverrides: report.droppedOverrides,
    });
    return report;
  };

  const trimSnapshots = async (): Promise<void> => {
    const ids = await state.list(SNAPSHOT_ROOT);
    // 目录名按时间戳前缀排序；只保留最近 SNAPSHOTS_KEPT 份
    for (const id of ids.slice(0, Math.max(0, ids.length - SNAPSHOTS_KEPT))) {
      await state.purge(`${SNAPSHOT_ROOT}/${id}/snapshot.json`).catch((error: unknown) => {
        log.warn('旧迁移快照清理失败', { snapshotId: id, error: String(error) });
      });
    }
  };

  const rollback = async (snapshotId?: string): Promise<DocIdMigrationReport> => {
    const ids = await state.list(SNAPSHOT_ROOT);
    const chosen = snapshotId ?? ids[ids.length - 1];
    if (chosen === undefined) {
      throw new EmberError('doc_not_found', '没有可回滚的迁移快照');
    }
    const snapshot = await readSnapshot(chosen);
    for (const canvas of snapshot.canvases) {
      await port.write(paths.normalize(canvas.path), encoder.encode(canvas.text), 'system');
    }
    await settings.applyDocIdScheme({
      linkOverrides: Object.fromEntries(
        Object.entries(snapshot.linkOverrides).map(([key, value]) => [key, value as DocId]),
      ),
      scheme: null,
    });
    const report: DocIdMigrationReport = {
      status: 'rolledBack',
      snapshotId: chosen,
      docs: Object.keys(snapshot.legacy).length,
      canvases: snapshot.canvases.length,
      nodes: 0,
      placeholders: snapshot.placeholders.length,
      overrides: Object.keys(snapshot.linkOverrides).length,
      droppedOverrides: 0,
      warnings: snapshot.warnings,
    };
    log.info('文档身份迁移已回滚', { snapshotId: chosen, canvases: report.canvases });
    return report;
  };

  return {
    migrate,
    rollback,
    status: async () => {
      const current = await settings.read();
      return {
        migrated: current.docIdScheme === 'path',
        snapshots: await state.list(SNAPSHOT_ROOT),
      };
    },
  };
};
