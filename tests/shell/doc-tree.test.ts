import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocMeta } from '../../src/kernel/types.ts';
import {
  baseNameOf,
  buildTree,
  collectFolderPaths,
  compareNatural,
  flattenTree,
  joinDirPath,
  parentDirOf,
  type DocTreeEntry,
} from '../../src/shell/documents/doc-tree.ts';
import { unsafeContentHash, unsafeDocId, unsafeVaultPath } from '../../packages/doc-model/src/ids.ts';

const doc = (path: string, title: string = path): DocMeta => ({
  id: unsafeDocId(`01J8ZQ3K4M5N6P7Q8R9S0T${String(path.length).padStart(4, '0')}`),
  path: unsafeVaultPath(path),
  title,
  summary: '',
  tags: [],
  aliases: [],
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:00:00.000Z',
  rev: { rev: 1, hash: unsafeContentHash('h') },
  flags: { needsAdoption: false, idInvalid: false, duplicateId: false },
  conflictOf: null,
});

const folder = (entries: readonly DocTreeEntry[], path: string): DocTreeEntry | undefined =>
  entries.find((entry) => entry.kind === 'folder' && entry.path === path);

void test('parentDirOf / baseNameOf / joinDirPath：根层与多层路径', () => {
  assert.equal(parentDirOf('a/b/c.md'), 'a/b');
  assert.equal(parentDirOf('c.md'), '');
  assert.equal(baseNameOf('a/b/c.md'), 'c.md');
  assert.equal(joinDirPath('a/b', 'c.md'), 'a/b/c.md');
  assert.equal(joinDirPath('', 'c.md'), 'c.md');
});

void test('compareNatural：数字段按数值排序（2 在 10 前）', () => {
  const names = ['10-总结', '2-方案', '1-背景', '20-附录'];
  assert.deepEqual([...names].sort(compareNatural), ['1-背景', '2-方案', '10-总结', '20-附录']);
});

void test('buildTree：按 / 切段，文件夹优先于同层文档', () => {
  const tree = buildTree([doc('notes/a.md'), doc('root.md'), doc('notes/sub/b.md')]);
  assert.deepEqual(
    tree.map((entry) => (entry.kind === 'folder' ? `folder:${entry.path}` : `doc:${entry.name}`)),
    ['folder:notes', 'doc:root.md'],
  );
  const notes = folder(tree, 'notes');
  assert.ok(notes !== undefined && notes.kind === 'folder');
  assert.deepEqual(
    notes.children.map((entry) => (entry.kind === 'folder' ? `folder:${entry.path}` : `doc:${entry.name}`)),
    ['folder:notes/sub', 'doc:notes/a.md'],
  );
});

void test('buildTree：无路径段重复，子目录折叠为嵌套文件夹', () => {
  const tree = buildTree([doc('a/b/c.md'), doc('a/b/d.md'), doc('a/e.md')]);
  const a = folder(tree, 'a');
  assert.ok(a !== undefined && a.kind === 'folder');
  assert.deepEqual(collectFolderPaths(tree), ['a', 'a/b']);
  const b = folder(a.children, 'a/b');
  assert.ok(b !== undefined && b.kind === 'folder');
  assert.equal(b.children.filter((entry) => entry.kind === 'doc').length, 2);
  // 同名文件夹只出现一次
  assert.equal(tree.filter((entry) => entry.kind === 'folder').length, 1);
});

void test('flattenTree：折叠的文件夹只保留自身行，展开后递归显示子行', () => {
  const tree = buildTree([doc('notes/a.md'), doc('notes/sub/b.md'), doc('root.md')]);
  const collapsed = flattenTree(tree, () => false);
  assert.deepEqual(
    collapsed.map((row) => `${row.kind}:${row.kind === 'folder' ? row.path : row.name}@${row.depth}`),
    ['folder:notes@0', 'doc:root.md@0'],
  );
  const expanded = flattenTree(tree, (path) => path === 'notes' || path === 'notes/sub');
  assert.deepEqual(
    expanded.map((row) => `${row.kind}:${row.kind === 'folder' ? row.path : row.name}@${row.depth}`),
    ['folder:notes@0', 'folder:notes/sub@1', 'doc:notes/sub/b.md@2', 'doc:notes/a.md@1', 'doc:root.md@0'],
  );
});
