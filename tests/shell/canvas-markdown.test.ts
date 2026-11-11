import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasNode } from '#canvas-engine';
import { planTextUpdate } from '../../src/shell/canvas/commands.ts';
import { resolveNodeTags } from '../../src/shell/canvas/node-tags.ts';
import { readingBlocks, readingPlainText } from '../../src/shell/canvas/read-markdown.ts';

const MARKDOWN = [
  '# 标题',
  '',
  '正文 **加粗** *斜体* `code`',
  '',
  '- 一',
  '- 二',
  '',
  '1. first',
  '2. second',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '> 引用',
  '',
  '[链接](https://example.com)',
].join('\n');

void test('阅读态解析：标题 / 段落 / 加粗 / 斜体 / 行内代码 / 列表 / 代码块 / 引用 / 链接', () => {
  const blocks = readingBlocks(MARKDOWN);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'paragraph'],
  );

  const heading = blocks[0];
  assert.equal(heading?.kind, 'heading');
  if (heading?.kind === 'heading') {
    assert.equal(heading.depth, 1);
    assert.deepEqual(heading.children, [{ kind: 'text', value: '标题' }]);
  }

  const paragraph = blocks[1];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    assert.deepEqual(
      paragraph.children.map((inline) => inline.kind),
      ['text', 'strong', 'text', 'emphasis', 'text', 'code'],
    );
    assert.deepEqual(paragraph.children[1], {
      kind: 'strong',
      children: [{ kind: 'text', value: '加粗' }],
    });
    assert.deepEqual(paragraph.children[3], {
      kind: 'emphasis',
      children: [{ kind: 'text', value: '斜体' }],
    });
    assert.deepEqual(paragraph.children[5], { kind: 'code', value: 'code' });
  }

  const bullet = blocks[2];
  assert.equal(bullet?.kind, 'list');
  if (bullet?.kind === 'list') {
    assert.equal(bullet.ordered, false);
    assert.equal(bullet.items.length, 2);
    assert.equal(readingPlainText(bullet.items[0] ?? []), '一');
  }

  const ordered = blocks[3];
  assert.equal(ordered?.kind, 'list');
  if (ordered?.kind === 'list') {
    assert.equal(ordered.ordered, true);
    assert.equal(ordered.start, 1);
  }

  assert.deepEqual(blocks[4], { kind: 'code', lang: 'ts', value: 'const a = 1;' });

  const quote = blocks[5];
  assert.equal(quote?.kind, 'quote');
  if (quote?.kind === 'quote') {
    assert.equal(readingPlainText(quote.children), '引用');
  }

  const link = blocks[6];
  assert.equal(link?.kind, 'paragraph');
  if (link?.kind === 'paragraph') {
    assert.deepEqual(link.children[0], {
      kind: 'link',
      href: 'https://example.com',
      children: [{ kind: 'text', value: '链接' }],
    });
  }
});

void test('HTML 块降级为文本，图片保留 src 与 alt', () => {
  const blocks = readingBlocks('<div>原始 HTML</div>\n\n![图片](https://example.com/a.png)');
  assert.equal(blocks[0]?.kind, 'text');
  if (blocks[0]?.kind === 'text') assert.match(blocks[0].value, /原始 HTML/);

  assert.equal(blocks[1]?.kind, 'paragraph');
  if (blocks[1]?.kind === 'paragraph') {
    assert.deepEqual(blocks[1].children, [
      { kind: 'image', src: 'https://example.com/a.png', alt: '图片' },
    ]);
  }
});

void test('双链：[[目标]] 与 [[目标|别名]] 拆成 clickable 目标，行内代码不参与', () => {
  const blocks = readingBlocks('见 [[项目A]] 与 [[docs/B|B 文档]]，以及 `[[代码]]`');
  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind !== 'paragraph') return;

  assert.deepEqual(
    paragraph.children.map((inline) => inline.kind),
    ['text', 'wiki', 'text', 'wiki', 'text', 'code'],
  );
  assert.deepEqual(paragraph.children[1], { kind: 'wiki', target: '项目A', label: '项目A' });
  assert.deepEqual(paragraph.children[3], { kind: 'wiki', target: 'docs/B', label: 'B 文档' });
  assert.equal(readingPlainText(blocks), '见 项目A 与 B 文档，以及 [[代码]]');
});

void test('链接文字里的双链不解析，避免按钮嵌进 <a>', () => {
  const blocks = readingBlocks('[见 [[内层]]](https://example.com)');
  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind !== 'paragraph') return;
  assert.deepEqual(paragraph.children[0], {
    kind: 'link',
    href: 'https://example.com',
    children: [{ kind: 'text', value: '见 [[内层]]' }],
  });
});

void test('空源码得到空渲染树，纯文本可用于空态判断', () => {
  assert.deepEqual(readingBlocks(''), []);
  assert.equal(readingPlainText(readingBlocks('   \n')), '');
});

void test('数学公式解析：行内 inlineMath 与块级 math 都保留原始 TeX', () => {
  const blocks = readingBlocks('行内 $a^2+b^2=c^2$ 公式\n\n$$\n\\int_0^1 x dx\n$$');
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'math']);

  const paragraph = blocks[0];
  assert.equal(paragraph?.kind, 'paragraph');
  if (paragraph?.kind === 'paragraph') {
    assert.deepEqual(paragraph.children.map((inline) => inline.kind), ['text', 'math', 'text']);
    assert.deepEqual(paragraph.children[1], { kind: 'math', value: 'a^2+b^2=c^2' });
  }

  assert.deepEqual(blocks[1], { kind: 'math', value: '\\int_0^1 x dx' });
  assert.equal(readingPlainText(blocks), '行内 a^2+b^2=c^2 公式\n\\int_0^1 x dx');
});

void test('GFM 表格解析：表头 / align / 数据行 / 单元格行内结构', () => {
  const blocks = readingBlocks(
    [
      '| 名称 | 数量 | 备注 |',
      '| :--- | ---: | :---: |',
      '| 甲 | 1 | **粗** |',
      '| 乙 | 2 | `c` |',
    ].join('\n'),
  );
  assert.equal(blocks.length, 1);

  const table = blocks[0];
  assert.equal(table?.kind, 'table');
  if (table?.kind !== 'table') return;

  assert.deepEqual(table.align, ['left', 'right', 'center']);
  assert.deepEqual(
    table.header.map((cell) => cell.map((inline) => inline.kind)),
    [['text'], ['text'], ['text']],
  );
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0]?.[2], [{ kind: 'strong', children: [{ kind: 'text', value: '粗' }] }]);
  assert.deepEqual(table.rows[1]?.[2], [{ kind: 'code', value: 'c' }]);
  assert.equal(readingPlainText(blocks), '名称 数量 备注\n甲 1 粗\n乙 2 c');
});

const noteNode: CanvasNode = {
  id: 'n_note',
  kind: 'note',
  rect: { x: 0, y: 0, w: 200, h: 120 },
  z: 0,
  docId: null,
  text: '旧内容',
  groupId: null,
  meta: { tags: ['alpha', '', '  beta  ', 42, null] },
};

void test('note 标签取 meta.tags：即时反映数组内容，过滤非字符串与空串', () => {
  assert.deepEqual(resolveNodeTags(noteNode.kind, noteNode.meta, undefined), ['alpha', 'beta']);
  // 同一节点换一组标签（例如菜单写入 meta）后下一次渲染立即拿到新值
  assert.deepEqual(
    resolveNodeTags('note', { ...noteNode.meta, tags: ['新标签', 'second'] }, undefined),
    ['新标签', 'second'],
  );
  assert.deepEqual(resolveNodeTags('note', {}, undefined), []);
});

void test('doc 标签取文档 tags，组节点不渲染标签', () => {
  assert.deepEqual(resolveNodeTags('doc', { tags: ['meta 不生效'] }, ['文档标签']), ['文档标签']);
  assert.deepEqual(resolveNodeTags('group', { tags: ['忽略'] }, undefined), []);
});

void test('退出编辑（Esc / 失焦 / ⌘Enter 共用）保存当前草稿，不丢未保存内容', () => {
  const draft = '# 未保存的标题\n\n正文';
  const planned = planTextUpdate(noteNode, draft);
  assert.deepEqual(planned, { id: 'n_note', text: draft });
  // 内容未改时无需写盘
  assert.equal(planTextUpdate(noteNode, '旧内容'), null);
  assert.equal(planTextUpdate(undefined, draft), null);
});
