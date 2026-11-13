import {
  createUlid,
  deriveSummary,
  joinFrontmatter,
  toSerializable,
  unsafeContentHash,
  asDocId,
  type ContentHash,
  type DocId,
  type Frontmatter,
  type VaultPath,
} from '#doc-model';
import { stringify as stringifyYaml } from 'yaml';
import { canonicalText, hashBytes, isUtf8, parseDocText, utcNow } from './doc-text.ts';
import type { EventBus } from './events.ts';
import { EmberError } from './errors.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
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

  /** 列出该文档历史版本（新→旧）；索引缺失/损坏返回空数组并告警，不抛错 */
  listHistory(id: DocId): Promise<readonly DocHistoryEntry[]>;
  /** 只读预览；版本不存在抛 doc_not_found，索引哈希不符/非 UTF-8 抛 invalid_payload；不写盘 */
  readHistory(id: DocId, versionId: string): Promise<DocHistoryPreview>;
  /** 恢复：校验当前 base.hash；一致则当前版入历史后提交目标版，失配落冲突副本 */
  restoreHistory(id: DocId, versionId: string, opts: WriteOptions): Promise<WriteOutcome>;

  /**
   * 采用副本：正文与 title/summary/tags/aliases 写回原文（保留原 id 与 created），
   * 成功后把副本移入系统回收站；两步非事务，删除失败返回 copyRemoved: false。
   */
  adoptCopy(copyId: DocId, opts: AdoptConflictOptions): Promise<AdoptConflictResult>;
  /** 另存为普通文档：清除副本的 ember.conflictOf，不改 id / 路径 / 正文 */
  detachCopy(copyId: DocId, opts: WriteOptions): Promise<DocSnapshot>;

  /**
   * 为缺少 id 的既有 `.md` 文件补写身份（库健康检查的显式 adoption）。
   * 仅当文件仍无 id、字节 hash 等于 expectedHash、且为合法 UTF-8 时写入；
   * 不改正文，只补 `id` / 缺失的 `created` / 刷新 `updated`。
   */
  adopt(path: VaultPath, expectedHash: ContentHash): Promise<DocSnapshot>;

  flush(): Promise<void>;
  watch(listener: (change: DocChange) => void): Disposable;
}

/** 内核内部扩展：watcher 触发目录对账、文章回滚用，不暴露给能力（G1） */
export interface DocServiceInternal extends DocService {
  /** 全量对账：文件 → 目录；只收录已具备合法且唯一 id 的文档 */
  refresh(): Promise<void>;
  /**
   * 永久删除：**仅供内核回滚内部使用**（文章创建后画布写入失败），不是用户删除入口；
   * 不注册为命令——`core.doc.purge` 在契约里仍是「v1 未实现」。
   */
  purge(id: DocId, opts: WriteOptions): Promise<void>;
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

/** 文档历史目录：`.workbench/history/documents/<docId>/`（与画布历史同属 history/） */
const HISTORY_DOC_DIR = '.workbench/history/documents';
/** 每篇文档保留的历史版本数 */
const HISTORY_KEEP = 20;
/** 每篇文档历史版本的字节预算 */
const HISTORY_BUDGET = 64 * 1024 * 1024;
const HISTORY_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

/** 保留策略：最多 HISTORY_KEEP 版、总字节不超过 HISTORY_BUDGET，永远保留最新一条 */
const pruneHistory = (
  entries: readonly DocHistoryEntry[],
): { readonly kept: DocHistoryEntry[]; readonly dropped: DocHistoryEntry[] } => {
  const dropped: DocHistoryEntry[] = [];
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
    if (port.readonlyMode) {
      throw new EmberError('vault_locked', '库为只读，写操作被拒绝（原因见状态栏）', {
        reason: port.readonlyReason,
      });
    }
  };

  /** 冲突副本归属：只认合法 ULID，其余一律视为普通文档 */
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
      flags: { needsAdoption: false, idInvalid: false, duplicateId: false },
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

  const historyRoot = paths.normalize(HISTORY_DOC_DIR);
  const historyDir = (id: DocId): VaultPath => paths.join(historyRoot, String(id));
  const historyIndexPath = (id: DocId): VaultPath => paths.join(historyDir(id), 'index.json');
  const historyVersionPath = (id: DocId, versionId: string): VaultPath =>
    paths.join(historyDir(id), `${versionId}.md`);

  /**
   * 读取历史索引：缺失视为无历史；结构非法按整表损坏处理（告警 + 空列表），
   * 不让一份坏 index.json 阻断编辑器。下次记录会以新表覆盖它。
   */
  const readHistoryIndex = async (id: DocId): Promise<readonly DocHistoryEntry[]> => {
    const bytes = await port.read(historyIndexPath(id));
    if (bytes === null) return [];
    try {
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('索引根节点不是对象');
      }
      const record = parsed as Readonly<Record<string, unknown>>;
      if (record.schemaVersion !== 1) throw new Error('索引版本不支持');
      if (record.docId !== String(id)) throw new Error('索引文档 id 不匹配');
      const rawVersions = record.versions;
      if (!Array.isArray(rawVersions)) throw new Error('versions 不是数组');
      const versions: DocHistoryEntry[] = [];
      for (const item of rawVersions as readonly unknown[]) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new Error('版本条目不是对象');
        }
        const raw = item as Readonly<Record<string, unknown>>;
        const versionId = typeof raw.versionId === 'string' ? raw.versionId : '';
        const hash = typeof raw.hash === 'string' ? raw.hash : '';
        const path = typeof raw.path === 'string' ? raw.path : '';
        const at = typeof raw.at === 'string' ? raw.at : '';
        const size = raw.size;
        if (asDocId(versionId) === null) throw new Error('版本 id 非法');
        if (!HISTORY_HASH_PATTERN.test(hash)) throw new Error('版本 hash 非法');
        if (at === '') throw new Error('版本时间缺失');
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
          throw new Error('版本大小非法');
        }
        const normalized = paths.normalize(path);
        versions.push({ versionId, hash: unsafeContentHash(hash), path: normalized, at, size });
      }
      return versions;
    } catch (error) {
      log.warn('文档历史索引损坏，按无历史处理', {
        id: String(id),
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  /** 整表重写；Rust 端 write_atomic 保证 rename 原子替换 */
  const writeHistoryIndex = async (id: DocId, versions: readonly DocHistoryEntry[]): Promise<void> => {
    const payload = { schemaVersion: 1, docId: String(id), versions };
    await port.write(historyIndexPath(id), encoder.encode(`${JSON.stringify(payload, null, 2)}\n`), 'system');
  };

  /**
   * 内容提交前记录旧版：先写版本原始字节，再原子更新索引，最后尽力清理被淘汰的文件。
   * 任一步失败都清理本次新版本文件并向上抛，调用方不得提交主文。
   */
  const recordHistory = async (id: DocId, docPath: VaultPath, bytes: Uint8Array): Promise<void> => {
    const versionId = createUlid(now().getTime());
    const versionPath = historyVersionPath(id, versionId);
    const entry: DocHistoryEntry = {
      versionId,
      path: docPath,
      hash: await hashBytes(bytes),
      at: utcNow(now()),
      size: bytes.byteLength,
    };
    await port.write(versionPath, bytes, 'system');
    try {
      const existing = await readHistoryIndex(id);
      const merged = [entry, ...existing.filter((item) => item.versionId !== versionId)];
      const { kept, dropped } = pruneHistory(merged);
      await writeHistoryIndex(id, kept);
      for (const victim of dropped) {
        await port.purge(historyVersionPath(id, victim.versionId)).catch(() => undefined);
      }
    } catch (error) {
      await port.purge(versionPath).catch(() => undefined);
      throw error;
    }
  };

  const listHistory = async (id: DocId): Promise<readonly DocHistoryEntry[]> => readHistoryIndex(id);

  const readHistory = async (id: DocId, versionId: string): Promise<DocHistoryPreview> => {
    if (asDocId(versionId) === null) {
      throw new EmberError('invalid_payload', `历史版本 id 非法：${versionId}`, { id: String(id) });
    }
    const entry = (await readHistoryIndex(id)).find((item) => item.versionId === versionId);
    if (entry === undefined) {
      throw new EmberError('doc_not_found', `历史版本不存在：${versionId}`, { id: String(id) });
    }
    const bytes = await port.read(historyVersionPath(id, versionId));
    if (bytes === null) {
      throw new EmberError('doc_not_found', `历史版本文件已消失：${versionId}`, { id: String(id) });
    }
    if (!isUtf8(bytes)) {
      throw new EmberError('invalid_payload', '历史版本不是合法 UTF-8，无法预览', {
        id: String(id),
        versionId,
      });
    }
    const hash = await hashBytes(bytes);
    if (hash !== entry.hash) {
      throw new EmberError('invalid_payload', '历史版本内容与索引不一致', { id: String(id), versionId });
    }
    return { entry, text: canonicalText(decoder.decode(bytes)) };
  };

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
      const rawText = decoder.decode(bytes);
      const text = canonicalText(rawText);
      const style = detectStyle(bytes, rawText);
      const utf8Valid = isUtf8(bytes);
      const parsed = parseDocText(rawText);
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
        existing.style = style;
        existing.utf8Valid = utf8Valid;
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
      entries.set(String(id), { id, path, rev, hash, text, style, utf8Valid });
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
    // 唯一落盘收口：编辑器保存、AI 替换、冲突副本合并、撤销都从这里写。
    // 入参是 canonical 文本，写前按文件既有风格还原 BOM 与行尾。
    const canonical = canonicalText(text);
    const bytes = encoder.encode(applyStyle(canonical, entry.style));
    await port.write(entry.path, bytes, intent);
    // hash 必须按真实落盘字节算：base.hash 校验比较的是磁盘内容，
    // 换成 canonical 文本的 hash 会让并发写入的过期判定整体失真。
    const hash = await hashBytes(bytes);
    // 入队时捕获的 entry 可能已被 refresh 替换：更新 map 中的当前对象，避免改到脱管副本
    const current = entries.get(String(entry.id)) ?? entry;
    current.text = canonical;
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
    if (!entry.utf8Valid) {
      // 副本会把原始字节重新编码：非 UTF-8 时同样拒绝，避免把损坏扩散到新文件
      throw new EmberError('invalid_payload', '文件不是合法 UTF-8，拒绝写入冲突副本', {
        path: String(entry.path),
      });
    }
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
        const view: CatalogEntry = { id: entry.id, path: entry.path, rev: entry.rev, hash, text, style, utf8Valid };
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
      // 导入等外部来源可能自带 BOM/CRLF：新文件保留其行尾风格，frontmatter 跟着同一风格写
      const style = detectTextStyle(input.text);
      const text = composeDocText(frontmatter, canonicalText(input.text));
      const bytes = encoder.encode(applyStyle(text, style));
      await track(port.write(input.path, bytes, input.intent));
      const hash = await hashBytes(bytes);
      const entry: CatalogEntry = { id, path: input.path, rev: 1, hash, text, style, utf8Valid: true };
      entries.set(String(id), entry);
      byPath.set(String(input.path), id);
      bumpVersion(String(id));
      emitChange({ id, path: input.path, kind: 'created', revision: { rev: 1, hash } });
      return snapshotOf(entry);
    },

    adopt: async (path, expectedHash) => {
      await ensureScanned();
      return enqueue(`adopt:${String(path)}`, async () => {
        assertWritable();
        if (paths.ext(path).toLowerCase() !== '.md') {
          throw new EmberError('invalid_payload', `只有 .md 文件可以纳入库管理：${String(path)}`);
        }
        if (byPath.has(String(path))) {
          throw new EmberError('invalid_payload', `文件已纳入目录，无需 adoption：${String(path)}`);
        }
        const bytes = await readBytes(path);
        if (bytes === null) throw new EmberError('doc_not_found', `文件已消失：${String(path)}`);
        if (!isUtf8(bytes)) {
          throw new EmberError('invalid_payload', '文件不是合法 UTF-8，无法补写 id', {
            path: String(path),
          });
        }
        const diskHash = await hashBytes(bytes);
        if (diskHash !== expectedHash) {
          throw new EmberError('stale_revision', '文件在扫描后已变化，请重新检查', {
            path: String(path),
          });
        }
        const rawText = decoder.decode(bytes);
        const parsed = parseDocText(rawText);
        if (parsed.frontmatterBroken) {
          throw new EmberError('invalid_payload', 'frontmatter YAML 无法解析，只报告不修复', {
            path: String(path),
          });
        }
        if (parsed.issues.some((item) => item.code === 'id_invalid')) {
          throw new EmberError('invalid_payload', 'id 格式非法，只报告不修复', {
            path: String(path),
          });
        }
        if (parsed.frontmatter.id !== null) {
          throw new EmberError('invalid_payload', '文件已有 id（含非法 id），不做 adoption', {
            path: String(path),
          });
        }
        const idValue = createUlid(now().getTime());
        const id = asDocId(idValue);
        if (id === null || entries.has(String(id))) {
          throw new EmberError('duplicate_id', `无法分配唯一 id：${idValue}`);
        }
        const stamp = utcNow(now());
        const frontmatter: Frontmatter = {
          ...parsed.frontmatter,
          id: idValue,
          created: parsed.frontmatter.created ?? stamp,
          updated: stamp,
        };
        const text = composeDocText(frontmatter, parsed.body);
        const style = detectStyle(bytes, rawText);
        const encoded = encoder.encode(applyStyle(text, style));
        await track(port.write(path, encoded, 'migration'));
        const hash = await hashBytes(encoded);
        const entry: CatalogEntry = { id, path, rev: 1, hash, text, style, utf8Valid: true };
        entries.set(String(id), entry);
        byPath.set(String(path), id);
        bumpVersion(String(id));
        emitChange({ id, path, kind: 'created', revision: { rev: 1, hash } });
        return snapshotOf(entry);
      });
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
        const nextFrontmatter: Frontmatter = {
          ...withFrontmatterPatch(parsed.frontmatter, patch),
          updated: utcNow(now()),
        };
        const localComposed = composeDocText(nextFrontmatter, patch.body ?? parsed.body);

        if (opts.base.hash === diskHash) {
          // 历史先落盘：写失败直接抛出，主文保持原样（spec §4）
          await recordHistory(id, entry.path, bytes);
          const committed = await commit(entry, localComposed, opts.intent);
          const snapshot = snapshotOf(committed);
          emitChange({ id, path: committed.path, kind: 'updated', revision: snapshot.meta.rev });
          return { snapshot, merged: true, conflict: null };
        }

        // 基线不符即落冲突副本并保留磁盘版本（不做自动三路合并）：
        // 正文唯一真相在磁盘，冲突副本保住本地改动，绝不静默覆盖外部修改
        const copy = await conflictCopy(entry, localComposed, opts.intent);
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

    listHistory,

    readHistory,

    restoreHistory: async (id, versionId, opts) => {
      await ensureScanned();
      return enqueue(String(id), async () => {
        assertWritable();
        const entry = requireEntry(id);
        if (asDocId(versionId) === null) {
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
        const target = (await readHistoryIndex(id)).find((item) => item.versionId === versionId);
        if (target === undefined) {
          throw new EmberError('doc_not_found', `历史版本不存在：${versionId}`, { id: String(id) });
        }
        const targetBytes = await port.read(historyVersionPath(id, versionId));
        if (targetBytes === null) {
          throw new EmberError('doc_not_found', `历史版本文件已消失：${versionId}`, { id: String(id) });
        }
        if (!isUtf8(targetBytes)) {
          throw new EmberError('invalid_payload', '历史版本不是合法 UTF-8，拒绝恢复', {
            id: String(id),
            versionId,
          });
        }
        const targetHash = await hashBytes(targetBytes);
        if (targetHash !== target.hash) {
          throw new EmberError('invalid_payload', '历史版本内容与索引不一致，拒绝恢复', {
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
        const originalParsed = parseDocText(canonicalText(originalRaw));
        const nextFrontmatter: Frontmatter = {
          ...originalParsed.frontmatter,
          // 允许迁移的元数据：标题 / 简介 / 标签 / 别名；id、created、ember、extra 保留原文
          title: copyParsed.frontmatter.title,
          summary: copyParsed.frontmatter.summary,
          tags: copyParsed.frontmatter.tags,
          aliases: copyParsed.frontmatter.aliases,
          updated: utcNow(now()),
        };
        await recordHistory(originalId, original.path, originalBytes);
        const committed = await commit(
          original,
          composeDocText(nextFrontmatter, copyParsed.body),
          opts.intent,
        );
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
            byPath.delete(String(copy.path));
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
          updated: utcNow(now()),
        };
        await recordHistory(copyId, entry.path, bytes);
        const committed = await commit(entry, composeDocText(nextFrontmatter, parsed.body), opts.intent);
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
