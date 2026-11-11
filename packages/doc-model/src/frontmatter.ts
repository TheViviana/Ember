/**
 * frontmatter 的语义模型（vault-format §4）。
 * 这里只做「已解析对象 → 规范模型」的归一化与诊断，YAML 文本解析在 markdown/pipeline 一侧。
 */
export interface Frontmatter {
  readonly id: string | null;
  readonly title: string | null;
  /** 文章简介，可缺失；缺失时展示层按正文首段派生，不回写磁盘（vault-format §4.2 / kernel-contract D8） */
  readonly summary: string | null;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  readonly created: string | null;
  readonly updated: string | null;
  readonly ember: Readonly<Record<string, unknown>>;
  readonly extra: Readonly<Record<string, unknown>>;
}

export type FrontmatterIssueCode =
  | 'id_invalid'
  | 'title_invalid'
  | 'summary_invalid'
  | 'tags_invalid'
  | 'aliases_invalid'
  | 'created_invalid'
  | 'updated_invalid'
  | 'ember_invalid';

export interface FrontmatterIssue {
  readonly code: FrontmatterIssueCode;
  readonly key: string;
  readonly detail: string;
}

export interface NormalizeResult {
  readonly frontmatter: Frontmatter;
  readonly issues: readonly FrontmatterIssue[];
}

export const TITLE_MAX = 512;
export const SUMMARY_MAX = 280;
export const ALIAS_MAX = 256;
/** tags 每项与 aliases 同一上限（vault-format §4.3） */
export const TAG_MAX = 256;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const RESERVED_KEYS = new Set(['id', 'title', 'summary', 'tags', 'aliases', 'created', 'updated', 'ember']);

export const emptyFrontmatter = (): Frontmatter => ({
  id: null,
  title: null,
  summary: null,
  tags: [],
  aliases: [],
  created: null,
  updated: null,
  ember: {},
  extra: {},
});

const isIsoTimestamp = (value: string): boolean => ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));

const readStringArray = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result;
};

const normalizeTag = (tag: string): string => tag.replace(/^#+/, '').normalize('NFC').trim();

/** 把任意键值对象归一化为 Frontmatter。未知键与取值非法的保留键都进入 extra 原样保留
 * （vault-format §4.4「保留原值」+ P2「未知内容不丢弃」）：kernel 重写整份 frontmatter 时
 * 不会把用户手写的值从磁盘上静默删除，取值在修正前不参与语义。 */
export const normalizeFrontmatter = (raw: Readonly<Record<string, unknown>>): NormalizeResult => {
  const issues: FrontmatterIssue[] = [];
  const extra: Record<string, unknown> = {};

  const rawId = raw['id'];
  let id: string | null = null;
  if (rawId !== undefined && rawId !== null) {
    if (typeof rawId === 'string' && ULID_PATTERN.test(rawId)) {
      id = rawId;
    } else {
      issues.push({ code: 'id_invalid', key: 'id', detail: 'id 必须是 26 位 Crockford Base32 ULID' });
      extra['id'] = rawId;
    }
  }

  const rawTitle = raw['title'];
  let title: string | null = null;
  if (rawTitle !== undefined && rawTitle !== null) {
    if (typeof rawTitle === 'string' && rawTitle.length <= TITLE_MAX) {
      title = rawTitle;
    } else {
      issues.push({ code: 'title_invalid', key: 'title', detail: `title 必须是不超过 ${TITLE_MAX} 字符的字符串` });
      extra['title'] = rawTitle;
    }
  }

  const rawSummary = raw['summary'];
  let summary: string | null = null;
  if (rawSummary !== undefined && rawSummary !== null) {
    if (typeof rawSummary === 'string' && rawSummary.length <= SUMMARY_MAX) {
      summary = rawSummary;
    } else {
      issues.push({
        code: 'summary_invalid',
        key: 'summary',
        detail: `summary 必须是不超过 ${SUMMARY_MAX} 字符的字符串`,
      });
      extra['summary'] = rawSummary;
    }
  }

  const rawTags = raw['tags'];
  let tags: readonly string[] = [];
  if (rawTags !== undefined && rawTags !== null) {
    const parsed = readStringArray(rawTags);
    if (parsed === null) {
      issues.push({ code: 'tags_invalid', key: 'tags', detail: 'tags 必须是字符串数组' });
      extra['tags'] = rawTags;
    } else if (parsed.map(normalizeTag).some((tag) => tag.length > TAG_MAX)) {
      issues.push({ code: 'tags_invalid', key: 'tags', detail: `单个标签不能超过 ${TAG_MAX} 字符` });
      extra['tags'] = rawTags;
    } else {
      tags = parsed.map(normalizeTag).filter((tag) => tag !== '');
    }
  }

  const rawAliases = raw['aliases'];
  let aliases: readonly string[] = [];
  if (rawAliases !== undefined && rawAliases !== null) {
    const parsed = readStringArray(rawAliases);
    if (parsed === null) {
      issues.push({ code: 'aliases_invalid', key: 'aliases', detail: 'aliases 必须是字符串数组' });
      extra['aliases'] = rawAliases;
    } else if (parsed.some((alias) => alias.length > ALIAS_MAX)) {
      issues.push({ code: 'aliases_invalid', key: 'aliases', detail: `单个别名不能超过 ${ALIAS_MAX} 字符` });
      extra['aliases'] = rawAliases;
    } else {
      aliases = parsed;
    }
  }

  const rawCreated = raw['created'];
  let created: string | null = null;
  if (rawCreated !== undefined && rawCreated !== null) {
    if (typeof rawCreated === 'string' && isIsoTimestamp(rawCreated)) {
      created = rawCreated;
    } else {
      issues.push({ code: 'created_invalid', key: 'created', detail: 'created 必须是带时区的 ISO-8601' });
      extra['created'] = rawCreated;
    }
  }

  const rawUpdated = raw['updated'];
  let updated: string | null = null;
  if (rawUpdated !== undefined && rawUpdated !== null) {
    if (typeof rawUpdated === 'string' && isIsoTimestamp(rawUpdated)) {
      updated = rawUpdated;
    } else {
      issues.push({ code: 'updated_invalid', key: 'updated', detail: 'updated 必须是带时区的 ISO-8601' });
      extra['updated'] = rawUpdated;
    }
  }

  const rawEmber = raw['ember'];
  let ember: Readonly<Record<string, unknown>> = {};
  if (rawEmber !== undefined && rawEmber !== null) {
    if (typeof rawEmber === 'object' && !Array.isArray(rawEmber)) {
      ember = { ...(rawEmber as Readonly<Record<string, unknown>>) };
    } else {
      issues.push({ code: 'ember_invalid', key: 'ember', detail: 'ember 必须是键值对象' });
      extra['ember'] = rawEmber;
    }
  }

  for (const key of Object.keys(raw)) {
    if (!RESERVED_KEYS.has(key)) {
      // defineProperty 建立自有属性：`__proto__` 这类键按普通未知键保留，
      // 普通赋值会触发原型 setter 把键静默丢掉（违反「未知键保留」I12）
      Object.defineProperty(extra, key, {
        value: raw[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return { frontmatter: { id, title, summary, tags, aliases, created, updated, ember, extra }, issues };
};

/** 规范序列化顺序：id,title,summary,tags,aliases,created,updated,ember.*,其余键字母序（vault-format §4.4） */
export const toSerializable = (frontmatter: Frontmatter): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (frontmatter.id !== null) out['id'] = frontmatter.id;
  if (frontmatter.title !== null) out['title'] = frontmatter.title;
  if (frontmatter.summary !== null && frontmatter.summary !== '') out['summary'] = frontmatter.summary;
  if (frontmatter.tags.length > 0) out['tags'] = [...frontmatter.tags];
  if (frontmatter.aliases.length > 0) out['aliases'] = [...frontmatter.aliases];
  if (frontmatter.created !== null) out['created'] = frontmatter.created;
  if (frontmatter.updated !== null) out['updated'] = frontmatter.updated;
  if (Object.keys(frontmatter.ember).length > 0) out['ember'] = { ...frontmatter.ember };
  for (const key of Object.keys(frontmatter.extra).sort()) {
    // 同 read 侧：未知键用 defineProperty 落自有属性，__proto__ 不丢
    Object.defineProperty(out, key, {
      value: frontmatter.extra[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
};
