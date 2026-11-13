import {
  normalizeFrontmatter,
  splitFrontmatter,
  unsafeContentHash,
  type ContentHash,
  type Frontmatter,
  type FrontmatterIssue,
} from '#doc-model';
import { parse as parseYaml } from 'yaml';

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
