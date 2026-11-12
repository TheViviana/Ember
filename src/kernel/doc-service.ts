import {
  createUlid,
  deriveSummary,
  joinFrontmatter,
  merge3,
  normalizeFrontmatter,
  splitFrontmatter,
  toSerializable,
  unsafeContentHash,
  asDocId,
  type ContentHash,
  type DocId,
  type Frontmatter,
  type FrontmatterIssue,
  type VaultPath,
} from '#doc-model';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { EventBus } from './events.ts';
import { EmberError } from './errors.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
import type {
  ConflictCopy,
  CreateDocInput,
  Disposable,
  DocChange,
  DocFilter,
  DocMeta,
  DocPatch,
  DocSnapshot,
  Logger,
  WriteOptions,
  WriteOutcome,
} from './types.ts';

/** 内核对外暴露的文档服务（kernel-contract §3），也是磁盘写入的唯一入口（I1） */
export interface DocService {
  read(id: DocId): Promise<DocSnapshot>;
  readByPath(path: VaultPath): Promise<DocSnapshot | null>;
  list(filter?: DocFilter): Promise<readonly DocMeta[]>;

  create(input: CreateDocInput): Promise<DocSnapshot>;
  update(id: DocId, patch: DocPatch, opts: WriteOptions): Promise<WriteOutcome>;
  rename(id: DocId, next: VaultPath, opts: WriteOptions): Promise<WriteOutcome>;
  remove(id: DocId, opts: WriteOptions): Promise<void>;

  flush(): Promise<void>;
  watch(listener: (change: DocChange) => void): Disposable;
}

/** 内核内部扩展：watcher 触发目录对账用，不暴露给能力 */
export interface DocServiceInternal extends DocService {
  /** 全量对账：文件 → 目录；只收录已具备合法且唯一 id 的文档 */
  refresh(): Promise<void>;
}

interface CatalogEntry {
  readonly id: DocId;
  path: VaultPath;
  rev: number;
  hash: ContentHash;
  /** 与 hash 对应的完整文件文本，供三方合并取 base */
  text: string;
}

export interface DocServiceOptions {
  readonly port: VaultPort;
  readonly paths: PathTools;
  readonly events: EventBus;
  readonly log: Logger;
  readonly now?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const hashBytes = async (bytes: Uint8Array): Promise<ContentHash> => {
  const view = new Uint8Array(bytes);
  return unsafeContentHash(`sha256:${toHex(await crypto.subtle.digest('SHA-256', view))}`);
};

const utcNow = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

interface ParsedText {
  readonly frontmatter: Frontmatter;
  readonly body: string;
  /** frontmatter 块存在但 YAML 语法非法：整段原文按 body 降级保留，文档等待 adoption */
  readonly frontmatterBroken: boolean;
  /** 取值非法的保留键（原值已在 extra 中保留，修正前不参与语义） */
  readonly issues: readonly FrontmatterIssue[];
}

const parseDocText = (text: string): ParsedText => {
  const split = splitFrontmatter(text);
  if (split.raw === null) {
    return {
      frontmatter: normalizeFrontmatter({}).frontmatter,
      body: text,
      frontmatterBroken: false,
      issues: [],
    };
  }
  // YAML 语法非法的 frontmatter 不能炸穿 refresh（否则一行坏文件让整库不可用）。
  // 降级为「无合法 frontmatter」并把逐字节原文按 body 保留：id 缺失 → refresh 跳过等待
  // adoption，内核任何写路径都拿不到该文档，磁盘内容不会被改写。
  let parsed: unknown;
  try {
    parsed = parseYaml(split.raw);
  } catch {
    return {
      frontmatter: normalizeFrontmatter({}).frontmatter,
      body: text,
      frontmatterBroken: true,
      issues: [],
    };
  }
  const record: Readonly<Record<string, unknown>> =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  const normalized = normalizeFrontmatter(record);
  return {
    frontmatter: normalized.frontmatter,
    body: split.body,
    frontmatterBroken: false,
    issues: normalized.issues,
  };
};

const composeDocText = (frontmatter: Frontmatter, body: string): string => {
  const serializable = toSerializable(frontmatter);
  if (Object.keys(serializable).length === 0) return body;
  return joinFrontmatter(stringifyYaml(serializable, { lineWidth: 0 }).replace(/\n$/, ''), body);
};

/** 三态补丁：undefined 保留、null 删键、其余覆盖（null 让「清空简介」回落派生而不是写空串） */
const withFrontmatterPatch = (base: Frontmatter, patch: DocPatch): Frontmatter => {
  const next = patch.frontmatter;
  if (next === undefined) return base;
  return {
    ...base,
    title: next.title === undefined ? base.title : next.title,
    summary: next.summary === undefined ? base.summary : next.summary,
    tags: next.tags ?? base.tags,
    aliases: next.aliases ?? base.aliases,
  };
};

/** 目录对账：只收录已具备合法且唯一 id 的文档；adoption 尚未实现（vault-format §3.3） */
export const createDocService = (options: DocServiceOptions): DocServiceInternal => {
  const { port, paths, events, log } = options;
  const now = options.now ?? ((): Date => new Date());

  const entries = new Map<string, CatalogEntry>();
  const byPath = new Map<string, DocId>();
  const listeners = new Set<(change: DocChange) => void>();
  const pending = new Set<Promise<unknown>>();
  let scanned = false;

  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };

  const emitChange = (change: DocChange): void => {
    events.emit('doc:changed', change);
    for (const listener of [...listeners]) listener(change);
  };

  const assertWritable = (): void => {
    if (port.readonlyMode) {
      throw new EmberError('vault_locked', '当前库为只读模式，写操作被拒绝');
    }
  };

  const metaOf = (entry: CatalogEntry): DocMeta => {
    const parsed = parseDocText(entry.text);
    const title = parsed.frontmatter.title ?? paths.stem(entry.path);
    return {
      id: entry.id,
      path: entry.path,
      title,
      summary: parsed.frontmatter.summary ?? deriveSummary(parsed.body),
      tags: parsed.frontmatter.tags,
      aliases: parsed.frontmatter.aliases,
      created: parsed.frontmatter.created ?? '',
      updated: parsed.frontmatter.updated ?? '',
      rev: { rev: entry.rev, hash: entry.hash },
      flags: { needsAdoption: false, idInvalid: false, duplicateId: false },
    };
  };

  const snapshotOf = (entry: CatalogEntry): DocSnapshot => {
    const parsed = parseDocText(entry.text);
    return { meta: metaOf(entry), frontmatter: parsed.frontmatter, text: entry.text };
  };

  const requireEntry = (id: DocId): CatalogEntry => {
    const entry = entries.get(String(id));
    if (entry === undefined) {
      throw new EmberError('doc_not_found', `文档不存在：${String(id)}`, { id: String(id) });
    }
    return entry;
  };

  const readBytes = async (path: VaultPath): Promise<Uint8Array | null> => port.read(path);

  const refresh = async (): Promise<void> => {
    const pathsInVault = await port.list();
    const present = new Set(pathsInVault.map((item) => String(item)));
    const seen = new Set<string>();
    const duplicateIds = new Set<string>();

    for (const path of pathsInVault) {
      if (paths.ext(path).toLowerCase() !== '.md') continue;
      const bytes = await readBytes(path);
      if (bytes === null) continue;
      const text = decoder.decode(bytes);
      const parsed = parseDocText(text);
      const id = parsed.frontmatter.id === null ? null : asDocId(parsed.frontmatter.id);
      if (id === null) {
        if (parsed.frontmatterBroken) {
          log.warn('frontmatter YAML 无法解析，按待 adoption 跳过该文档', { path: String(path) });
        } else {
          log.warn('跳过缺少合法 id 的文档，等待 adoption', { path: String(path) });
        }
        continue;
      }
      if (parsed.issues.length > 0) {
        log.warn('frontmatter 含取值非法的键，原值已保留、修正前不参与语义', {
          path: String(path),
          keys: parsed.issues.map((issue) => issue.key),
        });
      }
      const hash = await hashBytes(bytes);
      const existing = entries.get(String(id));
      if (existing !== undefined && String(existing.path) !== String(path)) {
        if (present.has(String(existing.path))) {
          // 重复 id：两个路径都还在，保留先收录者（list 为字典序，结果稳定），
          // 后来者不进目录、也不写 byPath
          duplicateIds.add(String(id));
          continue;
        }
        // 同 id 的旧路径已不存在：外部改名/移动，迁移条目而不是当作重复 id 丢弃
        const oldPath = existing.path;
        const changed = existing.hash !== hash;
        const rev = changed ? existing.rev + 1 : existing.rev;
        existing.path = path;
        existing.rev = rev;
        existing.hash = hash;
        existing.text = text;
        byPath.delete(String(oldPath));
        byPath.set(String(path), id);
        seen.add(String(id));
        emitChange({
          id,
          path,
          kind: changed ? 'external' : 'renamed',
          revision: { rev, hash },
        });
        continue;
      }
      const rev = existing === undefined ? 1 : existing.hash === hash ? existing.rev : existing.rev + 1;
      entries.set(String(id), { id, path, rev, hash, text });
      byPath.set(String(path), id);
      seen.add(String(id));
      // 目录对账发现外部改动时广播，编辑器据此自动重载或提示合并
      if (existing === undefined) {
        // 初次扫描不算"新增"，避免启动时把整个库广播成 created
        if (scanned) emitChange({ id, path, kind: 'created', revision: { rev: 1, hash } });
      } else if (existing.hash !== hash) {
        emitChange({ id, path, kind: 'external', revision: { rev, hash } });
      }
    }

    for (const [key, entry] of [...entries]) {
      if (seen.has(key)) continue;
      entries.delete(key);
      byPath.delete(String(entry.path));
      emitChange({ id: entry.id, path: entry.path, kind: 'removed', revision: { rev: entry.rev, hash: entry.hash } });
    }
    scanned = true;
    if (duplicateIds.size > 0) log.warn('检测到重复 id', { ids: [...duplicateIds] });
  };

  const ensureScanned = async (): Promise<void> => {
    if (!scanned) await refresh();
  };

  const commit = async (entry: CatalogEntry, text: string, intent: WriteOptions['intent']): Promise<CatalogEntry> => {
    const bytes = encoder.encode(text);
    await port.write(entry.path, bytes, intent);
    const hash = await hashBytes(bytes);
    entry.text = text;
    entry.hash = hash;
    entry.rev += 1;
    return entry;
  };

  const conflictCopy = async (
    entry: CatalogEntry,
    localText: string,
    intent: WriteOptions['intent'],
  ): Promise<ConflictCopy> => {
    const parsed = parseDocText(localText);
    const copyIdValue = createUlid(now().getTime());
    const copyId = asDocId(copyIdValue);
    if (copyId === null) throw new EmberError('io_failed', '生成冲突副本 id 失败');
    const copyPath = paths.conflictName(entry.path, now(), copyIdValue.slice(-6));
    const frontmatter: Frontmatter = {
      ...parsed.frontmatter,
      id: copyIdValue,
      ember: { ...parsed.frontmatter.ember, conflictOf: String(entry.id) },
    };
    await port.write(copyPath, encoder.encode(composeDocText(frontmatter, parsed.body)), intent);
    events.emit('doc:conflict', { id: entry.id, copyId, copyPath });
    log.warn('写入冲突副本', { id: String(entry.id), copyPath: String(copyPath) });
    return { id: copyId, path: copyPath, of: entry.id };
  };

  const read = async (id: DocId): Promise<DocSnapshot> => {
    await ensureScanned();
    const entry = requireEntry(id);
    const bytes = await readBytes(entry.path);
    if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
    const text = decoder.decode(bytes);
    const hash = await hashBytes(bytes);
    if (hash !== entry.hash) {
      // 磁盘内容已变：只同步内存缓存（后续三方合并要以最新磁盘内容为基）。
      // external 事件统一由 watcher → refresh 链广播（契约 D6：read 不做写入，
      // 也不充当第二事件源）；rev 仍对齐磁盘，保证返回的 DocMeta.rev 可用作 base（D5）。
      entry.rev += 1;
      entry.hash = hash;
      entry.text = text;
    }
    return snapshotOf(entry);
  };

  return {
    read,

    refresh,

    readByPath: async (path) => {
      await ensureScanned();
      const id = byPath.get(String(path));
      if (id === undefined) return null;
      return read(id);
    },

    list: async (filter) => {
      await ensureScanned();
      const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
      const prefix = filter?.pathPrefix === undefined ? null : String(filter.pathPrefix);
      const tags = filter?.tags ?? [];
      const result: DocMeta[] = [];
      for (const entry of entries.values()) {
        if (result.length >= limit) break;
        if (prefix !== null && !String(entry.path).startsWith(prefix)) continue;
        const meta = metaOf(entry);
        if (tags.length > 0 && !tags.every((tag) => meta.tags.includes(tag))) continue;
        result.push(meta);
      }
      return result.sort((left, right) => String(left.path).localeCompare(String(right.path)));
    },

    create: async (input) => {
      assertWritable();
      await ensureScanned();
      if (byPath.has(String(input.path)) || (await readBytes(input.path)) !== null) {
        throw new EmberError('path_exists', `路径已存在：${String(input.path)}`);
      }
      const idValue = input.id === undefined ? createUlid(now().getTime()) : String(input.id);
      const id = asDocId(idValue);
      if (id === null) throw new EmberError('doc_not_found', `非法 id：${idValue}`);
      if (entries.has(String(id))) throw new EmberError('duplicate_id', `id 已存在：${idValue}`);

      const stamp = utcNow(now());
      const frontmatter: Frontmatter = {
        id: idValue,
        title: input.title ?? paths.stem(input.path),
        summary: input.summary ?? null,
        tags: input.tags ?? [],
        aliases: input.aliases ?? [],
        created: stamp,
        updated: stamp,
        ember: {},
        extra: {},
      };
      const text = composeDocText(frontmatter, input.text);
      const bytes = encoder.encode(text);
      await track(port.write(input.path, bytes, input.intent));
      const hash = await hashBytes(bytes);
      const entry: CatalogEntry = { id, path: input.path, rev: 1, hash, text };
      entries.set(String(id), entry);
      byPath.set(String(input.path), id);
      emitChange({ id, path: input.path, kind: 'created', revision: { rev: 1, hash } });
      return snapshotOf(entry);
    },

    update: async (id, patch, opts) => {
      assertWritable();
      await ensureScanned();
      const entry = requireEntry(id);
      const bytes = await readBytes(entry.path);
      if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
      const diskText = decoder.decode(bytes);
      const diskHash = await hashBytes(bytes);
      const parsed = parseDocText(diskText);
      const nextFrontmatter: Frontmatter = {
        ...withFrontmatterPatch(parsed.frontmatter, patch),
        updated: utcNow(now()),
      };
      const localComposed = composeDocText(nextFrontmatter, patch.body ?? parsed.body);

      if (opts.base.hash === diskHash) {
        const committed = await track(commit(entry, localComposed, opts.intent));
        const snapshot = snapshotOf(committed);
        emitChange({ id, path: entry.path, kind: 'updated', revision: snapshot.meta.rev });
        return { snapshot, merged: true, conflict: null };
      }

      if (opts.base.hash === entry.hash && entry.text !== diskText) {
        const merged = merge3(entry.text, localComposed, diskText, {
          local: 'local (Ember)',
          disk: 'disk (mtime)',
        });
        if (merged.kind === 'clean') {
          const committed = await track(commit(entry, merged.lines.join('\n'), opts.intent));
          const snapshot = snapshotOf(committed);
          emitChange({ id, path: entry.path, kind: 'updated', revision: snapshot.meta.rev });
          return { snapshot, merged: true, conflict: null };
        }
      }

      const copy = await track(conflictCopy(entry, localComposed, opts.intent));
      if (diskHash !== entry.hash) {
        entry.rev += 1;
        entry.hash = diskHash;
        entry.text = diskText;
      }
      log.warn('三方合并未能自动解决，保留磁盘版本并落盘冲突副本', {
        id: String(id),
        baseRev: opts.base.rev,
      });
      return { snapshot: snapshotOf(entry), merged: false, conflict: copy };
    },

    rename: async (id, next, opts) => {
      assertWritable();
      await ensureScanned();
      const entry = requireEntry(id);
      if (String(entry.path) === String(next)) return { snapshot: snapshotOf(entry), merged: true, conflict: null };
      if (byPath.has(String(next)) || (await readBytes(next)) !== null) {
        throw new EmberError('path_exists', `目标路径已存在：${String(next)}`);
      }
      const bytes = await readBytes(entry.path);
      if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
      const hash = await hashBytes(bytes);
      if (opts.base.hash !== hash) {
        throw new EmberError('stale_revision', '重命名前修订已过期，请先重新读取', { id: String(id) });
      }
      await track(port.rename(entry.path, next));
      byPath.delete(String(entry.path));
      entry.path = next;
      byPath.set(String(next), id);
      emitChange({ id, path: next, kind: 'renamed', revision: { rev: entry.rev, hash: entry.hash } });
      return { snapshot: snapshotOf(entry), merged: true, conflict: null };
    },

    remove: async (id, opts) => {
      assertWritable();
      await ensureScanned();
      const entry = requireEntry(id);
      const bytes = await readBytes(entry.path);
      if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
      const hash = await hashBytes(bytes);
      if (opts.base.hash !== hash) {
        throw new EmberError('stale_revision', '删除前修订已过期，请先重新读取', { id: String(id) });
      }
      const trashDir = paths.normalize(`.workbench/trash/${createUlid(now().getTime())}`);
      const trashPath = paths.join(trashDir, paths.basename(entry.path));
      // 软删除副本重写为新 id：trash 目录虽被扫描排除，但一旦副本被移出 .workbench/
      // （或排除规则将来变化），同 id 副本会污染目录——防御纵深，代价是一次往返序列化
      const trashParsed = parseDocText(decoder.decode(bytes));
      const trashFrontmatter: Frontmatter = {
        ...trashParsed.frontmatter,
        id: createUlid(now().getTime()),
      };
      const trashBytes = encoder.encode(composeDocText(trashFrontmatter, trashParsed.body));
      await track(
        (async (): Promise<void> => {
          await port.write(trashPath, trashBytes, opts.intent);
          await port.remove(entry.path);
        })(),
      );
      entries.delete(String(id));
      byPath.delete(String(entry.path));
      emitChange({ id, path: entry.path, kind: 'removed', revision: { rev: entry.rev + 1, hash } });
    },

    flush: async () => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },

    watch: (listener) => {
      listeners.add(listener);
      return {
        dispose: (): void => {
          listeners.delete(listener);
        },
      };
    },
  };
};
