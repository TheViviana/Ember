import {
  createUlid,
  isUlid,
  unsafeContentHash,
  type ContentHash,
  type DocId,
  type VaultPath,
} from '#doc-model';
import { hashBytes, utcNow } from './doc-text.ts';
import type { VaultStatePort } from './ports.ts';
import type { DocHistoryEntry, Logger } from './types.ts';

/** 新历史日志（库外）：`history/log.jsonl` + 扁平的 `history/versions/<ULID>.md` */
const LOG_PATH = 'history/log.jsonl';
const VERSIONS_DIR = 'history/versions';

/** 每篇文档保留的历史版本数 */
const HISTORY_KEEP = 20;
/** 每篇文档历史版本的字节预算 */
const HISTORY_BUDGET = 64 * 1024 * 1024;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface LogEntry {
  readonly docId: DocId;
  readonly versionId: string;
  readonly hash: ContentHash;
  /** 版本写入时文档所在路径，仅用于展示 */
  readonly path: VaultPath;
  readonly at: string;
  readonly size: number;
}

export interface HistoryStore {
  /** 新→旧；日志缺失/损坏返回空并告警，不抛错 */
  list(id: DocId): Promise<readonly DocHistoryEntry[]>;
  read(id: DocId, versionId: string): Promise<{ entry: DocHistoryEntry; bytes: Uint8Array } | null>;
  /** 先写版本文件，再原子重写日志；任何一步失败都不会留下指向半截数据的索引 */
  record(id: DocId, path: VaultPath, bytes: Uint8Array): Promise<void>;
  /** 改名后把该文档的全部日志条目换到新 docId（路径标签保留写入时的旧路径） */
  retag(from: DocId, to: DocId): Promise<void>;
}

export interface HistoryStoreOptions {
  readonly state: VaultStatePort;
  readonly log: Logger;
  readonly now?: () => Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseEntry = (raw: unknown): LogEntry | null => {
  if (!isRecord(raw)) return null;
  const docId = raw['docId'];
  const versionId = raw['versionId'];
  const hash = raw['hash'];
  const path = raw['path'];
  const at = raw['at'];
  const size = raw['size'];
  if (typeof docId !== 'string' || docId.length === 0) return null;
  if (typeof versionId !== 'string' || !isUlid(versionId)) return null;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) return null;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof at !== 'string' || at.length === 0) return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  return {
    docId: docId as DocId,
    versionId,
    hash: unsafeContentHash(hash),
    path: path as VaultPath,
    at,
    size,
  };
};

const toPublic = (entry: LogEntry): DocHistoryEntry => ({
  versionId: entry.versionId,
  hash: entry.hash,
  path: entry.path,
  at: entry.at,
  size: entry.size,
});

/** 保留策略：每篇最多 HISTORY_KEEP 版、总字节不超过 HISTORY_BUDGET，永远保留最新一条 */
const prune = (entries: readonly LogEntry[]): { kept: LogEntry[]; dropped: LogEntry[] } => {
  const dropped: LogEntry[] = [];
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    if (entries.length - dropped.length <= HISTORY_KEEP && total <= HISTORY_BUDGET) break;
    const victim = entries[index];
    if (victim === undefined) continue;
    dropped.push(victim);
    total -= victim.size;
  }
  if (dropped.length === 0) return { kept: [...entries], dropped };
  const droppedIds = new Set(dropped.map((entry) => entry.versionId));
  return { kept: entries.filter((entry) => !droppedIds.has(entry.versionId)), dropped };
};

export const createHistoryStore = (options: HistoryStoreOptions): HistoryStore => {
  const { state, log } = options;
  const now = options.now ?? ((): Date => new Date());
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();

  /** 读全量日志；单行损坏只跳过该行，整份日志不可读则告警并返回空 */
  const readLog = async (): Promise<LogEntry[]> => {
    const bytes = await state.read(LOG_PATH);
    if (bytes === null) return [];
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      log.warn('历史日志不是合法 UTF-8，已忽略', { path: LOG_PATH });
      return [];
    }
    const entries: LogEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        log.warn('历史日志有一行无法解析，已跳过', { path: LOG_PATH });
        continue;
      }
      const entry = parseEntry(parsed);
      if (entry === null) {
        log.warn('历史日志有一行结构非法，已跳过', { path: LOG_PATH });
        continue;
      }
      entries.push(entry);
    }
    return entries;
  };

  const writeLog = async (entries: readonly LogEntry[]): Promise<void> => {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await state.write(LOG_PATH, encoder.encode(body.length === 0 ? '' : `${body}\n`));
  };

  const purgeVersion = async (versionId: string): Promise<void> => {
    try {
      await state.purge(`${VERSIONS_DIR}/${versionId}.md`);
    } catch (error) {
      // 日志已经不再指向它：删不掉只是占空间，下一次覆盖时会再尝试
      log.warn('历史版本文件清理失败', { versionId, error: String(error) });
    }
  };

  return {
    list: async (id) => {
      const entries = await readLog();
      return entries
        .filter((entry) => entry.docId === id)
        .sort((left, right) => (left.versionId < right.versionId ? 1 : -1))
        .map(toPublic);
    },

    read: async (id, versionId) => {
      const entries = await readLog();
      const entry = entries.find((item) => item.docId === id && item.versionId === versionId);
      if (entry === undefined) return null;
      const bytes = await state.read(`${VERSIONS_DIR}/${versionId}.md`);
      if (bytes === null) return null;
      return { entry: toPublic(entry), bytes };
    },

    record: async (id, path, bytes) => {
      const versionId = createUlid(now().getTime());
      const hash = await hashBytes(bytes);
      const entry: LogEntry = {
        docId: id,
        versionId,
        hash,
        path,
        at: utcNow(now()),
        size: bytes.length,
      };
      await state.write(`${VERSIONS_DIR}/${versionId}.md`, bytes);
      try {
        const all = await readLog();
        const mine = all.filter((item) => item.docId === id);
        const { kept, dropped } = prune([entry, ...mine]);
        const keptIds = new Set(kept.map((item) => item.versionId));
        const others = all.filter((item) => item.docId !== id && !keptIds.has(item.versionId));
        // 保持「新在前」：本文件的版本紧随新条目，其它文档的顺序原样保留
        await writeLog([...kept, ...others]);
        for (const droppedEntry of dropped) await purgeVersion(droppedEntry.versionId);
      } catch (error) {
        await purgeVersion(versionId);
        throw error;
      }
    },

    retag: async (from, to) => {
      const entries = await readLog();
      let changed = false;
      const next = entries.map((entry) => {
        if (entry.docId !== from) return entry;
        changed = true;
        return { ...entry, docId: to };
      });
      if (changed) await writeLog(next);
    },
  };
};
