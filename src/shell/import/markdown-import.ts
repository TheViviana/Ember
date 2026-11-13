import { normalizePath, splitFrontmatter } from '#doc-model';
import { parse as parseYaml } from 'yaml';

/**
 * 导入 Markdown 的纯函数层：只做筛选、解析、目标路径规划，不读盘不写盘。
 * 写盘统一走 kernel.docs.create（I1：磁盘写入的唯一入口），本模块只产出计划。
 *
 * 规则（与已批准方案一致）：
 * - 只吃 .md / .markdown，目标目录固定为 notes/，保留所选目录内的相对层级；
 *   `.markdown` 统一落为 `.md`，库里不出现两种后缀的同一篇文档；
 * - 跳过 media/ 与 .workbench/ 下的文件；
 * - 单篇上限见 `MAX_IMPORT_MB`，单次上限见 `MAX_IMPORT_FILES`，超出逐条给出拒绝原因；
 * - 未知 frontmatter 键丢弃，但逐条记录名字，结果里必须能看见；
 * - 不做内容去重，只按目标路径防覆盖（同名加 -2 / -3 后缀）。
 */

export const IMPORT_ACCEPT = '.md,.markdown,text/markdown';
export const IMPORT_ROOT = 'notes';
/** 单篇导入上限：MB 数值是唯一来源，字节上限与 UI 文案都由它派生 */
export const MAX_IMPORT_MB = 5;
export const MAX_IMPORT_BYTES = MAX_IMPORT_MB * 1024 * 1024;
export const MAX_IMPORT_FILES = 200;

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown']);
const SKIP_SEGMENTS: ReadonlySet<string> = new Set(['media', '.workbench']);
/** create 会重写整个 frontmatter，只认这四个语义键 + 身份键；其余视为未知 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'summary',
  'tags',
  'aliases',
  'created',
  'updated',
  'ember',
]);

export interface ImportCandidate {
  /** 选择时的相对路径：单文件为文件名，文件夹为「目录/子路径/文件」 */
  readonly relativePath: string;
  readonly text: string;
  /** 原始字节数（File.size） */
  readonly bytes: number;
}

export interface ImportEntry {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly title: string;
  /** 正文（不含 frontmatter） */
  readonly text: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly summary: string | null;
  /** 被丢弃的未知 frontmatter 键，按字典序 */
  readonly discardedKeys: readonly string[];
}

export interface ImportRejection {
  readonly sourcePath: string;
  readonly reason: string;
}

export interface ImportPlan {
  readonly entries: readonly ImportEntry[];
  readonly rejected: readonly ImportRejection[];
}

type ParsedImport =
  | {
      readonly ok: true;
      readonly title: string;
      readonly text: string;
      readonly tags: readonly string[];
      readonly aliases: readonly string[];
      readonly summary: string | null;
      readonly discardedKeys: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};

const stemOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
};

/** 首个 H1：跳过围栏代码块，去尾部闭合 # */
export const firstHeading = (body: string): string | null => {
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0] ?? null;
    if (marker !== null) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const text = heading?.[1]?.trim() ?? '';
    if (text.length > 0) return text;
  }
  return null;
};

const stringList = (value: unknown, stripHash: boolean): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = stripHash ? item.trim().replace(/^#/, '') : item.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(normalized);
  }
  return list;
};

/**
 * 解析单篇：frontmatter 取 title/tags/aliases/summary，未知键记录后丢弃；
 * 标题三级回退：frontmatter.title → 首个 H1 → 文件名。
 */
export const parseImportText = (relativePath: string, text: string): ParsedImport => {
  const split = splitFrontmatter(text);
  let raw: unknown = null;
  if (split.raw !== null) {
    try {
      raw = parseYaml(split.raw);
    } catch (error) {
      return { ok: false, reason: `frontmatter 无法解析：${errorText(error)}` };
    }
  }

  const record =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Readonly<Record<string, unknown>>)
      : null;
  if (raw !== null && record === null) {
    return { ok: false, reason: 'frontmatter 不是键值映射' };
  }

  const rawTitle = record?.['title'];
  const frontmatterTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  const heading = firstHeading(split.body);
  const title = frontmatterTitle.length > 0 ? frontmatterTitle : (heading ?? stemOf(relativePath));

  const rawSummary = record?.['summary'];
  const summary = typeof rawSummary === 'string' && rawSummary.trim().length > 0 ? rawSummary.trim() : null;
  const discardedKeys = record === null
    ? []
    : Object.keys(record).filter((key) => !KNOWN_KEYS.has(key)).sort((left, right) => left.localeCompare(right));

  return {
    ok: true,
    title,
    text: split.body,
    tags: stringList(record?.['tags'], true),
    aliases: stringList(record?.['aliases'], false),
    summary,
    discardedKeys,
  };
};

/** 路径安全：去掉首段目录名（文件夹导入时），拒绝 .. 与空段 */
const relativeSegments = (path: string, stripRoot: boolean): readonly string[] | null => {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0) return null;
  const kept = stripRoot ? segments.slice(1) : segments;
  if (kept.length === 0) return null;
  if (kept.some((segment) => segment === '..')) return null;
  return kept;
};

const withSuffix = (path: string, suffix: number): string => {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return `${dir}${base}-${String(suffix)}`;
  return `${dir}${base.slice(0, dot)}-${String(suffix)}${base.slice(dot)}`;
};

/**
 * 生成导入计划。`existingPaths` 传库内已有文档路径（小写比较，兼容大小写不敏感文件系统）。
 * `stripRoot` 为 true 时丢掉路径首段（文件夹选择会带上所选目录名）。
 */
export const buildImportPlan = (
  candidates: readonly ImportCandidate[],
  existingPaths: readonly string[],
  stripRoot: boolean,
): ImportPlan => {
  const occupied = new Set(existingPaths.map((path) => path.toLowerCase()));
  const entries: ImportEntry[] = [];
  const rejected: ImportRejection[] = [];
  const seenSources = new Set<string>();

  for (const candidate of [...candidates].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const sourcePath = candidate.relativePath.replace(/\\/g, '/');

    if (seenSources.has(sourcePath)) {
      rejected.push({ sourcePath, reason: '同一文件被重复选择' });
      continue;
    }
    seenSources.add(sourcePath);

    const segments = relativeSegments(sourcePath, stripRoot);
    if (segments === null) {
      rejected.push({ sourcePath, reason: '相对路径不合法（含 .. 或空路径）' });
      continue;
    }
    if (segments.some((segment) => SKIP_SEGMENTS.has(segment.toLowerCase()))) {
      const skipped = segments.find((segment) => SKIP_SEGMENTS.has(segment.toLowerCase())) ?? '';
      rejected.push({ sourcePath, reason: `位于 ${skipped}/，不导入` });
      continue;
    }
    if (segments.some((segment) => segment.startsWith('.'))) {
      rejected.push({ sourcePath, reason: '隐藏文件或隐藏目录，不导入' });
      continue;
    }
    if (!MARKDOWN_EXTENSIONS.has(extensionOf(sourcePath))) {
      rejected.push({ sourcePath, reason: '不是 .md / .markdown 文件' });
      continue;
    }
    if (candidate.bytes > MAX_IMPORT_BYTES) {
      rejected.push({ sourcePath, reason: `超过单篇 ${String(MAX_IMPORT_MB)} MB 上限` });
      continue;
    }
    if (entries.length >= MAX_IMPORT_FILES) {
      rejected.push({ sourcePath, reason: `超过单次 ${String(MAX_IMPORT_FILES)} 篇上限` });
      continue;
    }

    const parsed = parseImportText(sourcePath, candidate.text);
    if (!parsed.ok) {
      rejected.push({ sourcePath, reason: parsed.reason });
      continue;
    }

    // 目标统一 .md 后缀：Rust 扫描与目录对账只认 .md，.markdown 落盘会变成不可见的幽灵文件
    const fileName = `${stemOf(segments[segments.length - 1] ?? '')}.md`;
    const wanted = `${IMPORT_ROOT}/${[...segments.slice(0, -1), fileName].join('/')}`;
    const normalized = normalizePath(wanted);
    if (!normalized.ok) {
      rejected.push({ sourcePath, reason: '目标路径不合法' });
      continue;
    }
    let targetPath = String(normalized.value);
    for (let attempt = 2; occupied.has(targetPath.toLowerCase()); attempt += 1) {
      if (attempt > 50) break;
      targetPath = withSuffix(String(normalized.value), attempt);
    }
    if (occupied.has(targetPath.toLowerCase())) {
      rejected.push({ sourcePath, reason: '同名文件过多，无法确定目标路径' });
      continue;
    }
    occupied.add(targetPath.toLowerCase());

    entries.push({
      sourcePath,
      targetPath,
      title: parsed.title,
      text: parsed.text,
      tags: parsed.tags,
      aliases: parsed.aliases,
      summary: parsed.summary,
      discardedKeys: parsed.discardedKeys,
    });
  }

  return { entries, rejected };
};
