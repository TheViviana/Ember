import {
  buildResolutionIndex,
  extractLinks,
  normalizeLinkKey,
  parseMarkdown,
  resolveLink,
  splitFrontmatter,
  toPlainText,
  type DocId,
  type LinkTarget,
  type ResolvedLink,
  type VaultPath,
} from '#doc-model';
import type { EventBus } from './events.ts';
import { tokenizeForIndex, tokenizeForQuery } from './search-token.ts';
import type { DocService } from './doc-service.ts';
import type { SettingsService } from './types.ts';
import type {
  Disposable,
  DocMeta,
  DocSnapshot,
  IndexEvent,
  IndexStats,
  IndexedDocument,
  LinkRecord,
  Logger,
  SearchQuery,
  SearchResult,
  UnlinkedMention,
} from './types.ts';

/**
 * 派生数据服务：内存实现的真索引（kernel-contract §4）。
 * - 元数据（标题/标签/别名/简介）在 rebuild 的第一阶段即时可用；
 * - 正文词组索引与链接关系在后台逐篇增量（中文按相邻二元组切分，不依赖外部词典）；
 * - 数据全部可重建：丢失或损坏时 rebuild 一次即恢复，不承载任何唯一真相。
 */
export interface IndexService {
  document(id: DocId): Promise<IndexedDocument | null>;
  search(query: SearchQuery): Promise<SearchResult>;
  outbound(id: DocId): Promise<readonly LinkRecord[]>;
  backlinks(id: DocId): Promise<readonly LinkRecord[]>;
  /** 按原始链接键反查引用（附件面板「被引用位置」：图片嵌入、纯路径引用） */
  referencesByRaw(raw: string): Promise<readonly LinkRecord[]>;
  stats(): Promise<IndexStats>;
  rebuild(): Promise<IndexStats>;
  watch(listener: (event: IndexEvent) => void): Disposable;
  /** 按需扫描：所有其它文档正文中对目标的未链接提及（阶段 8） */
  unlinkedMentions(targetId: DocId): Promise<readonly UnlinkedMention[]>;
}

export interface IndexServiceOptions {
  readonly docs: DocService;
  readonly settings: SettingsService;
  readonly events: EventBus;
  readonly log: Logger;
  readonly now?: () => Date;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const EXCERPT_MAX = 500;
const SNIPPET_RADIUS = 48;
/** 正文索引逐篇推进；单批让出一个宏任务，避免大库重建时饿死交互 */
const BODY_BATCH = 8;
const TOKENIZER_VERSION = 1;

/** 权重：标题 > 标签/别名 > 简介 > 正文 */
const WEIGHT_TITLE = 3;
const WEIGHT_TAG = 2.5;
const WEIGHT_ALIAS = 2.5;
const WEIGHT_SUMMARY = 1.5;
const WEIGHT_BODY = 1;

interface BodyEntry {
  readonly terms: ReadonlySet<string>;
  /** 纯文本（分词用） */
  readonly text: string;
  /** 原始正文（含换行）：命中行号与摘要都从它取，保证行号对得上编辑器 */
  readonly rawBody: string;
  /** 原始正文首行在文件中的行号（计入 frontmatter 偏移） */
  readonly bodyStartLine: number;
}

interface LinkEntry {
  readonly outbound: readonly LinkRecord[];
  readonly backlinks: readonly LinkRecord[];
  readonly raw: ReadonlyMap<string, readonly LinkRecord[]>;
}

// -------- 未链接提及：AST 黑父节点集合（容器节点的 children 全排除） --------
const UNLINKED_BLACKLIST_PARENT = new Set<string>([
  'link',
  'linkReference',
  'wikiLink',
  'embed',
  'image',
  'imageReference',
  'definition',
]);
// 同时排除孤立的 `code` / `inlineCode` —— 它们本身是叶子节点，没有 text children
const UNLINKED_BLACKLIST_LEAF = new Set<string>(['code', 'inlineCode']);

/** 转义 regex 字面量 */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 拉丁候选：ASCII \b 边界；中文候选直接 substring（中文字符间天然无边界） */
const buildCandidateRegex = (candidate: string): RegExp => {
  const hasAscii = /[A-Za-z]/.test(candidate);
  const escaped = escapeRegex(candidate);
  if (!hasAscii) return new RegExp(escaped, 'g');
  return new RegExp(`\\b${escaped}\\b`, 'g');
};

/**
 * 递归 AST 遍历：只收集不在黑父节点里的 text 节点。
 * 对每个 text node.value 跑候选 regex，产出 { match, from, to }。
 */
const matchTextNode = (
  node: { type: string; value?: string; position?: { start?: { offset?: number; line?: number } } },
  candidates: ReadonlyArray<{ needle: string; regex: RegExp; kind: 'title' | 'alias' }>,
): Array<{ match: string; from: number; to: number; kind: 'title' | 'alias'; offset: number }> => {
  const value = node.value;
  const startOffset = node.position?.start?.offset ?? 0;
  const startLine = node.position?.start?.line ?? 1;
  if (typeof value !== 'string' || value.length === 0) return [];
  const hits: Array<{ match: string; from: number; to: number; kind: 'title' | 'alias'; offset: number }> = [];
  for (const cand of candidates) {
    const regex = new RegExp(cand.regex.source, cand.regex.flags.includes('g') ? cand.regex.flags : `${cand.regex.flags}g`);
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(value)) !== null) {
      // 0 宽匹配（空 needle）跳过
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      hits.push({
        match: m[0],
        from: startOffset + m.index,
        to: startOffset + m.index + m[0].length,
        kind: cand.kind,
        offset: startLine, // 仅临时用；外层要加 bodyStartLine
      });
    }
  }
  return hits;
};

const walkMarkdownTreeForUnlinked = (
  node: unknown,
  excluded: boolean,
  candidates: ReadonlyArray<{ needle: string; regex: RegExp; kind: 'title' | 'alias' }>,
  collected: Array<{ match: string; from: number; to: number; kind: 'title' | 'alias'; line: number }>,
): void => {
  if (typeof node !== 'object' || node === null) return;
  const n = node as {
    type?: string;
    children?: unknown[];
    value?: string;
    position?: { start?: { offset?: number; line?: number } };
  };
  const type = n.type;
  if (!type) return;
  const childExcluded = excluded || UNLINKED_BLACKLIST_LEAF.has(type) || UNLINKED_BLACKLIST_PARENT.has(type);
  if (type === 'text' && !excluded && !childExcluded) {
    const matches = matchTextNode(n as { type: string; value?: string; position?: { start?: { offset?: number; line?: number } } }, candidates);
    for (const m of matches) {
      collected.push({ match: m.match, from: m.from, to: m.to, kind: m.kind, line: m.offset });
    }
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      walkMarkdownTreeForUnlinked(child, childExcluded, candidates, collected);
    }
  }
};

const normalizeLimit = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
};

export const createIndexService = (options: IndexServiceOptions): IndexService => {
  const { docs, settings, events, log } = options;
  const now = options.now ?? ((): Date => new Date());

  /** 元数据索引：rebuild 第一阶段即填充 */
  const metas = new Map<string, DocMeta>();
  /** 正文词索引与纯文本（后台阶段填充） */
  const bodies = new Map<string, BodyEntry>();
  /** 链接关系（后台阶段填充） */
  const links = new Map<string, LinkEntry>();
  let resolution: ReturnType<typeof buildResolutionIndex> | null = null;
  /** settings.linkOverrides 缓存（settings:changed 时失效） */
  let overrides: Readonly<Record<string, DocId>> = {};
  let lastBuiltAt = '';
  /** 至少完整跑过一次 rebuild（元数据 + 正文阶段）；之后由 doc:changed 增量维护 */
  let built = false;
  /** 元数据阶段门闩；正文阶段在 bodyBuilding */
  let metaBuilding: Promise<void> | null = null;
  let bodyBuilding: Promise<void> | null = null;
  /** rebuild 代数：新 rebuild 启动时 +1，旧 body 阶段据此提前退出，避免双游标互踩 */
  let bodyGeneration = 0;
  let bodyCursor = 0;
  const listeners = new Set<(event: IndexEvent) => void>();

  const emit = (event: IndexEvent): void => {
    if (event.kind === 'updated' || event.kind === 'rebuilt') {
      events.emit('index:updated', { changedDocIds: event.changedDocIds });
    }
    for (const listener of [...listeners]) listener(event);
  };

  // 外部改 settings.json 时重读歧义覆盖
  void settings.watch((next) => {
    overrides = next.linkOverrides;
  });

  const buildResolution = (): void => {
    const targets: LinkTarget[] = [...metas.values()].map((meta) => ({
      id: meta.id,
      path: meta.path,
      title: meta.title,
      aliases: meta.aliases,
    }));
    resolution = buildResolutionIndex(targets);
  };

  const recordOf = (srcId: DocId, resolved: ResolvedLink, line: number): LinkRecord => ({
    srcId,
    targetId: resolved.targetId,
    raw: resolved.raw,
    kind: resolved.embed ? 'embed' : 'link',
    resolver: resolved.resolver,
    anchor: resolved.anchor,
    line,
  });

  /** 单篇正文索引：词组 + 链接关系（含原始键反查） */
  const indexBody = (snapshot: DocSnapshot): void => {
    const id = snapshot.meta.id;
    const key = String(id);
    const split = splitFrontmatter(snapshot.text);
    const plain = toPlainText(parseMarkdown(split.body));
    bodies.set(key, {
      terms: new Set(tokenizeForIndex(plain)),
      text: plain,
      rawBody: split.body,
      bodyStartLine:
        split.bodyOffset === 0 ? 1 : snapshot.text.slice(0, split.bodyOffset).split('\n').length,
    });

    const startLine =
      split.bodyOffset === 0 ? 1 : snapshot.text.slice(0, split.bodyOffset).split('\n').length;
    const tree = parseMarkdown(split.body);
    const records: LinkRecord[] = [];
    const index = resolution;
    const rawMap = new Map<string, LinkRecord[]>();
    if (index !== null) {
      for (const link of extractLinks(tree, { bodyStartLine: startLine })) {
        const resolved = resolveLink(link, index);
        let targetId = resolved.targetId;
        if (targetId === null && resolved.resolver === 'ambiguous') {
          const override = overrides[resolved.raw];
          if (
            override !== undefined &&
            resolved.candidates.some((candidate) => String(candidate) === String(override))
          ) {
            targetId = override;
          }
        }
        const record = recordOf(id, { ...resolved, targetId }, link.line);
        records.push(record);
        // 原始键反查（附件面板）：按链接目标（去掉嵌入前缀）归一化
        const rawKey = normalizeLinkKey(link.target);
        const rawList = rawMap.get(rawKey);
        if (rawList === undefined) rawMap.set(rawKey, [record]);
        else rawList.push(record);
      }
    }
    links.set(key, { outbound: records, backlinks: [], raw: rawMap });
  };

  /** 反链索引随链接变化整体重算（规模 = 全库链接数，重建成本低） */
  const rebuildBacklinks = (): void => {
    const collected = new Map<string, LinkRecord[]>();
    for (const entry of links.values()) {
      for (const record of entry.outbound) {
        if (record.targetId === null) continue;
        const key = String(record.targetId);
        const list = collected.get(key);
        if (list === undefined) collected.set(key, [record]);
        else list.push(record);
      }
    }
    for (const [key, entry] of links) {
      links.set(key, { ...entry, backlinks: collected.get(key) ?? [] });
    }
  };

  const dropDoc = (id: DocId): void => {
    const key = String(id);
    metas.delete(key);
    bodies.delete(key);
    links.delete(key);
    buildResolution();
    rebuildBacklinks();
  };

  /** 元数据阶段：list() 快照 → metas + 解析索引；此时搜索已覆盖标题/标签/别名 */
  const buildMetas = async (): Promise<void> => {
    const all = await docs.list();
    metas.clear();
    for (const meta of all) metas.set(String(meta.id), meta);
    buildResolution();
    bodyCursor = 0;
  };

  /** 正文阶段：从 bodyCursor 起逐篇推进，让出宏任务避免饿死交互 */
  const buildBodiesStep = async (): Promise<boolean> => {
    const keys = [...metas.keys()];
    let processed = 0;
    while (bodyCursor < keys.length && processed < BODY_BATCH) {
      const key = keys[bodyCursor] as string;
      bodyCursor += 1;
      processed += 1;
      const id = metas.get(key)?.id;
      if (id === undefined) continue;
      try {
        indexBody(await docs.read(id));
      } catch (error) {
        log.warn('索引正文失败，跳过该篇', { id: key, error: String(error) });
      }
    }
    rebuildBacklinks();
    return bodyCursor < keys.length;
  };

  const runBodyPhase = async (): Promise<void> => {
    const generation = bodyGeneration;
    try {
      while (await buildBodiesStep()) {
        // 被新一代 rebuild 取代：立即退出，游标归新阶段所有
        if (generation !== bodyGeneration) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      lastBuiltAt = now().toISOString();
      built = true;
      emit({ kind: 'rebuilt', changedDocIds: [] });
      log.info('索引正文构建完成', { documents: bodies.size });
    } catch (error) {
      log.error('索引正文构建失败', { error: String(error) });
    }
  };

  const runRebuild = async (): Promise<void> => {
    bodyGeneration += 1;
    overrides = (await settings.read()).linkOverrides;
    await buildMetas();
    emit({ kind: 'rebuilt', changedDocIds: [] });
    // 正文阶段纳入 bodyBuilding 门闩：重复触发不再重置游标造成漏索引
    bodyBuilding = runBodyPhase().finally(() => {
      bodyBuilding = null;
    });
  };

  /** 首次访问时懒启动构建：await 元数据阶段（正文随后就绪，重复触发由门闩挡住） */
  const ensureStarted = async (): Promise<void> => {
    if (metaBuilding === null && !built && bodyBuilding === null) {
      metaBuilding = runRebuild()
        .catch((error: unknown) => {
          log.error('索引启动构建失败', { error: String(error) });
        })
        .finally(() => {
          metaBuilding = null;
        });
    }
    if (metaBuilding !== null) await metaBuilding;
  };

  // doc:changed → 增量维护
  docs.watch((change) => {
    if (change.kind === 'removed') {
      dropDoc(change.id);
      emit({ kind: 'updated', changedDocIds: [change.id] });
      return;
    }
    void (async () => {
      try {
        const snapshot = await docs.read(change.id);
        metas.set(String(snapshot.meta.id), snapshot.meta);
        buildResolution();
        indexBody(snapshot);
        rebuildBacklinks();
        emit({ kind: 'updated', changedDocIds: [change.id] });
      } catch (error) {
        // 读取失败（如并发删除）：按消失处理
        dropDoc(change.id);
        emit({ kind: 'updated', changedDocIds: [change.id] });
        log.warn('索引增量更新失败，已按缺失处理', {
          id: String(change.id),
          error: String(error),
        });
      }
    })();
  });

  const computeStats = (): IndexStats => {
    let unresolved = 0;
    let ambiguous = 0;
    let linkCount = 0;
    for (const entry of links.values()) {
      for (const record of entry.outbound) {
        linkCount += 1;
        if (record.resolver === 'unresolved') unresolved += 1;
        if (record.resolver === 'ambiguous') ambiguous += 1;
      }
    }
    return {
      documents: metas.size,
      links: linkCount,
      unresolved,
      ambiguous,
      lastBuiltAt,
      tokenizerVersion: TOKENIZER_VERSION,
    };
  };

  const scoreDoc = (
    meta: DocMeta,
    terms: readonly string[],
    body: BodyEntry | null,
  ): number | null => {
    const title = meta.title.toLowerCase();
    const summary = meta.summary.toLowerCase();
    const tags = meta.tags.map((tag) => tag.toLowerCase());
    const aliases = meta.aliases.map((alias) => alias.toLowerCase());
    let score = 0;
    for (const term of terms) {
      let hit = 0;
      if (title.includes(term)) hit += WEIGHT_TITLE;
      if (tags.some((tag) => tag.includes(term))) hit += WEIGHT_TAG;
      if (aliases.some((alias) => alias.includes(term))) hit += WEIGHT_ALIAS;
      if (summary.includes(term)) hit += WEIGHT_SUMMARY;
      if (body !== null && body.terms.has(term)) hit += WEIGHT_BODY;
      if (hit === 0) return null;
      score += hit;
    }
    // 完整短语命中加成（CJK 二元组 AND 等价于词组匹配，再给整体短语一次加权）
    const phrase = terms.join('');
    if (
      terms.length > 1 &&
      (title.includes(phrase) || (body !== null && body.text.includes(phrase)))
    ) {
      score += WEIGHT_TITLE;
    }
    return score;
  };

  /**
   * 命中摘要 + 行号：在原始正文的行里找首个命中行——行号直接对得上编辑器
   * （doc.line(n)），摘要就是该行的裁剪。正文索引未就绪时回落简介。
   */
  const hitOf = (
    terms: readonly string[],
    body: BodyEntry | null,
    summary: string,
  ): { readonly snippet: string; readonly line: number | null } => {
    if (body !== null && terms.length > 0) {
      const lines = body.rawBody.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        const lowered = line.toLowerCase();
        if (terms.some((term) => lowered.includes(term))) {
          const trimmed = line.trim();
          return {
            snippet:
              trimmed.length > SNIPPET_RADIUS * 2
                ? `${trimmed.slice(0, SNIPPET_RADIUS * 2)}…`
                : trimmed,
            line: body.bodyStartLine + index,
          };
        }
      }
    }
    if (summary.length === 0) return { snippet: '', line: null };
    return {
      snippet: summary.length > SNIPPET_RADIUS * 2 ? `${summary.slice(0, SNIPPET_RADIUS * 2)}…` : summary,
      line: null,
    };
  };

  return {
    document: async (id) => {
      await ensureStarted();
      const key = String(id);
      const meta = metas.get(key);
      if (meta === undefined) return null;
      const body = bodies.get(key) ?? null;
      const entry = links.get(key) ?? null;
      return {
        meta,
        links: entry?.outbound ?? [],
        excerpt: body === null ? '' : body.text.slice(0, EXCERPT_MAX),
      };
    },

    search: async (query) => {
      await ensureStarted();
      const limit = normalizeLimit(query.limit);
      const terms = tokenizeForQuery(query.text);
      const tags = query.tags ?? [];
      const prefix = query.pathPrefix === undefined ? null : String(query.pathPrefix);

      const hits: {
        id: DocId;
        path: VaultPath;
        title: string;
        snippet: string;
        line: number | null;
        score: number;
      }[] = [];
      for (const meta of metas.values()) {
        // 前缀必须止于路径段边界：`notes` 不命中 `notes-archive/…`
        if (prefix !== null && !String(meta.path).startsWith(prefix)) continue;
        if (prefix !== null) {
          const rest = String(meta.path).slice(prefix.length);
          if (rest !== '' && !rest.startsWith('/')) continue;
        }
        if (tags.length > 0 && !tags.every((tag) => meta.tags.includes(tag))) continue;
        const body = bodies.get(String(meta.id)) ?? null;
        if (terms.length === 0) {
          // 空查询 = 浏览全部
          const emptyHit = hitOf([], body, meta.summary);
          hits.push({
            id: meta.id,
            path: meta.path,
            title: meta.title,
            snippet: emptyHit.snippet,
            line: null,
            score: 1,
          });
          continue;
        }
        const score = scoreDoc(meta, terms, body);
        if (score === null) continue;
        const hit = hitOf(terms, body, meta.summary);
        hits.push({
          id: meta.id,
          path: meta.path,
          title: meta.title,
          snippet: hit.snippet,
          line: hit.line,
          score,
        });
      }
      hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
      return {
        hits: hits.slice(0, limit),
        total: hits.length,
        truncated: hits.length > limit,
      };
    },

    outbound: async (id) => {
      await ensureStarted();
      return links.get(String(id))?.outbound ?? [];
    },

    backlinks: async (id) => {
      await ensureStarted();
      return links.get(String(id))?.backlinks ?? [];
    },

    referencesByRaw: async (raw) => {
      await ensureStarted();
      const key = normalizeLinkKey(raw);
      const found: LinkRecord[] = [];
      for (const entry of links.values()) {
        const records = entry.raw.get(key);
        if (records !== undefined) found.push(...records);
      }
      return found;
    },

    stats: async () => {
      await ensureStarted();
      return computeStats();
    },

    rebuild: async () => {
      // 手动重建总是跑完整周期（元数据 + 正文），与懒启动无关
      if (metaBuilding !== null) await metaBuilding;
      if (bodyBuilding !== null) await bodyBuilding;
      metaBuilding = runRebuild()
        .catch((error: unknown) => {
          log.error('索引重建失败', { error: String(error) });
        })
        .finally(() => {
          metaBuilding = null;
        });
      await metaBuilding;
      if (bodyBuilding !== null) await bodyBuilding;
      return computeStats();
    },

    watch: (listener) => {
      listeners.add(listener);
      return {
        dispose: (): void => {
          listeners.delete(listener);
        },
      };
    },

    unlinkedMentions: async (targetId: DocId) => {
      await ensureStarted();
      const targetMeta = metas.get(targetId);
      if (targetMeta === undefined) return [];

      // 1. 候选：title（trim 去重）+ aliases；去空、去自身等于空串
      const rawCandidates: Array<{ needle: string; kind: 'title' | 'alias' }> = [];
      const title = targetMeta.title?.trim() ?? '';
      if (title.length > 0) rawCandidates.push({ needle: title, kind: 'title' });
      for (const alias of targetMeta.aliases ?? []) {
        const trimmed = alias.trim();
        if (trimmed.length > 0) rawCandidates.push({ needle: trimmed, kind: 'alias' });
      }
      // 去重（同一 needle 只取 title 优先）
      const seen = new Set<string>();
      const candidates: Array<{ needle: string; regex: RegExp; kind: 'title' | 'alias' }> = [];
      for (const cand of rawCandidates) {
        if (seen.has(cand.needle)) continue;
        seen.add(cand.needle);
        candidates.push({ needle: cand.needle, regex: buildCandidateRegex(cand.needle), kind: cand.kind });
      }
      if (candidates.length === 0) return [];

      // 2. 歧义判定：如果其它文档也有同 needle 作为 title 或 alias → 跳过
      //    （只算 metas，不扫正文里有没有这个词——那是另一件事）
      const ambiguous = new Set<string>();
      for (const cand of candidates) {
        let count = 0;
        for (const [id, meta] of metas) {
          if (id === targetId) continue;
          const t = meta.title?.trim() ?? '';
          const aliases = (meta.aliases ?? []).map((a) => a.trim());
          if (t === cand.needle || aliases.includes(cand.needle)) count++;
          if (count > 0) break; // 只要有一个其它文档用了就歧义
        }
        if (count > 0) ambiguous.add(cand.needle);
      }
      const safeCandidates = candidates.filter((c) => !ambiguous.has(c.needle));
      if (safeCandidates.length === 0) return [];

      // 3. 对每篇其它文档的 rawBody 扫描
      const mentions: UnlinkedMention[] = [];
      for (const [srcId] of metas) {
        if (srcId === targetId) continue; // 同篇排除
        const bodyEntry = bodies.get(srcId);
        if (bodyEntry === undefined) continue; // 未编入正文阶段
        const root = parseMarkdown(bodyEntry.rawBody);
        const collected: Array<{ match: string; from: number; to: number; kind: 'title' | 'alias'; line: number }> = [];
        walkMarkdownTreeForUnlinked(root, false, safeCandidates, collected);
        for (const hit of collected) {
          const bodyStartLine = bodyEntry.bodyStartLine;
          const snippet = bodyEntry.rawBody.slice(
            Math.max(0, hit.from - SNIPPET_RADIUS),
            Math.min(bodyEntry.rawBody.length, hit.to + SNIPPET_RADIUS),
          );
          mentions.push({
            srcId: srcId as DocId,
            targetId,
            title: targetMeta.title ?? '',
            from: hit.from,
            to: hit.to,
            match: hit.match,
            kind: hit.kind,
            line: hit.line + bodyStartLine - 1,
            snippet,
          });
        }
      }
      // 稳定排序：先按来源文档、再按行、再按 from
      mentions.sort((a, b) => {
        if (a.srcId < b.srcId) return -1;
        if (a.srcId > b.srcId) return 1;
        if (a.line !== b.line) return a.line - b.line;
        return a.from - b.from;
      });
      return mentions;
    },
  };
};
