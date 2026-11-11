import type { DocId, VaultPath } from './ids.ts';
import { pathLookupKey, stem } from './path.ts';

/** 一个 `[[...]]` 词法单元 */
export interface WikiLink {
  readonly embed: boolean;
  readonly target: string;
  readonly label: string | null;
  readonly anchor: string | null;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export type LinkResolver = 'path' | 'basename' | 'title' | 'alias' | 'ambiguous' | 'unresolved';

export interface LinkTarget {
  readonly id: DocId;
  readonly path: VaultPath;
  readonly title: string;
  readonly aliases: readonly string[];
}

export interface ResolutionIndex {
  /** pathLookupKey（大小写折叠 + NFC）→ 候选集；多候选 = 折叠冲突，登记 ambiguous（§5.2） */
  readonly byPath: ReadonlyMap<string, readonly LinkTarget[]>;
  readonly byBasename: ReadonlyMap<string, readonly LinkTarget[]>;
  readonly byTitle: ReadonlyMap<string, readonly LinkTarget[]>;
  readonly byAlias: ReadonlyMap<string, readonly LinkTarget[]>;
}

export interface ResolvedLink extends WikiLink {
  readonly resolver: LinkResolver;
  readonly targetId: DocId | null;
  readonly candidates: readonly DocId[];
}

const MAX_INNER = 512;

/** 标题/别名归一化：NFKC + 小写 + 折叠空白（vault-format §5.2） */
export const normalizeLinkKey = (value: string): string =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** 扫描一段文本中的 wikilink；代码块/行内代码的排除由 AST 提取层负责 */
export const scanWikiLinks = (text: string): readonly WikiLink[] => {
  const links: WikiLink[] = [];
  let cursor = 0;

  while (cursor < text.length - 1) {
    const open = text.indexOf('[[', cursor);
    if (open < 0) break;
    if (open > 0 && text.charAt(open - 1) === '\\') {
      cursor = open + 2;
      continue;
    }
    const close = text.indexOf(']]', open + 2);
    if (close < 0) break;

    const inner = text.slice(open + 2, close);
    if (inner.length === 0 || inner.length > MAX_INNER || inner.includes('[[')) {
      cursor = open + 2;
      continue;
    }

    const embed = open > 0 && text.charAt(open - 1) === '!' && !(open > 1 && text.charAt(open - 2) === '\\');
    const pipe = inner.indexOf('|');
    const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const label = pipe >= 0 ? inner.slice(pipe + 1) : null;
    const hash = targetPart.indexOf('#');
    const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const anchor = hash >= 0 ? targetPart.slice(hash + 1).trim() : null;

    const start = embed ? open - 1 : open;
    const end = close + 2;
    links.push({
      embed,
      target,
      label,
      anchor: anchor === '' ? null : anchor,
      raw: text.slice(start, end),
      start,
      end,
    });
    cursor = close + 2;
  }

  return links;
};

const pushCandidate = (
  map: Map<string, LinkTarget[]>,
  key: string,
  target: LinkTarget,
): void => {
  if (key === '') return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [target]);
  } else {
    existing.push(target);
  }
};

/** 建立解析索引：路径、文件名、标题、别名四个键空间 */
export const buildResolutionIndex = (targets: readonly LinkTarget[]): ResolutionIndex => {
  const byPath = new Map<string, LinkTarget[]>();
  const byBasename = new Map<string, LinkTarget[]>();
  const byTitle = new Map<string, LinkTarget[]>();
  const byAlias = new Map<string, LinkTarget[]>();

  for (const target of targets) {
    const pathKey = pathLookupKey(String(target.path));
    // 大小写折叠键冲突不静默 last-wins：登记为多候选，解析时按 ambiguous 处理（§5.2）
    pushCandidate(byPath, pathKey, target);
    if (pathKey.endsWith('.md')) pushCandidate(byPath, pathKey.slice(0, -3), target);
    pushCandidate(byBasename, normalizeLinkKey(stem(target.path)), target);
    pushCandidate(byTitle, normalizeLinkKey(target.title), target);
    for (const alias of target.aliases) pushCandidate(byAlias, normalizeLinkKey(alias), target);
  }

  return { byPath, byBasename, byTitle, byAlias };
};

/** 文件名级多命中：最短路径优先，并列取字典序最小（vault-format §5.2） */
const pickShortest = (candidates: readonly LinkTarget[]): LinkTarget => {
  const sorted = [...candidates].sort((left, right) => {
    const leftPath = String(left.path);
    const rightPath = String(right.path);
    return leftPath.length - rightPath.length || leftPath.localeCompare(rightPath);
  });
  const winner = sorted[0];
  if (winner === undefined) throw new Error('pickShortest 收到空候选');
  return winner;
};

const resolveByCandidates = (
  link: WikiLink,
  candidates: readonly LinkTarget[],
  resolver: 'basename' | 'title' | 'alias',
): ResolvedLink => {
  const first = candidates[0];
  if (first === undefined) {
    return { ...link, resolver: 'unresolved', targetId: null, candidates: [] };
  }
  if (resolver === 'basename') {
    const winner = pickShortest(candidates);
    return { ...link, resolver, targetId: winner.id, candidates: candidates.map((item) => item.id) };
  }
  if (candidates.length > 1) {
    return {
      ...link,
      resolver: 'ambiguous',
      targetId: null,
      candidates: candidates.map((item) => item.id),
    };
  }
  return { ...link, resolver, targetId: first.id, candidates: [first.id] };
};

/** 解析顺序：显式路径 → 文件名 → 标题 → 别名 → 未解析 */
export const resolveLink = (link: WikiLink, index: ResolutionIndex): ResolvedLink => {
  const key = normalizeLinkKey(link.target);
  const looksLikePath = link.target.includes('/') || link.target.toLowerCase().endsWith('.md');

  if (key !== '' && looksLikePath) {
    const hits = index.byPath.get(pathLookupKey(link.target)) ?? [];
    if (hits.length === 1) {
      const hit = hits[0] as LinkTarget;
      return { ...link, resolver: 'path', targetId: hit.id, candidates: [hit.id] };
    }
    if (hits.length > 1) {
      // 折叠冲突（如 notes/A.md 与 notes/a.md 共存）：不静默决胜，登记 ambiguous
      return {
        ...link,
        resolver: 'ambiguous',
        targetId: null,
        candidates: hits.map((item) => item.id),
      };
    }
  }

  if (key !== '') {
    // Obsidian 兼容（vault-format §5.2）：`[[文件.md]]` 与 `[[文件]]` 等价——
    // 文件名/标题/别名三个键空间登记的都是无扩展名形式，匹配前先剥掉 `.md` 后缀。
    const stemKey = key.endsWith('.md') ? key.slice(0, -3).trim() : key;
    const byBasename = index.byBasename.get(stemKey) ?? [];
    if (byBasename.length > 0) return resolveByCandidates(link, byBasename, 'basename');

    const byTitle = index.byTitle.get(stemKey) ?? [];
    if (byTitle.length > 0) return resolveByCandidates(link, byTitle, 'title');

    const byAlias = index.byAlias.get(stemKey) ?? [];
    if (byAlias.length > 0) return resolveByCandidates(link, byAlias, 'alias');
  }

  return { ...link, resolver: 'unresolved', targetId: null, candidates: [] };
};
