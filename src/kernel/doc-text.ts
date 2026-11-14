import {
  normalizeFrontmatter,
  splitFrontmatter,
  unsafeContentHash,
  type ContentHash,
  type Frontmatter,
  type FrontmatterIssue,
} from '#doc-model';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** 严格解码只用于探测非 UTF-8：fatal 遇到非法序列直接抛，不会产生 U+FFFD */
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

/** 目录与编辑器统一使用 canonical 文本：去掉 BOM、CRLF 归一为 LF */
export const canonicalText = (text: string): string =>
  (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n/g, '\n');

export const isUtf8 = (bytes: Uint8Array): boolean => {
  try {
    strictDecoder.decode(bytes);
    return true;
  } catch {
    // 探测分支：解码失败就是「非 UTF-8」这一正常判断结果，不是异常，不应记日志
    return false;
  }
};

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const hashBytes = async (bytes: Uint8Array): Promise<ContentHash> => {
  const view = new Uint8Array(bytes);
  return unsafeContentHash(`sha256:${toHex(await crypto.subtle.digest('SHA-256', view))}`);
};

export const utcNow = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface ParsedDocText {
  readonly frontmatter: Frontmatter;
  readonly body: string;
  /** frontmatter 块存在但 YAML 语法非法：整段原文按 body 降级保留，文档等待 adoption */
  readonly frontmatterBroken: boolean;
  /** 取值非法的保留键（原值已在 extra 中保留，修正前不参与语义） */
  readonly issues: readonly FrontmatterIssue[];
}

export const parseDocText = (text: string): ParsedDocText => {
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
  } catch (error) {
    console.error(
      'frontmatter YAML 解析失败，按无 frontmatter 降级保留原文：',
      error instanceof Error ? error.message : String(error),
    );
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

export interface FrontmatterTextPatch {
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly tags?: readonly string[] | null;
  readonly aliases?: readonly string[] | null;
}

type FrontmatterPatchEntry = readonly [
  key: 'title' | 'summary' | 'tags' | 'aliases',
  value: string | readonly string[] | null | undefined,
];

/** 显式列出键，避免 Object.entries 把 patch 值退化成 any */
const patchEntries = (patch: FrontmatterTextPatch): readonly FrontmatterPatchEntry[] => [
  ['title', patch.title],
  ['summary', patch.summary],
  ['tags', patch.tags],
  ['aliases', patch.aliases],
];

const TOP_LEVEL_KEY = /^([A-Za-z0-9_-]+)[ \t]*:/;

const serializeKey = (key: string, value: string | readonly string[]): readonly string[] =>
  stringifyYaml({ [key]: value }, { lineWidth: 0 })
    .replace(/\n$/, '')
    .split('\n');

/**
 * 只在 frontmatter 块内替换被显式编辑的顶层键，其余行（键序、注释、引号）逐字节保留（D8）。
 * 没有 frontmatter 时，仅当显式提供了非空值才新建块。
 */
export const patchFrontmatterRegion = (rawText: string, patch: FrontmatterTextPatch): string => {
  const split = splitFrontmatter(rawText);
  const bom = split.hasBom ? '\uFEFF' : '';

  if (split.raw === null) {
    const present: (readonly [string, string | readonly string[]])[] = [];
    for (const [key, value] of patchEntries(patch)) {
      if (value !== null && value !== undefined) present.push([key, value]);
    }
    if (present.length === 0) return rawText;
    const yaml = stringifyYaml(Object.fromEntries(present), { lineWidth: 0 }).replace(/\n$/, '');
    return `${bom}---\n${yaml}\n---\n${split.body}`;
  }

  const eol = split.raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = split.raw.split(/\r?\n/);
  const ranges: { readonly key: string; readonly start: number; readonly end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = TOP_LEVEL_KEY.exec(lines[index] ?? '');
    if (match === null) continue;
    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end] ?? '';
      if (line.startsWith(' ') || line.startsWith('\t') || line.startsWith('- ') || line.trim() === '') {
        end += 1;
        continue;
      }
      break;
    }
    ranges.push({ key: match[1] ?? '', start: index, end });
    index = end - 1;
  }

  const replacements: { readonly start: number; readonly end: number; readonly lines: readonly string[] }[] = [];
  const appended: string[] = [];
  for (const [key, value] of patchEntries(patch)) {
    if (value === undefined) continue;
    const range = ranges.find((item) => item.key === key);
    if (value === null) {
      if (range !== undefined) replacements.push({ start: range.start, end: range.end, lines: [] });
      continue;
    }
    const serialized = serializeKey(key, value);
    if (range !== undefined) replacements.push({ start: range.start, end: range.end, lines: serialized });
    else appended.push(...serialized);
  }

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    lines.splice(replacement.start, replacement.end - replacement.start, ...replacement.lines);
  }
  lines.push(...appended);
  return `${bom}---${eol}${lines.join(eol)}${eol}---${eol}${split.body}`;
};

/**
 * 只替换正文区：frontmatter、BOM 与块结束符取自磁盘原文的字节切片，不做任何重排。
 * 正文按文件既有行尾风格还原（混合行尾沿用历史行为，统一写 LF）。
 */
export const replaceBodyRegion = (rawText: string, body: string, eol: 'lf' | 'crlf' | 'mixed'): string => {
  const split = splitFrontmatter(rawText);
  const prefix = split.raw === null ? (split.hasBom ? '\uFEFF' : '') : rawText.slice(0, split.bodyOffset);
  const styled = eol === 'crlf' ? body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : body;
  return prefix + styled;
};
