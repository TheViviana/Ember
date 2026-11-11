import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeDocId, unsafeVaultPath } from '#doc-model';
import { collectBacklinks, countBacklinks, type BacklinkDoc } from '../../src/shell/editor/backlinks.ts';

const doc = (id: string, path: string, title: string, text: string, aliases: readonly string[] = []): BacklinkDoc => ({
  id: unsafeDocId(id),
  path: unsafeVaultPath(path),
  title,
  aliases,
  text,
});

const TARGET = doc('01TARGET', 'notes/目标.md', '目标', '# 目标\n');

void test('反向链接：按来源分组，带行号与原始写法，按标题排序', () => {
  const docs = [
    TARGET,
    doc('01B', 'notes/乙.md', '乙文', '第一段\n\n参见 [[目标]] 与 [[notes/目标.md|另一个名字]]'),
    doc('01A', 'notes/甲.md', '甲文', '[[目标#小节]]'),
  ];
  const groups = collectBacklinks(docs, TARGET.id);

  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.title),
    ['甲文', '乙文'],
  );
  assert.equal(groups[1]?.hits.length, 2);
  assert.equal(groups[1]?.hits[0]?.line, 3);
  assert.equal(groups[1]?.hits[0]?.raw, '[[目标]]');
  assert.equal(groups[0]?.hits[0]?.anchor, '小节');
  assert.equal(countBacklinks(groups), 3);
});

void test('反向链接：跳过自身引用与指向其他文档的链接', () => {
  const selfRef = doc('01TARGET', 'notes/目标.md', '目标', '本文提到 [[目标]]');
  const other = doc('01OTHER', 'notes/别的.md', '别的', '[[别的]]');
  assert.equal(collectBacklinks([selfRef, other], selfRef.id).length, 0);
});

void test('反向链接：代码块与行内代码中的写法不算引用', () => {
  const source = ['```md', '[[目标]]', '```', '', '行内 `[[目标]]` 也不应命中'].join('\n');
  const groups = collectBacklinks([TARGET, doc('01X', 'notes/x.md', 'X', source)], TARGET.id);
  assert.equal(groups.length, 0);
});

void test('反向链接：frontmatter 内的写法不参与解析，行号计入 frontmatter 偏移', () => {
  const source = ['---', 'alias: "[[目标]]"', '---', '', '正文第一行', '[[目标]]'].join('\n');
  const groups = collectBacklinks([TARGET, doc('01Y', 'notes/y.md', 'Y', source)], TARGET.id);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.hits.length, 1);
  assert.equal(groups[0]?.hits[0]?.line, 6);
});

void test('反向链接：文件名、标题、别名三种解析都算引用', () => {
  const target = doc('01T2', 'notes/deep/真实名.md', '长标题', '正文', ['别名甲']);
  const docs = [
    target,
    doc('01A', 'a.md', 'A', '[[真实名]]'),
    doc('01B', 'b.md', 'B', '[[长标题]]'),
    doc('01C', 'c.md', 'C', '[[别名甲]]'),
  ];
  const groups = collectBacklinks(docs, target.id);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((group) => group.docId),
    docs.slice(1).map((item) => item.id),
  );
});

void test('反向链接：歧义标题不猜文档，不计入任何一篇', () => {
  const left = doc('01L', 'x/同名.md', '同名', '');
  const right = doc('01R', 'y/同名.md', '同名', '');
  const source = doc('01S', 's.md', 'S', '[[不是标题也不是路径]]');
  assert.equal(collectBacklinks([left, right, source], left.id).length, 0);
});
