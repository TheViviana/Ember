import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLinks } from '../../packages/doc-model/src/markdown/extract.ts';
import { parseMarkdown } from '../../packages/doc-model/src/markdown/pipeline.ts';
import { splitFrontmatter } from '../../packages/doc-model/src/markdown/split.ts';

void test('frontmatter 切分保留正文偏移', () => {
  const text = '---\nid: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2\n---\n正文 [[链接]]\n';
  const split = splitFrontmatter(text);
  assert.equal(split.raw, 'id: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
  assert.equal(split.body, '正文 [[链接]]\n');
  assert.equal(text.slice(split.bodyOffset), split.body);
});

void test('无 frontmatter 时正文就是全文', () => {
  const split = splitFrontmatter('# 标题\n');
  assert.equal(split.raw, null);
  assert.equal(split.bodyOffset, 0);
});

void test('只从 text 节点提取，代码与公式中的 [[ 不命中', () => {
  const markdown = [
    '正文 [[目标]] 与 [[目标#小节|别名]]',
    '',
    '```ts',
    'const a = "[[代码块]]";',
    '```',
    '',
    '行内 `[[行内代码]]` 与公式 $[[公式]]$',
  ].join('\n');
  const links = extractLinks(parseMarkdown(markdown));
  assert.deepEqual(
    links.map((link) => link.target),
    ['目标', '目标'],
  );
  assert.equal(links[0]?.line, 1);
  assert.equal(links[1]?.label, '别名');
});

void test('行号随 frontmatter 偏移', () => {
  const text = '---\nid: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2\n---\n\n正文 [[目标]]\n';
  const split = splitFrontmatter(text);
  const bodyStartLine = text.slice(0, split.bodyOffset).split('\n').length;
  const links = extractLinks(parseMarkdown(split.body), {
    bodyOffset: split.bodyOffset,
    bodyStartLine,
  });
  assert.equal(links[0]?.line, 5);
  assert.equal(links[0]?.offset, text.indexOf('[[目标]]'));
});
