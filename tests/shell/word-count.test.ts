import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { countWords } from '../../src/shell/editor/word-count.ts';
import { insertTable, tableInsertion } from '../../src/shell/editor/format-commands.ts';
import { wikiCompletionSource } from '../../src/shell/editor/wiki-completion.ts';

// ---- 字数统计 ----

void test('字数统计：空文本与纯标点返回 null', () => {
  assert.equal(countWords(''), null);
  assert.equal(countWords('  \n\t '), null);
  assert.equal(countWords('，。！？……'), null);
});

void test('字数统计：CJK 逐字计数', () => {
  const count = countWords('你好世界');
  assert.deepEqual(count, { chars: 4, words: 0, total: 4 });
});

void test('字数统计：非 CJK 按空白分词', () => {
  const count = countWords('hello world 42');
  assert.deepEqual(count, { chars: 0, words: 3, total: 3 });
});

void test('字数统计：中英混排分别累计', () => {
  const count = countWords('中文 two words');
  assert.deepEqual(count, { chars: 2, words: 2, total: 4 });
});

void test('字数统计：代理对扩展区汉字只算一个字', () => {
  const count = countWords('𠀀𠀁');
  assert.deepEqual(count, { chars: 2, words: 0, total: 2 });
});

// ---- 表格插入 ----

const stateOf = (text: string, anchor?: number): EditorState =>
  EditorState.create({ doc: text, selection: { anchor: anchor ?? text.length } });

void test('表格插入：空行就地插入，光标落在表头第一个单元格', () => {
  const state = stateOf('\n');
  const plan = tableInsertion(state);
  const doc = state.doc.sliceString(0, 0) + plan.insert;
  assert.ok(plan.insert.startsWith('| 列一'));
  assert.ok(doc.includes('| --- | --- | --- |'));
  // 光标紧贴在第一个单元格文字之后
  assert.ok(plan.insert.slice(0, plan.cursor - plan.from).endsWith('列一'));
});

void test('表格插入：当前行有内容时插到下一行并留空行分隔', () => {
  const state = stateOf('正文段落', 2);
  const plan = tableInsertion(state);
  assert.equal(plan.from, state.doc.length);
  assert.ok(plan.insert.startsWith('\n\n|'));
});

// ---- [[ 双链补全 ----

const DOCS = [
  { id: 'a', path: 'notes/中文测试.md', title: '中文测试', aliases: ['zh'] },
  { id: 'b', path: 'notes/alpha.md', title: 'Alpha', aliases: [] },
  { id: 'c', path: 'notes/中文进阶.md', title: '中文进阶', aliases: [] },
];

void test('双链补全：[[ 后按标题过滤，前缀优先于包含', () => {
  const source = wikiCompletionSource({ getDocuments: () => DOCS });
  const state = stateOf('看看[[中文');
  const result = source(new CompletionContext(state, state.doc.length, true));
  assert.notEqual(result, null);
  if (result === null || typeof result === 'boolean') return;
  const labels = result.options.map((option) => String(option.label));
  assert.deepEqual(labels, ['中文测试', '中文进阶']);
});

void test('双链补全：命中别名时给出别名明细', () => {
  const source = wikiCompletionSource({ getDocuments: () => DOCS });
  const state = stateOf('见[[z');
  const result = source(new CompletionContext(state, state.doc.length, true));
  assert.notEqual(result, null);
  if (result === null || typeof result === 'boolean' || !('options' in result)) return;
  assert.ok(result.options.some((option) => String(option.detail).startsWith('别名：zh')));
});

void test('双链补全：无匹配返回 null', () => {
  const source = wikiCompletionSource({ getDocuments: () => DOCS });
  const state = stateOf('见[[不存在的名字很长');
  const result = source(new CompletionContext(state, state.doc.length, true));
  assert.equal(result, null);
});

void test('表格插入动作：dispatch 后文档包含表格骨架', () => {
  const state = stateOf('');
  let applied: string | null = null;
  const view = {
    state,
    dispatch: (spec: { changes: { insert: string } }) => {
      applied = spec.changes.insert;
    },
    focus: () => undefined,
  } as never;
  insertTable(view);
  assert.notEqual(applied, null);
  assert.ok(String(applied).includes('| 列一 | 列二 | 列三 |'));
});
