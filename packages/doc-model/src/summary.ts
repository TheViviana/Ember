/**
 * 文章简介的派生规则（vault-format §4.2 / kernel-contract §3 D8）。
 *
 * 只在 frontmatter 没有 `summary` 时用于展示，**不回写磁盘**。
 * 取正文第一个非空段落，跳过标题行、列表符号、代码块与图片，剥掉常见 Markdown 标记。
 */

export const SUMMARY_DERIVE_MAX = 120;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;
const LIST_MARKER = /^([-*+]|\d+\.)\s/;

/** 把正文首段压成一行纯文本；无可用内容时返回空串 */
export const deriveSummary = (body: string): string => {
  const paragraph: string[] = [];
  let inFence = false;

  for (const line of body.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    if (trimmed === '') {
      if (paragraph.length > 0) break;
      continue;
    }
    if (HEADING.test(trimmed) || LIST_MARKER.test(trimmed)) continue;
    paragraph.push(trimmed);
  }

  const text = paragraph
    .join(' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const chars = Array.from(text);
  return chars.length > SUMMARY_DERIVE_MAX ? `${chars.slice(0, SUMMARY_DERIVE_MAX).join('')}…` : text;
};
