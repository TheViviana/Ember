import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResolutionIndex,
  resolveLink,
  scanWikiLinks,
  type LinkTarget,
} from '../../packages/doc-model/src/links.ts';
import { unsafeDocId, unsafeVaultPath } from '../../packages/doc-model/src/ids.ts';

const target = (id: string, path: string, title: string, aliases: readonly string[] = []): LinkTarget => ({
  id: unsafeDocId(id),
  path: unsafeVaultPath(path),
  title,
  aliases,
});

const docA = target('01JB8ZQ3K4M5N6P7Q8R9S0T1V2', 'notes/a.md', '方案', ['plan']);
const docB = target('01JB8ZQ3K4M5N6P7Q8R9S0T1V3', 'deep/other.md', '方案');
const docC = target('01JB8ZQ3K4M5N6P7Q8R9S0T1V4', 'notes/b.md', '另一个');
const index = buildResolutionIndex([docA, docB, docC]);

const first = (text: string) => {
  const [link] = scanWikiLinks(text);
  assert.ok(link !== undefined);
  return link;
};

void test('扫描四种链接形态', () => {
  const plain = first('见 [[方案]] 说明');
  assert.equal(plain.target, '方案');
  assert.equal(plain.label, null);
  assert.equal(plain.embed, false);

  const aliased = first('[[notes/a.md|技术方案]]');
  assert.equal(aliased.target, 'notes/a.md');
  assert.equal(aliased.label, '技术方案');

  const anchored = first('[[方案#风险]]');
  assert.equal(anchored.target, '方案');
  assert.equal(anchored.anchor, '风险');

  const embedded = first('![[图.png]]');
  assert.equal(embedded.embed, true);
  assert.equal(embedded.target, '图.png');
});

void test('转义与非链接文本不命中', () => {
  assert.deepEqual(scanWikiLinks('\\[\\[不是链接]]'), []);
  assert.equal(scanWikiLinks('普通文本 [[真链接]]').length, 1);
});

void test('解析优先级：路径 > 文件名 > 标题 > 别名', () => {
  assert.equal(resolveLink(first('[[notes/a.md]]'), index).resolver, 'path');
  assert.equal(resolveLink(first('[[a]]'), index).targetId, docA.id);
  assert.equal(resolveLink(first('[[plan]]'), index).targetId, docA.id);
  assert.equal(resolveLink(first('[[另一个]]'), index).targetId, docC.id);
  assert.equal(resolveLink(first('[[不存在]]'), index).resolver, 'unresolved');
});

void test('标题多命中登记为 ambiguous 并保留全部候选', () => {
  const resolved = resolveLink(first('[[方案]]'), index);
  assert.equal(resolved.resolver, 'ambiguous');
  assert.equal(resolved.targetId, null);
  assert.deepEqual(new Set(resolved.candidates), new Set([docA.id, docB.id]));
});

void test('[[文件.md]] 带后缀的文件名链接可以解析（Obsidian 兼容）', () => {
  const resolved = resolveLink(first('[[b.md]]'), index);
  assert.equal(resolved.resolver, 'basename');
  assert.equal(resolved.targetId, docC.id);

  // 路径形目标 byPath 未命中时，剥后缀后仍可落到标题/文件名
  const byTitle = resolveLink(first('[[deep/other.md]]'), index);
  assert.equal(byTitle.targetId, docB.id);

  // 别名同样享受剥后缀匹配
  const byAlias = resolveLink(first('[[plan.md]]'), index);
  assert.equal(byAlias.resolver, 'alias');
  assert.equal(byAlias.targetId, docA.id);

  // 纯 `.md` 剥完为空 → 不误命中
  assert.equal(resolveLink(first('[[.md]]'), index).resolver, 'unresolved');
});

void test('大小写折叠路径冲突登记 ambiguous，不静默决胜', () => {
  const upper = target('01JB8ZQ3K4M5N6P7Q8R9S0T1V5', 'notes/Case.md', '大写');
  const lower = target('01JB8ZQ3K4M5N6P7Q8R9S0T1V6', 'notes/case.md', '小写');
  const conflicted = buildResolutionIndex([upper, lower]);

  const resolved = resolveLink(first('[[notes/case.md]]'), conflicted);
  assert.equal(resolved.resolver, 'ambiguous');
  assert.equal(resolved.targetId, null);
  assert.deepEqual(new Set(resolved.candidates), new Set([upper.id, lower.id]));

  // 无冲突路径不受影响
  const unambiguous = resolveLink(first('[[notes/a.md]]'), index);
  assert.equal(unambiguous.resolver, 'path');
});
