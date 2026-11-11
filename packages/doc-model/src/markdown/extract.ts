import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import { scanWikiLinks, type WikiLink } from '../links.ts';
import type { MarkdownRoot } from './pipeline.ts';

export interface ExtractedLink extends WikiLink {
  readonly line: number;
  readonly offset: number;
}

interface ExtractOptions {
  /** 正文在原文件中的偏移（frontmatter 长度） */
  readonly bodyOffset?: number;
  /** 正文首行在原文件中的行号（有 frontmatter 时为正数） */
  readonly bodyStartLine?: number;
}

/**
 * 从 mdast 提取 wikilink。
 * 只遍历 text 节点，因此代码块、行内代码、数学公式里的 `[[` 天然不会命中（vault-format §5.1）。
 */
export const extractLinks = (tree: MarkdownRoot, options: ExtractOptions = {}): readonly ExtractedLink[] => {
  const bodyOffset = options.bodyOffset ?? 0;
  const lineShift = (options.bodyStartLine ?? 1) - 1;
  const found: ExtractedLink[] = [];

  visit(tree, 'text', (node) => {
    const nodeOffset = node.position?.start.offset ?? 0;
    const nodeLine = node.position?.start.line ?? 1;
    for (const link of scanWikiLinks(node.value)) {
      const newlines = node.value.slice(0, link.start).split('\n').length - 1;
      found.push({
        ...link,
        line: nodeLine + lineShift + newlines,
        offset: bodyOffset + nodeOffset + link.start,
      });
    }
  });

  return found;
};

/** 文档纯文本（用于索引摘要与标题回退） */
export const toPlainText = (tree: MarkdownRoot): string => toString(tree).replace(/\s+/g, ' ').trim();
