import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImportPlan,
  firstHeading,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  parseImportText,
  type ImportCandidate,
} from '../../src/shell/import/markdown-import.ts';

const candidate = (relativePath: string, text: string, bytes = text.length): ImportCandidate => ({
  relativePath,
  text,
  bytes,
});

void test('导入：只吃 .md/.markdown，跳过 media、.workbench 与隐藏文件', () => {
  const plan = buildImportPlan(
    [
      candidate('a.md', '# A'),
      candidate('sub/b.markdown', '# B'),
      candidate('a.txt', 'no'),
      candidate('media/c.md', '# C'),
      candidate('media2/d.md', '# D'),
      candidate('folder/.workbench/e.md', '# E'),
      candidate('.hidden/f.md', '# F'),
    ],
    [],
    false,
  );

  assert.deepEqual(
    plan.entries.map((entry) => entry.targetPath),
    ['notes/a.md', 'notes/media2/d.md', 'notes/sub/b.md'],
  );
  assert.deepEqual(
    plan.rejected.map((item) => [item.sourcePath, item.reason]),
    [
      ['.hidden/f.md', '隐藏文件或隐藏目录，不导入'],
      ['a.txt', '不是 .md / .markdown 文件'],
      ['folder/.workbench/e.md', '位于 .workbench/，不导入'],
      ['media/c.md', '位于 media/，不导入'],
    ],
  );
});

void test('导入：.markdown 统一落为 .md，与既有 .md 同名时加后缀', () => {
  const plan = buildImportPlan(
    [candidate('c.markdown', '# C'), candidate('sub/b.markdown', '# B')],
    ['notes/c.md'],
    false,
  );

  assert.deepEqual(
    plan.entries.map((entry) => entry.targetPath),
    ['notes/c-2.md', 'notes/sub/b.md'],
  );
});

void test('导入：单篇 5 MB 与单次 200 篇上限都逐条拒绝', () => {
  const big = buildImportPlan([candidate('big.md', '# BIG', MAX_IMPORT_BYTES + 1)], [], false);
  assert.equal(big.entries.length, 0);
  assert.equal(big.rejected[0]?.reason, '超过单篇 5 MB 上限');

  const many = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, index) =>
    candidate(`n${String(index).padStart(3, '0')}.md`, '# x'),
  );
  const plan = buildImportPlan(many, [], false);
  assert.equal(plan.entries.length, MAX_IMPORT_FILES);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0]?.reason, `超过单次 ${String(MAX_IMPORT_FILES)} 篇上限`);
});

void test('导入：标题三级回退 frontmatter → H1 → 文件名，H1 跳过代码块', () => {
  const explicit = parseImportText('x.md', '---\ntitle: 显式标题\n---\n# 正文标题');
  assert.equal(explicit.ok && explicit.title, '显式标题');
  assert.equal(firstHeading('```md\n# 不是标题\n```\n\n# 真标题\n'), '真标题');
  const h1 = parseImportText('x.md', '# 正文标题\n');
  assert.equal(h1.ok && h1.title, '正文标题');
  const fallback = parseImportText('dir/文件名.md', '没有标题');
  assert.equal(fallback.ok && fallback.title, '文件名');
});

void test('导入：frontmatter 四个语义键被带走，未知键逐条列出，正文逐字节保留', () => {
  const source = [
    '---',
    'title: 标题',
    'tags: ["#标签", "标签", ""]',
    'aliases: [旧名]',
    'summary: 简介',
    'cssclass: wide',
    'custom_key: 1',
    '---',
    '',
    '正文 **原样** 保留',
    '',
  ].join('\n');
  const parsed = parseImportText('a.md', source);
  assert.ok(parsed.ok);
  assert.equal(parsed.title, '标题');
  assert.deepEqual(parsed.tags, ['标签']);
  assert.deepEqual(parsed.aliases, ['旧名']);
  assert.equal(parsed.summary, '简介');
  assert.deepEqual(parsed.discardedKeys, ['cssclass', 'custom_key']);
  assert.equal(parsed.text, '\n正文 **原样** 保留\n');
});

void test('导入：frontmatter 解析失败或不是映射时拒绝该篇', () => {
  const broken = buildImportPlan([candidate('a.md', '---\na: [1\n---\nx')], [], false);
  assert.equal(broken.entries.length, 0);
  assert.match(broken.rejected[0]?.reason ?? '', /frontmatter 无法解析/);

  const notMap = buildImportPlan([candidate('b.md', '---\n- a\n- b\n---\nx')], [], false);
  assert.equal(notMap.entries.length, 0);
  assert.equal(notMap.rejected[0]?.reason, 'frontmatter 不是键值映射');
});

void test('导入：目标固定 notes/，文件夹选择丢掉根目录名，保留子层级', () => {
  const plan = buildImportPlan(
    [candidate('我的库/子目录/文章.md', '# 文章'), candidate('我的库/根文章.md', '# 根')],
    [],
    true,
  );
  assert.deepEqual(
    plan.entries.map((entry) => entry.targetPath),
    ['notes/子目录/文章.md', 'notes/根文章.md'],
  );
});

void test('导入：只按路径防覆盖，同名加 -2，不做内容去重', () => {
  const sameBody = '# 一样的内容';
  const plan = buildImportPlan(
    [candidate('a.md', sameBody), candidate('sub/a.md', sameBody), candidate('b.md', sameBody)],
    ['notes/a.md'],
    false,
  );
  assert.deepEqual(
    plan.entries.map((entry) => entry.targetPath),
    ['notes/a-2.md', 'notes/b.md', 'notes/sub/a.md'],
  );
});

void test('导入：目标路径越界直接拒绝，不产生计划', () => {
  const plan = buildImportPlan([candidate('a/../../evil.md', '# evil')], [], false);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.rejected[0]?.reason, '相对路径不合法（含 .. 或空路径）');
});
