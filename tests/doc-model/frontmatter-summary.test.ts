import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUMMARY_MAX,
  normalizeFrontmatter,
  toSerializable,
} from '../../packages/doc-model/src/frontmatter.ts';
import { deriveSummary } from '../../packages/doc-model/src/summary.ts';
import { deriveSummary as deriveFromIndex } from '../../packages/doc-model/src/index.ts';
import { createUlid } from '../../packages/doc-model/src/ulid.ts';

void test('summary 解析为字符串并插入序列化顺序 title 之后', () => {
  const { frontmatter, issues } = normalizeFrontmatter({
    id: createUlid(),
    title: 'T',
    summary: '一句话简介',
    tags: ['t'],
  });
  assert.equal(issues.length, 0);
  assert.equal(frontmatter.summary, '一句话简介');
  assert.deepEqual(Object.keys(toSerializable(frontmatter)).slice(0, 3), ['id', 'title', 'summary']);
});

void test('缺 summary 的旧文档不产生诊断、不阻断', () => {
  const { frontmatter, issues } = normalizeFrontmatter({
    id: createUlid(),
    title: '旧文章',
    tags: ['研发'],
  });
  assert.deepEqual(issues, []);
  assert.equal(frontmatter.summary, null);
  assert.equal(toSerializable(frontmatter)['summary'], undefined);
});

void test('summary 非字符串或超长产生 summary_invalid 且不进入模型', () => {
  const bad = normalizeFrontmatter({ summary: 42 });
  assert.equal(bad.frontmatter.summary, null);
  assert.equal(bad.issues[0]?.code, 'summary_invalid');

  const tooLong = normalizeFrontmatter({ summary: '字'.repeat(SUMMARY_MAX + 1) });
  assert.equal(tooLong.frontmatter.summary, null);
  assert.equal(tooLong.issues[0]?.code, 'summary_invalid');
});

void test('summary 是保留键，不重复落入 extra', () => {
  const { frontmatter } = normalizeFrontmatter({ summary: '简介' });
  assert.equal(frontmatter.extra['summary'], undefined);
});

void test('派生简介跳过标题、列表、代码块与 Markdown 标记', () => {
  const body = [
    '# 标题',
    '',
    '```',
    'const ignored = 1;',
    '```',
    '',
    '- 列表项不算第一段',
    '',
    '这是 **第一段** 正文，带 [链接](https://example.com) 与 `代码`。',
    '第二行并入同一段。',
    '',
    '第二段不采用。',
  ].join('\n');

  assert.equal(deriveSummary(body), '这是 第一段 正文，带 链接 与 代码。 第二行并入同一段。');
});

void test('派生简介超长按字符截断并加省略号，且从包索引导出同一实现', () => {
  const body = '字'.repeat(200);
  const result = deriveFromIndex(body);
  assert.equal(Array.from(result).length, 121);
  assert.equal(result.endsWith('…'), true);
  assert.equal(deriveSummary(''), '');
});
