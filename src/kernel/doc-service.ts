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
  /** 用户删除：移入系统回收站，库内不保留副本 */
  remove(id: DocId, opts: WriteOptions): Promise<void>;
  /**
   * 永久删除：**仅供内核回滚内部使用**（文章创建后画布写入失败）。
   * 不是用户删除入口，也不注册为命令——`core.doc.purge` 在契约里仍是「v1 未实现」。
   */
  purge(id: DocId, opts: WriteOptions): Promise<void>;

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

/** 上一成功提交前的内容快照：只给同 id 排队写入做三方合并，队列排空即清空 */
interface CommittedSnapshot {
  readonly hash: ContentHash;
  readonly text: string;
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

  /**
   * per-docId 串行链：读盘 → base 校验 → 合并 → 写盘 → 目录更新必须整体入队，
   * 否则两个写入者可以都通过 base 校验、先后各写一次（丢更新）。
   */
  const queues = new Map<string, Promise<void>>();
  /** 队列非空期间的上一版快照，供「两个排队写入都基于上一版」时三方合并 */
  const previousCommitted = new Map<string, CommittedSnapshot>();
  /** 每个 id 的目录变更代数：refresh/read 读盘期间若被写操作推进，就放弃回写，避免旧内容覆盖新内容 */
  const versions = new Map<string, number>();
  let refreshInFlight: Promise<void> | null = null;

  const isBusy = (id: DocId): boolean => queues.has(String(id));

  const bumpVersion = (key: string): void => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
  };

  const enqueue = <T>(key: string, unit: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(unit);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, tail);
    void tail.finally(() => {
      // 只有当前 tail 仍是队尾时才清理，避免把后入队的工作误删
      if (queues.get(key) === tail) {
        queues.delete(key);
        previousCommitted.delete(key);
      }
    });
    return run;
  };

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

  const runRefresh = async (): Promise<void> => {
    const pathsInVault = await port.list();
    const present = new Set(pathsInVault.map((item) => String(item)));
    const seen = new Set<string>();
    const duplicateIds = new Set<string>();
    // 读盘期间可能有队列写入完成：用代数快照判断 apply 时条目是否已被推进
    const versionSnapshot = new Map(versions);

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
      if (isBusy(id)) {
        // 该 id 有排队中的写操作：本次扫描读到的可能是写前内容，不能回写目录/广播事件。
        // 标记 seen 防止下面的清理误删；写完成后条目由队列自身更新。
        seen.add(String(id));
        continue;
      }
      const hash = await hashBytes(bytes);
      if (isBusy(id)) {
        // hash 计算期间可能刚好有写入入队：apply 前再确认一次，避免覆盖队列的更新
        seen.add(String(id));
        continue;
      }
      if ((versions.get(String(id)) ?? 0) !== (versionSnapshot.get(String(id)) ?? 0)) {
        // 读盘/hash 期间该条目已被队列写入推进：本次扫描结果已过期，不能回写
        seen.add(String(id));
        continue;
      }
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
        bumpVersion(String(id));
        // 本次扫描自身的推进不算「读盘期间被写入推进」：同步局部快照，避免同 id 的后续路径被误判
        versionSnapshot.set(String(id), versions.get(String(id)) ?? 0);
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
      bumpVersion(String(id));
      versionSnapshot.set(String(id), versions.get(String(id)) ?? 0);
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
      // busy id 的路径迁移/删除由队列自身完成，refresh 不能抢先删条目
      if (queues.has(key)) continue;
      entries.delete(key);
      versions.delete(key);
      byPath.delete(String(entry.path));
      emitChange({ id: entry.id, path: entry.path, kind: 'removed', revision: { rev: entry.rev, hash: entry.hash } });
    }
    scanned = true;
    if (duplicateIds.size > 0) log.warn('检测到重复 id', { ids: [...duplicateIds] });
  };

  const refresh = async (): Promise<void> => {
    // 单飞：ensureScanned 与 watcher 对账可能同时触发，双扫描会互相覆盖目录
    if (refreshInFlight === null) {
      refreshInFlight = runRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    await refreshInFlight;
  };

  const ensureScanned = async (): Promise<void> => {
    if (!scanned) await refresh();
  };

  const commit = async (entry: CatalogEntry, text: string, intent: WriteOptions['intent']): Promise<CatalogEntry> => {
    const bytes = encoder.encode(text);
    await port.write(entry.path, bytes, intent);
    const hash = await hashBytes(bytes);
    // 入队时捕获的 entry 可能已被 refresh 替换：更新 map 中的当前对象，避免改到脱管副本
    const current = entries.get(String(entry.id)) ?? entry;
    // 记录写前快照：排队中的下一个写入者若仍以它为 base，可做三方合并而不是丢更新
    previousCommitted.set(String(entry.id), { hash: current.hash, text: current.text });
    current.text = text;
    current.hash = hash;
    current.rev += 1;
    bumpVersion(String(entry.id));
    return current;
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
    const key = String(entry.id);
    const versionAtRead = versions.get(key) ?? 0;
    const bytes = await readBytes(entry.path);
    if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
    const text = decoder.decode(bytes);
    const hash = await hashBytes(bytes);
    if (hash !== entry.hash) {
      if (isBusy(entry.id)) {
        // 队列正在写同一 id：不能回写共享 entry（可能把队列刚推进的 rev/hash 打回旧值）。
        // 仅用刚读到的字节构造一次性快照返回；缓存交给队列在写完后更新。
        const view: CatalogEntry = { id: entry.id, path: entry.path, rev: entry.rev, hash, text };
        return snapshotOf(view);
      }
      if ((versions.get(key) ?? 0) !== versionAtRead) {
        // 读盘期间条目已被写操作推进：丢弃这份可能过期的读结果，返回当前缓存
        return snapshotOf(entry);
      }
      // 磁盘内容已变：只同步内存缓存（后续三方合并要以最新磁盘内容为基）。
      // external 事件统一由 watcher → refresh 链广播（契约 D6：read 不做写入，
      // 也不充当第二事件源）；rev 仍对齐磁盘，保证返回的 DocMeta.rev 可用作 base（D5）。
      entry.rev += 1;
      entry.hash = hash;
      entry.text = text;
      bumpVersion(key);
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
      bumpVersion(String(id));
      emitChange({ id, path: input.path, kind: 'created', revision: { rev: 1, hash } });
      return snapshotOf(entry);
    },

    update: async (id, patch, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
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
          const committed = await commit(entry, localComposed, opts.intent);
          const snapshot = snapshotOf(committed);
          emitChange({ id, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });
          return { snapshot, merged: true, conflict: null };
        }

        const previous = previousCommitted.get(String(id));
        const mergeBase =
          opts.base.hash === entry.hash && entry.text !== diskText
            ? entry.text
            : previous !== undefined && previous.hash === opts.base.hash
              ? previous.text
              : null;
        if (mergeBase !== null) {
          const merged = merge3(mergeBase, localComposed, diskText, {
            local: 'local (Ember)',
            disk: 'disk (mtime)',
          });
          if (merged.kind === 'clean') {
            const committed = await commit(entry, merged.lines.join('\n'), opts.intent);
            const snapshot = snapshotOf(committed);
            emitChange({ id, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });
            return { snapshot, merged: true, conflict: null };
          }
        }

        const copy = await conflictCopy(entry, localComposed, opts.intent);
        // 队列内不会再有同 id 写入交错，这里同步的是只在本次 read 之后发生的外部变化
        if (diskHash !== entry.hash) {
          entry.rev += 1;
          entry.hash = diskHash;
          entry.text = diskText;
          bumpVersion(String(id));
        }
        log.warn('三方合并未能自动解决，保留磁盘版本并落盘冲突副本', {
          id: String(id),
          baseRev: opts.base.rev,
        });
        return { snapshot: snapshotOf(entry), merged: false, conflict: copy };
      });
    },

    rename: async (id, next, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
        const entry = requireEntry(id);
        if (String(entry.path) === String(next)) return { snapshot: snapshotOf(entry), merged: true, conflict: null };
        if (byPath.has(String(next)) || (await readBytes(next)) !== null) {
          throw new EmberError('path_exists', `目标路径已存在：${String(next)}`);
        }
        const bytes = await readBytes(entry.path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
        const hash = await hashBytes(bytes);
        if (opts.base.hash !== hash) {
          throw new EmberError('stale_revision', '重命名前修订已过期（可能已有新写入），请重新读取后再改名', {
            id: String(id),
          });
        }
        await port.rename(entry.path, next);
        byPath.delete(String(entry.path));
        entry.path = next;
        byPath.set(String(next), id);
        bumpVersion(String(id));
        emitChange({ id, path: next, kind: 'renamed', revision: { rev: entry.rev, hash: entry.hash } });
        return { snapshot: snapshotOf(entry), merged: true, conflict: null };
      });
    },

    remove: async (id, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
        const entry = requireEntry(id);
        const bytes = await readBytes(entry.path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
        const hash = await hashBytes(bytes);
        if (opts.base.hash !== hash) {
          throw new EmberError('stale_revision', '删除前修订已过期（可能已有新写入），请重新读取后再删除', {
            id: String(id),
          });
        }
        try {
          await port.remove(entry.path);
        } catch (error) {
          if (error instanceof EmberError) throw error;
          throw new EmberError('io_failed', '删除失败，文档保持原样（文件未被移入回收站）', {
            id: String(id),
            path: String(entry.path),
          });
        }
        entries.delete(String(id));
        versions.delete(String(id));
        byPath.delete(String(entry.path));
        emitChange({ id, path: entry.path, kind: 'removed', revision: { rev: entry.rev + 1, hash } });
      });
    },

    purge: async (id, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
        const entry = requireEntry(id);
        const bytes = await readBytes(entry.path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
        const hash = await hashBytes(bytes);
        if (opts.base.hash !== hash) {
          throw new EmberError('stale_revision', '回滚前修订已过期，请重新读取后再处理', {
            id: String(id),
          });
        }
        try {
          await port.purge(entry.path);
        } catch (error) {
          if (error instanceof EmberError) throw error;
          throw new EmberError('io_failed', '回滚删除失败，文件仍在磁盘', {
            id: String(id),
            path: String(entry.path),
          });
        }
        entries.delete(String(id));
        versions.delete(String(id));
        byPath.delete(String(entry.path));
        emitChange({ id, path: entry.path, kind: 'removed', revision: { rev: entry.rev + 1, hash } });
      });
    },

    flush: async () => {
      // 队列单元覆盖读-改-写全过程；pending 只承载 create 这类非队列写入。
      // 循环重检：await 期间可能又有新单元入队；不 reject（失败由各调用方处理）。
      let rounds = 0;
      while (queues.size > 0 || pending.size > 0) {
        rounds += 1;
        if (rounds === 50) log.warn('flush 等待写入排空超过 50 轮，可能有写入者持续入队');
        await Promise.allSettled([...queues.values(), ...pending]);
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
