export interface FrontmatterSplit {
  /** frontmatter 内容（不含两侧 ---），无 frontmatter 时为 null */
  readonly raw: string | null;
  /** 正文（frontmatter 之后的全部字节） */
  readonly body: string;
  /** 正文在原文本中的起始偏移 */
  readonly bodyOffset: number;
  readonly hasBom: boolean;
}

const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 按字节切分 frontmatter 与正文。
 * 本函数不做语义重排，正文切片原样返回；BOM 与行尾风格由 doc-service 在写回时还原
 * （vault-format §4.6：语义级保真，非字节级）。
 */
export const splitFrontmatter = (text: string): FrontmatterSplit => {
  const hasBom = text.startsWith('\uFEFF');
  const bomOffset = hasBom ? 1 : 0;
  const rest = text.slice(bomOffset);
  const match = BLOCK.exec(rest);
  if (match === null) {
    return { raw: null, body: text, bodyOffset: 0, hasBom };
  }
  const bodyOffset = bomOffset + match[0].length;
  return {
    raw: match[1] ?? '',
    body: text.slice(bodyOffset),
    bodyOffset,
    hasBom,
  };
};

/** 重新组装文件文本：frontmatter 块 + 正文 */
export const joinFrontmatter = (yamlBody: string, body: string): string =>
  `---\n${yamlBody.replace(/\r?\n$/, '')}\n---\n${body}`;
