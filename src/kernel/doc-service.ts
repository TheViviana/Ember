import {
  createUlid,
  deriveSummary,
  isUlid,
  joinFrontmatter,
  toSerializable,
  asDocId,
  type ContentHash,
  type DocId,
  type Frontmatter,
  type VaultPath,
} from '#doc-model';
import { stringify as stringifyYaml } from 'yaml';
import {
  canonicalText,
  hashBytes,
  isUtf8,
  parseDocText,
  patchFrontmatterRegion,
  replaceBodyRegion,
} from './doc-text.ts';
import type { EventBus } from './events.ts';
import { EmberError } from './errors.ts';
import { createHistoryStore } from './history-store.ts';
import type { PathTools } from './paths.ts';
import type {
  TrashDestination,
  VaultPort,
  VaultFileChange,
  VaultFileEvent,
  VaultStatePort,
} from './ports.ts';
import type {
  AdoptConflictOptions,
  AdoptConflictResult,
  ConflictCopy,
  CreateDocInput,
  Disposable,
  DocChange,
  DocFilter,
  DocHistoryEntry,
  DocHistoryPreview,
  DocMeta,
  DocPatch,
  DocSnapshot,
  Logger,
  VaultGuardState,
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
  /** 用户删除：只移入系统回收站（Finder 代删落点相同），不可用即失败；返回实际落点 */
  remove(id: DocId, opts: WriteOptions): Promise<TrashDestination | null>;

  /** 列出该文档历史版本（新→旧）；索引缺失/损坏返回空数组并告警，不抛错 */
  listHistory(id: DocId): Promise<readonly DocHistoryEntry[]>;
  /** 只读预览；版本不存在抛 doc_not_found，索引哈希不符/非 UTF-8 抛 invalid_payload；不写盘 */
  readHistory(id: DocId, versionId: string): Promise<DocHistoryPreview>;
  /** 恢复：校验当前 base.hash；一致则当前版入历史后提交目标版，失配落冲突副本 */
  restoreHistory(id: DocId, versionId: string, opts: WriteOptions): Promise<WriteOutcome>;

  /**
   * 采用副本：正文与 title/summary/tags/aliases 写回原文（保留原 created），
   * 成功后把副本移入系统回收站；两步非事务，删除失败返回 copyRemoved: false。
   */
  adoptCopy(copyId: DocId, opts: AdoptConflictOptions): Promise<AdoptConflictResult>;
  /** 另存为普通文档：清除副本的 ember.conflictOf，不改路径 / 正文 */
  detachCopy(copyId: DocId, opts: WriteOptions): Promise<DocSnapshot>;

  flush(): Promise<void>;
  watch(listener: (change: DocChange) => void): Disposable;

  /** 库守护熔断状态；触发后非 null，此时全部写入被拒，直到 rescan 或重启 */
  guard(): VaultGuardState | null;
  /** 用户确认库未被整体替换：清空目录并按磁盘重建，同时解除熔断只读 */
  rescan(): Promise<void>;
}

/** 内核内部扩展：watcher 触发目录对账、文章回滚用，不暴露给能力（G1） */
export interface DocServiceInternal extends DocService {
  /** 全量对账：文件 → 目录；文档身份即规范化相对路径 */
  refresh(): Promise<void>;
  /**
   * 增量对账：按 watcher 事件只重读发生变化的文件；`removed` 用路径反查 id 直接摘除。
   * `overflow` 事件应交给 `refresh()`（由 boot 统一分流）。
   */
  applyFileEvents(events: readonly VaultFileEvent[]): Promise<void>;
  /**
   * 永久删除：**仅供内核回滚内部使用**（文章创建后画布写入失败），不是用户删除入口；
   * 不注册为命令——`core.doc.purge` 在契约里仍是「v1 未实现」。
   */
  purge(id: DocId, opts: WriteOptions): Promise<void>;
  /** 注册改名后的外部引用同步（画布节点）；传 null 解除 */
  setRenameHook(hook: ((from: DocId, to: DocId) => Promise<void>) | null): void;
  /**
   * 旧 ULID → 当前路径（可能多对一，交给迁移层按「唯一候选」裁决）。
   * 只读已扫描的目录，不写盘；迁移快照与回滚都需要这份索引。
   */
  legacyIds(): Promise<ReadonlyMap<string, readonly VaultPath[]>>;
}

interface CatalogEntry {
  readonly id: DocId;
  path: VaultPath;
  rev: number;
  hash: ContentHash;
  /** 完整文件文本，canonical（LF、无 BOM）：编辑器正文用它 */
  text: string;
  /** 磁盘上的字节风格，写回时原样恢复；create/refresh 从真实文件探测 */
  style: FileStyle;
  /** 严格 UTF-8 解码是否成功；false 时拒绝一切会重编码的写入 */
  utf8Valid: boolean;
  /** watcher 事件携带的元数据：与事件一致时增量对账可跳过读盘 */
  mtimeMs: number | null;
  size: number | null;
  /** 严格重绑的第二信号：外部改名后 inode 不变，可证明还是同一个文件 */
  dev: number | null;
  ino: number | null;
}

export interface DocServiceOptions {
  readonly port: VaultPort;
  /** 库外状态（历史日志）；迁移快照也走它，库里不再有 `.workbench/history/documents` */
  readonly state: VaultStatePort;
  readonly paths: PathTools;
  readonly events: EventBus;
  readonly log: Logger;
  readonly now?: () => Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * 库守护熔断阈值（保守默认值）：
 * - 消失数低于 5 篇从不熔断：小库或正常整理时删几篇很常见；
 * - 消失占比 ≥ 50%（且至少 5 篇）：整库被替换/移走最典型的表现；
 * - 绝对数 ≥ 200 篇：超大库即使占比不到一半，一次消失这么多也远超正常操作。
 * 两者取「或」：任一成立即停止清理并进入只读，宁可让用户多点一次「重新扫描」，
 * 也不把目录里剩下的文档记录当成已删除清掉。
 */
const GUARD_MIN_MISSING_DOCS = 5;
const GUARD_MISSING_RATIO = 0.5;
const GUARD_MISSING_ABSOLUTE = 200;

const shouldGuard = (missing: number, known: number): boolean => {
  if (missing < GUARD_MIN_MISSING_DOCS) return false;
  if (missing >= GUARD_MISSING_ABSOLUTE) return true;
  return known > 0 && missing / known >= GUARD_MISSING_RATIO;
};

/**
 * 磁盘文件的字节风格。目录里的 `text` 一律是 canonical（LF、无 BOM），
 * 落盘时再按这里记录的风格还原，避免保存时静默改掉 BOM 或整篇行尾。
 */
interface FileStyle {
  readonly bom: boolean;
  readonly eol: 'lf' | 'crlf' | 'mixed';
}

const detectEol = (text: string): FileStyle['eol'] => {
  const crlf = text.split('\r\n').length - 1;
  const bareLf = text.split('\n').length - 1 - crlf;
  // 混合行尾无法从单一正文反推逐行风格：按已知限制统一写回 LF
  return crlf === 0 ? 'lf' : bareLf === 0 ? 'crlf' : 'mixed';
};

/** TextDecoder 默认会吞掉 BOM，因此 BOM 必须看原始字节，不能看解码后的字符串 */
const hasUtf8Bom = (bytes: Uint8Array): boolean =>
  bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;

/** 从磁盘字节探测风格（bytes 判 BOM，text 判行尾） */
const detectStyle = (bytes: Uint8Array, text: string): FileStyle => ({
  bom: hasUtf8Bom(bytes),
  eol: detectEol(text),
});

/** 字符串来源（create/导入）没有原始字节，只能从文本判断 BOM 与行尾 */
const detectTextStyle = (text: string): FileStyle => ({
  bom: text.startsWith('\uFEFF'),
  eol: detectEol(text),
});

/**
 * canonical → 落盘字节前的还原。`\r\n → \n` 先归一，再整篇换行，
 * 避免正文里残留的孤立 `\r` 被二次转义成 `\r\r\n`。
 */
const applyStyle = (text: string, style: FileStyle): string => {
  const canonical = canonicalText(text);
  const styled = style.eol === 'crlf' ? canonical.replace(/\n/g, '\r\n') : canonical;
  return style.bom ? `\uFEFF${styled}` : styled;
};

const composeDocText = (frontmatter: Frontmatter, body: string): string => {
  const serializable = toSerializable(frontmatter);
  if (Object.keys(serializable).length === 0) return body;
  return joinFrontmatter(stringifyYaml(serializable, { lineWidth: 0 }).replace(/\n$/, ''), body);
};

/** 目录对账：身份即规范化相对路径，所有合法 `.md` 直接收录（vault-format §3.1） */
export const createDocService = (options: DocServiceOptions): DocServiceInternal => {
  const { port, paths, events, log } = options;
  const now = options.now ?? ((): Date => new Date());
  // 历史日志在库外（D4）：库可能位于 iCloud，写进 `.workbench` 会跟着同步。
  const history = createHistoryStore({ state: options.state, log, now });

  const entries = new Map<string, CatalogEntry>();
  /** 改名后同步外部引用（画布节点）；boot 在画布服务就绪后注册 */
  let renameHook: ((from: DocId, to: DocId) => Promise<void>) | null = null;
  const listeners = new Set<(change: DocChange) => void>();
  const pending = new Set<Promise<unknown>>();
  let scanned = false;
  /** 库守护熔断状态；非 null 时拒绝一切写入，直到用户 rescan */
  let guard: VaultGuardState | null = null;

  /**
   * per-docId 串行链：读盘 → base 校验 → 写盘 → 目录更新必须整体入队，
   * 否则两个写入者可以都通过 base 校验、先后各写一次（丢更新）。
   */
  const queues = new Map<string, Promise<void>>();
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
    if (guard !== null) {
      throw new EmberError(
        'vault_locked',
        '这个库看起来被整体替换或移走了，已进入只读；请重新扫描或退出',
        { reason: 'vaultGuard' },
      );
    }
    if (port.readonlyMode) {
      throw new EmberError('vault_locked', '库为只读，写操作被拒绝（原因见状态栏）', {
        reason: port.readonlyReason,
      });
    }
  };

  /** 冲突副本归属：值是原文的库内相对路径；非法值按普通文档处理 */
  const conflictOfOf = (frontmatter: Frontmatter): DocId | null => {
    const raw = frontmatter.ember['conflictOf'];
    return typeof raw === 'string' ? asDocId(raw) : null;
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
      conflictOf: conflictOfOf(parsed.frontmatter),
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

  /**
   * 内容提交前记录旧版：先写版本原始字节，再原子重写日志，最后尽力清理被淘汰的文件。
   * 任一步失败都不会提交主文（调用方在写入正文前 await 它）。
   */
  const recordHistory = (id: DocId, docPath: VaultPath, bytes: Uint8Array): Promise<void> =>
    history.record(id, docPath, bytes);

  const listHistory = async (id: DocId): Promise<readonly DocHistoryEntry[]> => history.list(id);

  const readHistory = async (id: DocId, versionId: string): Promise<DocHistoryPreview> => {
    if (!isUlid(versionId)) {
      throw new EmberError('invalid_payload', `历史版本 id 非法：${versionId}`, { id: String(id) });
    }
    const found = await history.read(id, versionId);
    if (found === null) {
      throw new EmberError('doc_not_found', `历史版本不存在：${versionId}`, { id: String(id) });
    }
    if (!isUtf8(found.bytes)) {
      throw new EmberError('invalid_payload', '历史版本不是合法 UTF-8，无法预览', {
        id: String(id),
        versionId,
      });
    }
    const hash = await hashBytes(found.bytes);
    if (hash !== found.entry.hash) {
      throw new EmberError('invalid_payload', '历史版本内容与日志不一致', { id: String(id), versionId });
    }
    return { entry: found.entry, text: canonicalText(decoder.decode(found.bytes)) };
  };

  const runRefresh = async (): Promise<void> => {
    const pathsInVault = await port.list();
    // 仅在目录已建立后广播进度：启动首次扫描是必经步骤，不必打扰用户
    const announce = scanned && pathsInVault.length > 0;
    if (announce) events.emit('vault:sync', { total: pathsInVault.length, active: true });
    try {
      await applyScan(pathsInVault);
    } finally {
      if (announce) events.emit('vault:sync', { total: pathsInVault.length, active: false });
    }
  };

  const applyScan = async (pathsInVault: readonly VaultPath[]): Promise<void> => {
    const seen = new Set<string>();
    // 读盘期间可能有队列写入完成：用代数快照判断 apply 时条目是否已被推进
    const versionSnapshot = new Map(versions);

    for (const path of pathsInVault) {
      if (paths.ext(path).toLowerCase() !== '.md') continue;
      const id = asDocId(String(path));
      if (id === null) continue;
      const key = String(id);
      if (isBusy(id)) {
        // 该 id 有排队中的写操作：本次扫描读到的可能是写前内容，不能回写目录/广播事件。
        // 标记 seen 防止下面的清理误删；写完成后条目由队列自身更新。
        seen.add(key);
        continue;
      }
      const bytes = await readBytes(path);
      if (bytes === null) continue;
      // inode 只在扫描时缓存一次：外部改名发生后旧路径已消失，必须提前留下第二信号
      const stat = await port.stat(path);
      const rawText = decoder.decode(bytes);
      const parsed = parseDocText(rawText);
      if (parsed.issues.length > 0) {
        log.warn('frontmatter 含取值非法的键，原值已保留、修正前不参与语义', {
          path: String(path),
          keys: parsed.issues.map((issue) => issue.key),
        });
      }
      const hash = await hashBytes(bytes);
      if (isBusy(id)) {
        // hash 计算期间可能刚好有写入入队：apply 前再确认一次，避免覆盖队列的更新
        seen.add(key);
        continue;
      }
      if ((versions.get(key) ?? 0) !== (versionSnapshot.get(key) ?? 0)) {
        // 读盘/hash 期间该条目已被队列写入推进：本次扫描结果已过期，不能回写
        seen.add(key);
        continue;
      }
      const existing = entries.get(key);
      const rev = existing === undefined ? 1 : existing.hash === hash ? existing.rev : existing.rev + 1;
      entries.set(key, {
        id,
        path,
        rev,
        hash,
        text: canonicalText(rawText),
        style: detectStyle(bytes, rawText),
        utf8Valid: isUtf8(bytes),
        mtimeMs: null,
        size: null,
        dev: stat?.dev ?? null,
        ino: stat?.ino ?? null,
      });
      bumpVersion(key);
      versionSnapshot.set(key, versions.get(key) ?? 0);
      seen.add(key);
      // 目录对账发现外部改动时广播，编辑器据此自动重载或提示合并
      if (existing === undefined) {
        // 初次扫描不算"新增"，避免启动时把整个库广播成 created
        if (scanned) emitChange({ id, path, kind: 'created', revision: { rev: 1, hash } });
      } else if (existing.hash !== hash) {
        emitChange({ id, path, kind: 'external', revision: { rev, hash } });
      }
    }

    // 库守护：大量文档同时消失时先不动目录（可能是整库被替换/移走），
    // 否则这里会把本应保留的文档记录全部清掉，用户再换回原路径也找不回。
    const missing = [...entries].filter(
      ([key]) => !seen.has(key) && !queues.has(key),
    );
    if (shouldGuard(missing.length, entries.size)) {
      if (guard === null) {
        guard = {
          known: entries.size,
          missing: missing.length,
          ratio: entries.size === 0 ? 0 : missing.length / entries.size,
        };
        port.setRuntimeReadonly?.('vaultGuard');
        events.emit('vault:guarded', guard);
        log.error('单次对账中有大量文档消失，已停止目录清理并进入只读', {
          known: guard.known,
          missing: guard.missing,
          ratio: guard.ratio,
        });
      }
      scanned = true;
      return;
    }

    for (const [key, entry] of [...entries]) {
      if (seen.has(key)) continue;
      // busy id 的路径迁移/删除由队列自身完成，refresh 不能抢先删条目
      if (queues.has(key)) continue;
      entries.delete(key);
      versions.delete(key);
      emitChange({ id: entry.id, path: entry.path, kind: 'removed', revision: { rev: entry.rev, hash: entry.hash } });
    }
    scanned = true;
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

  /**
   * 单文件增量：只读事件指向的文件，不再全库 list + 逐文件读全文。
   * 事件自带 mtime/size，与目录里的元数据一致时连这一次读盘也省掉。
   */
  const applyFileChange = async (event: VaultFileChange): Promise<void> => {
    if (
      event.kind === 'renamed' &&
      event.from !== undefined &&
      String(event.from) !== String(event.path)
    ) {
      const fromId = asDocId(String(event.from));
      const toId = asDocId(String(event.path));
      const fromKey = fromId === null ? null : String(fromId);
      const toKey = toId === null ? null : String(toId);
      const fromEntry = fromKey === null ? undefined : entries.get(fromKey);
      // 严格重绑：唯一候选（目标名未被占用、两端都不忙）+ 第二信号（inode 或 sha256）。
      // 名字仍冲突（目标路径已有文档）时拒绝重绑，退回「删除 + 新建」，绝不猜。
      if (
        fromId !== null &&
        toId !== null &&
        fromKey !== null &&
        toKey !== null &&
        fromEntry !== undefined &&
        !entries.has(toKey) &&
        !isBusy(fromId) &&
        !isBusy(toId) &&
        !queues.has(fromKey) &&
        !queues.has(toKey)
      ) {
        const bytes = await readBytes(event.path);
        if (bytes !== null) {
          const hash = await hashBytes(bytes);
          const stat = await port.stat(event.path);
          const sameContent = hash === fromEntry.hash;
          const sameInode =
            fromEntry.dev !== null &&
            fromEntry.ino !== null &&
            stat !== null &&
            stat.dev === fromEntry.dev &&
            stat.ino === fromEntry.ino;
          if (sameContent || sameInode) {
            const rawText = decoder.decode(bytes);
            entries.delete(fromKey);
            versions.delete(fromKey);
            const moved: CatalogEntry = {
              ...fromEntry,
              id: toId,
              path: event.path,
              hash,
              text: canonicalText(rawText),
              style: detectStyle(bytes, rawText),
              utf8Valid: isUtf8(bytes),
              mtimeMs: event.mtimeMs ?? fromEntry.mtimeMs,
              size: event.size ?? fromEntry.size,
              dev: stat?.dev ?? null,
              ino: stat?.ino ?? null,
            };
            entries.set(toKey, moved);
            bumpVersion(fromKey);
            bumpVersion(toKey);
            await history.retag(fromId, toId).catch((error: unknown) => {
              log.warn('外部改名后迁移历史日志失败', {
                from: String(fromId),
                to: String(toId),
                error: String(error),
              });
            });
            if (renameHook !== null) {
              await renameHook(fromId, toId).catch((error: unknown) => {
                log.warn('外部改名后同步画布引用失败', {
                  from: String(fromId),
                  to: String(toId),
                  error: String(error),
                });
              });
            }
            emitChange({
              id: toId,
              from: fromId,
              path: event.path,
              kind: 'renamed',
              revision: { rev: moved.rev, hash },
            });
            return;
          }
        }
      }
      // 没有第二信号/目标名冲突：身份即路径，改名就是换身份
      await applyFileChange({ kind: 'removed', path: event.from });
    }

    const id = asDocId(String(event.path));
    if (id === null) return;
    const key = String(id);

    if (event.kind === 'removed') {
      // 队列正在处理该 id：删除/改名由队列自身完成，增量对账不能抢先摘除
      if (isBusy(id) || queues.has(key)) return;
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      versions.delete(key);
      emitChange({
        id,
        path: entry.path,
        kind: 'removed',
        revision: { rev: entry.rev + 1, hash: entry.hash },
      });
      return;
    }

    const existing = entries.get(key);
    if (existing !== undefined) {
      if (isBusy(id) || queues.has(key)) return;
      if (
        event.mtimeMs !== undefined &&
        event.size !== undefined &&
        existing.mtimeMs === event.mtimeMs &&
        existing.size === event.size
      ) {
        return;
      }
    }

    const bytes = await readBytes(event.path);
    if (bytes === null) return;
    const stat = await port.stat(event.path);
    const rawText = decoder.decode(bytes);
    const hash = await hashBytes(bytes);
    // 读盘/hash 期间可能刚好有写入入队：apply 前再确认一次
    if (isBusy(id) || queues.has(key)) return;

    const text = canonicalText(rawText);
    const style = detectStyle(bytes, rawText);
    const utf8Valid = isUtf8(bytes);

    if (existing !== undefined) {
      const changed = existing.hash !== hash;
      existing.text = text;
      existing.style = style;
      existing.utf8Valid = utf8Valid;
      existing.mtimeMs = event.mtimeMs ?? null;
      existing.size = event.size ?? null;
      existing.dev = stat?.dev ?? existing.dev;
      existing.ino = stat?.ino ?? existing.ino;
      if (!changed) return;
      existing.hash = hash;
      existing.rev += 1;
      bumpVersion(key);
      emitChange({ id, path: event.path, kind: 'external', revision: { rev: existing.rev, hash } });
      return;
    }

    entries.set(key, {
      id,
      path: event.path,
      rev: 1,
      hash,
      text,
      style,
      utf8Valid,
      mtimeMs: event.mtimeMs ?? null,
      size: event.size ?? null,
      dev: stat?.dev ?? null,
      ino: stat?.ino ?? null,
    });
    bumpVersion(key);
    if (scanned) emitChange({ id, path: event.path, kind: 'created', revision: { rev: 1, hash } });
  };

  const applyFileEvents = async (events: readonly VaultFileEvent[]): Promise<void> => {
    if (events.length === 0) return;
    await ensureScanned();
    // 溢出事件不在这里处理：调用方（boot）合并成一次 refresh()
    for (const event of events) {
      if (event.kind === 'overflow') continue;
      await applyFileChange(event);
    }
  };

  const rescan = async (): Promise<void> => {
    if (refreshInFlight !== null) await refreshInFlight;
    entries.clear();
    versions.clear();
    guard = null;
    port.setRuntimeReadonly?.(null);
    scanned = false;
    await refresh();
  };

  /** 原样写入已组装好的文件文本：字节即最终字节，不再做全局 canonical/行尾重排 */
  const commitRaw = async (
    entry: CatalogEntry,
    rawText: string,
    intent: WriteOptions['intent'],
  ): Promise<CatalogEntry> => {
    // TextDecoder 默认吞掉 BOM；落盘前按探测到的风格补回，保证 BOM 文件保存后仍带 BOM
    const withBom =
      entry.style.bom && !rawText.startsWith('\uFEFF') ? `\uFEFF${rawText}` : rawText;
    const bytes = encoder.encode(withBom);
    await port.write(entry.path, bytes, intent);
    // hash 必须按真实落盘字节算：base.hash 校验比较的是磁盘内容，
    // 换成 canonical 文本的 hash 会让并发写入的过期判定整体失真。
    const hash = await hashBytes(bytes);
    // 入队时捕获的 entry 可能已被 refresh 替换：更新 map 中的当前对象，避免改到脱管副本
    const current = entries.get(String(entry.id)) ?? entry;
    current.text = canonicalText(rawText);
    current.hash = hash;
    current.rev += 1;
    bumpVersion(String(entry.id));
    return current;
  };

  /** 整份重写：只在新建文件或显式元数据合并时使用，按文件既有风格还原 BOM 与行尾 */
  const commitWhole = async (
    entry: CatalogEntry,
    text: string,
    intent: WriteOptions['intent'],
  ): Promise<CatalogEntry> =>
    commitRaw(entry, applyStyle(canonicalText(text), entry.style), intent);

  const conflictCopy = async (
    entry: CatalogEntry,
    localText: string,
    intent: WriteOptions['intent'],
  ): Promise<ConflictCopy> => {
    if (!entry.utf8Valid) {
      // 副本会把原始字节重新编码：非 UTF-8 时同样拒绝，避免把损坏扩散到新文件
      throw new EmberError('invalid_payload', '文件不是合法 UTF-8，拒绝写入冲突副本', {
        path: String(entry.path),
      });
    }
    const parsed = parseDocText(localText);
    const copyPath = paths.conflictName(entry.path, now(), createUlid(now().getTime()).slice(-6));
    // 身份即路径：副本的 id 就是它自己的相对路径；frontmatter 不写 id
    const copyId = asDocId(String(copyPath));
    if (copyId === null) throw new EmberError('io_failed', '生成冲突副本路径失败');
    const frontmatter: Frontmatter = {
      ...parsed.frontmatter,
      id: null,
      ember: { ...parsed.frontmatter.ember, conflictOf: String(entry.id) },
    };
    await port.write(
      copyPath,
      encoder.encode(applyStyle(composeDocText(frontmatter, parsed.body), entry.style)),
      intent,
    );
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
    const rawText = decoder.decode(bytes);
    const text = canonicalText(rawText);
    const style = detectStyle(bytes, rawText);
    const utf8Valid = isUtf8(bytes);
    const hash = await hashBytes(bytes);
    if (hash !== entry.hash) {
      if (isBusy(entry.id)) {
        // 队列正在写同一 id：不能回写共享 entry（可能把队列刚推进的 rev/hash 打回旧值）。
        // 仅用刚读到的字节构造一次性快照返回；缓存交给队列在写完后更新。
        const view: CatalogEntry = {
          id: entry.id,
          path: entry.path,
          rev: entry.rev,
          hash,
          text,
          style,
          utf8Valid,
          mtimeMs: null,
          size: null,
          dev: entry.dev,
          ino: entry.ino,
        };
        return snapshotOf(view);
      }
      if ((versions.get(key) ?? 0) !== versionAtRead) {
        // 读盘期间条目已被写操作推进：丢弃这份可能过期的读结果，返回当前缓存
        return snapshotOf(entry);
      }
      // 磁盘内容已变：只同步内存缓存（保存的基线校验以最新磁盘内容为准）。
      // external 事件统一由 watcher → refresh 链广播（契约 D6：read 不做写入，
      // 也不充当第二事件源）；rev 仍对齐磁盘，保证返回的 DocMeta.rev 可用作 base（D5）。
      entry.rev += 1;
      entry.hash = hash;
      entry.text = text;
      entry.style = style;
      entry.utf8Valid = utf8Valid;
      entry.mtimeMs = null;
      entry.size = null;
      bumpVersion(key);
    }
    return snapshotOf(entry);
  };

  return {
    read,

    refresh,

    readByPath: async (path) => {
      await ensureScanned();
      const id = asDocId(String(path));
      if (id === null || entries.get(String(id)) === undefined) return null;
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
      const id = asDocId(String(input.path));
      if (id === null) {
        throw new EmberError('invalid_payload', `不是合法的文档路径：${String(input.path)}`);
      }
      if (entries.has(String(id)) || (await readBytes(input.path)) !== null) {
        throw new EmberError('path_exists', `路径已存在：${String(input.path)}`);
      }

      // 新文件由内核创建：只写用户显式提供的展示元数据。
      // 身份来自路径，因此不再写 id；也不写 created / updated（D8：不替用户发明字段）。
      const frontmatter: Frontmatter = {
        id: null,
        title: input.title ?? paths.stem(input.path),
        summary: input.summary ?? null,
        tags: input.tags ?? [],
        aliases: input.aliases ?? [],
        created: null,
        updated: null,
        ember: {},
        extra: {},
      };
      // 导入等外部来源可能自带 BOM/CRLF：新文件保留其行尾风格，frontmatter 跟着同一风格写
      const style = detectTextStyle(input.text);
      const text = composeDocText(frontmatter, canonicalText(input.text));
      const bytes = encoder.encode(applyStyle(text, style));
      await track(port.write(input.path, bytes, input.intent));
      const hash = await hashBytes(bytes);
      const entry: CatalogEntry = {
        id,
        path: input.path,
        rev: 1,
        hash,
        text,
        style,
        utf8Valid: true,
        mtimeMs: null,
        size: null,
        dev: null,
        ino: null,
      };
      entries.set(String(id), entry);
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
        if (!isUtf8(bytes)) {
          // 解码有损：再编码会把非法序列永久替换成 U+FFFD。拒绝写入，文件保持一字节不动。
          throw new EmberError('invalid_payload', '文件不是合法 UTF-8，保存会破坏原始字节，已拒绝写入', {
            id: String(id),
            path: String(entry.path),
          });
        }
        const rawText = decoder.decode(bytes);
        const diskText = canonicalText(rawText);
        // 磁盘风格可能被外部改过：以本次读到的为准，保存后仍保持用户当前的行尾/BOM
        entry.style = detectStyle(bytes, rawText);
        entry.utf8Valid = true;
        const diskHash = await hashBytes(bytes);
        const parsed = parseDocText(diskText);
        // D8：只替换正文区，frontmatter 按磁盘原文逐字节保留；
        // 只有显式给出 frontmatter 补丁时才就地改那几个顶层键，从不新增 created / updated。
        const patchedRaw =
          patch.frontmatter === undefined
            ? rawText
            : patchFrontmatterRegion(rawText, patch.frontmatter);
        const localRaw = replaceBodyRegion(
          patchedRaw,
          canonicalText(patch.body ?? parsed.body),
          entry.style.eol,
        );

        if (opts.base.hash === diskHash) {
          // 历史先落盘：写失败直接抛出，主文保持原样（spec §4）
          await recordHistory(id, entry.path, bytes);
          const committed = await commitRaw(entry, localRaw, opts.intent);
          const snapshot = snapshotOf(committed);
          emitChange({ id, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });
          return { snapshot, merged: true, conflict: null };
        }

        // 基线不符即落冲突副本并保留磁盘版本（不做自动三路合并）：
        // 正文唯一真相在磁盘，冲突副本保住本地改动，绝不静默覆盖外部修改
        const copy = await conflictCopy(entry, localRaw, opts.intent);
        // 队列内不会再有同 id 写入交错，这里同步的是只在本次 read 之后发生的外部变化
        if (diskHash !== entry.hash) {
          entry.rev += 1;
          entry.hash = diskHash;
          entry.text = diskText;
          bumpVersion(String(id));
        }
        log.warn('保存基线已过期：保留磁盘版本并落盘冲突副本', {
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
        if (String(entry.path) === String(next)) {
          return { snapshot: snapshotOf(entry), merged: true, conflict: null };
        }
        const nextId = asDocId(String(next));
        if (nextId === null) {
          throw new EmberError('invalid_payload', `不是合法的文档路径：${String(next)}`);
        }
        if (entries.has(String(nextId)) || (await readBytes(next)) !== null) {
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
        const oldId = entry.id;
        await port.rename(entry.path, next);
        // 身份即路径：改名后必须整体换键，旧路径的条目不能留在目录里
        entries.delete(String(oldId));
        const moved: CatalogEntry = { ...entry, id: nextId, path: next };
        entries.set(String(nextId), moved);
        versions.set(String(nextId), versions.get(String(oldId)) ?? 0);
        versions.delete(String(oldId));
        bumpVersion(String(nextId));
        // 画布引用同步：逐画布原子写，失败只记录，不把已完成的改名回滚
        if (renameHook !== null) {
          try {
            await renameHook(oldId, nextId);
          } catch (error) {
            log.error('改名后同步画布引用失败', {
              from: String(oldId),
              to: String(nextId),
              error: String(error),
            });
          }
        }
        // 历史日志按路径索引：改名后把旧 id 的条目换到新 id，否则历史会“消失”。
        await history.retag(oldId, nextId).catch((error: unknown) => {
          log.warn('改名后迁移历史日志失败，旧历史仍按旧路径保存', {
            from: String(oldId),
            to: String(nextId),
            error: String(error),
          });
        });
        emitChange({
          id: nextId,
          from: oldId,
          path: next,
          kind: 'renamed',
          revision: { rev: moved.rev, hash: moved.hash },
        });
        return { snapshot: snapshotOf(moved), merged: true, conflict: null };
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
        let destination: TrashDestination | null;
        try {
          destination = await port.remove(entry.path);
        } catch (error) {
          if (error instanceof EmberError) throw error;
          throw new EmberError('io_failed', '删除失败，文档保持原样（文件未被移入回收站）', {
            id: String(id),
            path: String(entry.path),
          });
        }
        entries.delete(String(id));
        versions.delete(String(id));
        emitChange({ id, path: entry.path, kind: 'removed', revision: { rev: entry.rev + 1, hash } });
        return destination;
      });
    },

    listHistory,

    readHistory,

    restoreHistory: async (id, versionId, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
        const entry = requireEntry(id);
        if (!isUlid(versionId)) {
          throw new EmberError('invalid_payload', `历史版本 id 非法：${versionId}`, { id: String(id) });
        }
        const bytes = await readBytes(entry.path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
        if (!isUtf8(bytes)) {
          throw new EmberError('invalid_payload', '文件不是合法 UTF-8，恢复会破坏原始字节，已拒绝写入', {
            id: String(id),
            path: String(entry.path),
          });
        }
        const diskHash = await hashBytes(bytes);
        const target = await history.read(id, versionId);
        if (target === null) {
          throw new EmberError('doc_not_found', `历史版本不存在：${versionId}`, { id: String(id) });
        }
        const targetBytes = target.bytes;
        if (!isUtf8(targetBytes)) {
          throw new EmberError('invalid_payload', '历史版本不是合法 UTF-8，拒绝恢复', {
            id: String(id),
            versionId,
          });
        }
        const targetHash = await hashBytes(targetBytes);
        if (targetHash !== target.entry.hash) {
          throw new EmberError('invalid_payload', '历史版本内容与日志不一致，拒绝恢复', {
            id: String(id),
            versionId,
          });
        }
        const targetRaw = decoder.decode(targetBytes);
        if (opts.base.hash !== diskHash) {
          // 基线过期：磁盘版本是唯一真相，把目标版内容另存为冲突副本，主文与历史都不动
          const copy = await conflictCopy(entry, canonicalText(targetRaw), opts.intent);
          log.warn('恢复基线已过期：保留磁盘版本并落盘冲突副本', {
            id: String(id),
            versionId,
            baseRev: opts.base.rev,
          });
          return { snapshot: snapshotOf(entry), merged: false, conflict: copy };
        }
        // 当前版先入历史，再提交目标版原始字节：恢复可逆，且后续历史不删除
        await recordHistory(id, entry.path, bytes);
        await port.write(entry.path, targetBytes, opts.intent);
        const current = entries.get(String(id)) ?? entry;
        current.text = canonicalText(targetRaw);
        current.style = detectStyle(targetBytes, targetRaw);
        current.utf8Valid = true;
        current.hash = targetHash;
        current.rev += 1;
        bumpVersion(String(id));
        const snapshot = snapshotOf(current);
        emitChange({ id, path: current.path, kind: 'updated', revision: snapshot.meta.rev });
        return { snapshot, merged: true, conflict: null };
      });
    },

    adoptCopy: async (copyId, opts) => {
      await ensureScanned();
      const initialCopy = requireEntry(copyId);
      const originalId = conflictOfOf(parseDocText(initialCopy.text).frontmatter);
      if (originalId === null || String(originalId) === String(copyId)) {
        throw new EmberError('invalid_payload', '该文档不是冲突副本，无法采用', { id: String(copyId) });
      }
      if (!entries.has(String(originalId))) {
        throw new EmberError('doc_not_found', '原文已不存在，只能另存或删除副本', {
          id: String(copyId),
          conflictOf: String(originalId),
        });
      }
      // 在原文队列内执行：正文写回原文；副本读盘与删除不经副本队列，
      // 因此两步之间没有跨文件事务，删除失败由返回值显式报告。
      return enqueue(String(originalId), async () => {
        assertWritable();
        const original = requireEntry(originalId);
        const copy = requireEntry(copyId);
        const copyBytes = await readBytes(copy.path);
        if (copyBytes === null) {
          throw new EmberError('doc_not_found', `冲突副本文件已消失：${String(copy.path)}`, {
            id: String(copyId),
          });
        }
        if (!isUtf8(copyBytes)) {
          throw new EmberError('invalid_payload', '冲突副本不是合法 UTF-8，拒绝采用', {
            id: String(copyId),
            path: String(copy.path),
          });
        }
        const copyHash = await hashBytes(copyBytes);
        if (copyHash !== opts.copyBase.hash) {
          throw new EmberError('stale_revision', '冲突副本已变化，请刷新后重新查看再采用', {
            id: String(copyId),
          });
        }
        const copyParsed = parseDocText(canonicalText(decoder.decode(copyBytes)));
        if (conflictOfOf(copyParsed.frontmatter) === null) {
          throw new EmberError('invalid_payload', '该文档已不再是冲突副本，无法采用', {
            id: String(copyId),
          });
        }

        const originalBytes = await readBytes(original.path);
        if (originalBytes === null) {
          throw new EmberError('doc_not_found', `原文文件已消失：${String(original.path)}`, {
            id: String(originalId),
          });
        }
        if (!isUtf8(originalBytes)) {
          throw new EmberError('invalid_payload', '原文不是合法 UTF-8，拒绝写入', {
            id: String(originalId),
            path: String(original.path),
          });
        }
        const originalHash = await hashBytes(originalBytes);
        if (originalHash !== opts.base.hash) {
          // 采用不是保存：基线不符时直接失败，绝不再次制造冲突副本
          throw new EmberError('stale_revision', '原文已变化，请刷新后重新查看再采用', {
            id: String(originalId),
          });
        }
        const originalRaw = decoder.decode(originalBytes);
        original.style = detectStyle(originalBytes, originalRaw);
        // 只并入副本的四项元数据，其余 frontmatter 行逐字节保留；不写 created / updated / id
        const patchedRaw = patchFrontmatterRegion(originalRaw, {
          title: copyParsed.frontmatter.title,
          summary: copyParsed.frontmatter.summary,
          tags: copyParsed.frontmatter.tags,
          aliases: copyParsed.frontmatter.aliases,
        });
        const nextRaw = replaceBodyRegion(patchedRaw, copyParsed.body, original.style.eol);
        await recordHistory(originalId, original.path, originalBytes);
        const committed = await commitRaw(original, nextRaw, opts.intent);
        const snapshot = snapshotOf(committed);
        emitChange({ id: originalId, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });

        // 第二步：删除副本（非事务）。删除前复核 hash，避免删掉刚被外部改动的内容。
        let copyRemoved = false;
        try {
          const latest = await readBytes(copy.path);
          if (latest !== null && (await hashBytes(latest)) === copyHash) {
            await port.remove(copy.path);
            entries.delete(String(copyId));
            versions.delete(String(copyId));
            emitChange({
              id: copyId,
              path: copy.path,
              kind: 'removed',
              revision: { rev: copy.rev + 1, hash: copyHash },
            });
            copyRemoved = true;
          } else {
            log.warn('采用副本后副本已变化，保留副本不删除', { id: String(copyId) });
          }
        } catch (error) {
          log.warn('采用副本后删除副本失败，副本保留', {
            id: String(copyId),
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        return { snapshot, copyRemoved };
      });
    },

    detachCopy: async (copyId, opts) => {
      await ensureScanned();
      return enqueue(String(copyId), async () => {
        assertWritable();
        const entry = requireEntry(copyId);
        const bytes = await readBytes(entry.path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(entry.path)}`);
        if (!isUtf8(bytes)) {
          throw new EmberError('invalid_payload', '文件不是合法 UTF-8，拒绝写入', {
            id: String(copyId),
            path: String(entry.path),
          });
        }
        const rawText = decoder.decode(bytes);
        entry.style = detectStyle(bytes, rawText);
        const diskHash = await hashBytes(bytes);
        if (opts.base.hash !== diskHash) {
          throw new EmberError('stale_revision', '另存前修订已过期，请重新读取后再操作', {
            id: String(copyId),
          });
        }
        const parsed = parseDocText(canonicalText(rawText));
        if (conflictOfOf(parsed.frontmatter) === null) {
          throw new EmberError('invalid_payload', '该文档不是冲突副本，无需另存', {
            id: String(copyId),
          });
        }
        const ember: Record<string, unknown> = { ...parsed.frontmatter.ember };
        delete ember['conflictOf'];
        const nextFrontmatter: Frontmatter = {
          ...parsed.frontmatter,
          ember,
        };
        await recordHistory(copyId, entry.path, bytes);
        const committed = await commitWhole(entry, composeDocText(nextFrontmatter, parsed.body), opts.intent);
        const snapshot = snapshotOf(committed);
        emitChange({ id: copyId, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });
        return snapshot;
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
        emitChange({ id, path: entry.path, kind: 'removed', revision: { rev: entry.rev + 1, hash } });
      });
    },

    setRenameHook: (hook) => {
      renameHook = hook;
    },

    legacyIds: async () => {
      await ensureScanned();
      const index = new Map<string, VaultPath[]>();
      for (const entry of entries.values()) {
        const raw = parseDocText(entry.text).frontmatter.id;
        if (raw === null) continue;
        const legacy = raw.trim();
        if (!isUlid(legacy)) continue;
        const list = index.get(legacy);
        if (list === undefined) {
          index.set(legacy, [entry.path]);
        } else {
          list.push(entry.path);
        }
      }
      return index;
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

    applyFileEvents,

    guard: () => guard,

    rescan,
  };
};
