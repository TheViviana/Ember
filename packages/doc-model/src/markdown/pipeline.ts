import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * 唯一 Markdown 解析管线（内核契约 I11）。
 * 任何新的 Markdown 语法支持都必须加在这里，禁止引入第二套解析器。
 */
const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath);

export type MarkdownProcessor = typeof markdownProcessor;
export type MarkdownRoot = ReturnType<MarkdownProcessor['parse']>;

export const parseMarkdown = (markdown: string): MarkdownRoot => markdownProcessor.parse(markdown);
