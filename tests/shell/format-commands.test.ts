import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import {
  blockEdits,
  formatStateAt,
  headingEdits,
  inlineEdit,
  type FormatChange,
} from '../../src/shell/editor/format-commands.ts';

const stateOf = (doc: string, anchor = 0, head = anchor, withMarkdown = false): EditorState =>
  EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: withMarkdown ? [markdown()] : [],
  });

const apply = (doc: string, changes: readonly FormatChange[]): string => {
  let next = doc;
  for (const change of [...changes].sort((left, right) => right.from - left.from)) {
    next = next.slice(0, change.from) + change.insert + next.slice(change.to);
  }
  return next;
};

void test('行内标记：有选区时包裹，再按一次去掉', () => {
  const doc = stateOf('hello').doc;
  const wrapped = inlineEdit(doc, 0, 5, '**');
  assert.equal(apply('hello', wrapped.changes), '**hello**');
  assert.equal(wrapped.from, 2);
  assert.equal(wrapped.to, 7);

  const unwrapped = inlineEdit(EditorState.create({ doc: '**hello**' }).doc, 2, 7, '**');
  assert.equal(apply('**hello**', unwrapped.changes), 'hello');
  assert.equal(unwrapped.from, 0);
  assert.equal(unwrapped.to, 5);
});

void test('行内标记：空光标插入成对标记，光标落在中间', () => {
  const edit = inlineEdit(EditorState.create({ doc: '' }).doc, 0, 0, '~~');
  assert.equal(apply('', edit.changes), '~~~~');
  assert.equal(edit.from, 2);
  assert.equal(edit.to, 2);
});

void test('行内标记：光标在两对标记中间时再次切换会去掉', () => {
  const edit = inlineEdit(EditorState.create({ doc: '****' }).doc, 2, 2, '**');
  assert.equal(apply('****', edit.changes), '');
  assert.equal(edit.from, 0);
});

void test('斜体不会把粗体的双星当作自己的边界', () => {
  const edit = inlineEdit(EditorState.create({ doc: '**hello**' }).doc, 2, 7, '*');
  assert.equal(apply('**hello**', edit.changes), '***hello***');
  assert.equal(edit.from, 3);
  assert.equal(edit.to, 8);
});

void test('标题：多行统一加前缀，再按一次整段去掉', () => {
  const state = stateOf('title\nbody', 0, 10);
  assert.equal(apply('title\nbody', headingEdits(state, 2)), '## title\n## body');

  const applied = stateOf('## title\n## body', 0, 16);
  assert.equal(apply('## title\n## body', headingEdits(applied, 2)), 'title\nbody');
});

void test('列表：无序、有序、任务可互相替换，并保留缩进', () => {
  const bullet = stateOf('a\n  b', 0, 5);
  assert.equal(apply('a\n  b', blockEdits(bullet, 'ul')), '- a\n  - b');

  const ordered = stateOf('a\nb', 0, 3);
  assert.equal(apply('a\nb', blockEdits(ordered, 'ol')), '1. a\n2. b');

  const task = stateOf('a\nb', 0, 3);
  assert.equal(apply('a\nb', blockEdits(task, 'task')), '- [ ] a\n- [ ] b');

  const switched = stateOf('1. a\n2. b', 0, 9);
  assert.equal(apply('1. a\n2. b', blockEdits(switched, 'ul')), '- a\n- b');
});

void test('引用：整段加 >，再按一次去掉', () => {
  const state = stateOf('a\nb', 0, 3);
  assert.equal(apply('a\nb', blockEdits(state, 'quote')), '> a\n> b');

  const quoted = stateOf('> a\n> b', 0, 7);
  assert.equal(apply('> a\n> b', blockEdits(quoted, 'quote')), 'a\nb');
});

void test('选区终点落在下一行行首时，不把下一行算进来', () => {
  const state = stateOf('a\nb', 0, 2);
  assert.equal(apply('a\nb', blockEdits(state, 'ul')), '- a\nb');
});

void test('格式状态从语法树读取：粗体、标题、任务列表、代码块', () => {
  const bold = formatStateAt(stateOf('**x**', 3, 3, true));
  assert.equal(bold.bold, true);

  const heading = formatStateAt(stateOf('# title', 3, 3, true));
  assert.equal(heading.heading, 1);

  const task = formatStateAt(stateOf('- [ ] todo', 7, 7, true));
  assert.equal(task.list, 'task');

  const code = formatStateAt(stateOf('```\ncode\n```', 6, 6, true));
  assert.equal(code.inCodeBlock, true);
});

void test('普通文本不误报格式状态', () => {
  const plain = formatStateAt(stateOf('plain text', 5, 5, true));
  assert.deepEqual(plain, {
    bold: false,
    italic: false,
    strike: false,
    code: false,
    heading: 0,
    quote: false,
    list: null,
    inCodeBlock: false,
    canUndo: false,
    canRedo: false,
  });
});
