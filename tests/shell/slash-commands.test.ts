import assert from 'node:assert/strict';
import test from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { asCommandId, asDocId, type CommandId, type DocId } from '#doc-model';
import type { CommandDescriptor } from '../../src/kernel/types.ts';
import {
  slashCompletionSource,
  slashQuery,
} from '../../src/shell/editor/slash-commands.ts';

void test('行首的斜杠唤出菜单，关键词为空时返回空串', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/新建'), '新建');
  assert.equal(slashQuery('/新建 文档'), null);
});

void test('缩进、列表与引用标记之后都属于触发位', () => {
  assert.equal(slashQuery('  /番茄'), '番茄');
  assert.equal(slashQuery('\t/gallery'), 'gallery');
  assert.equal(slashQuery('- /番茄'), '番茄');
  assert.equal(slashQuery('1. /文档'), '文档');
  assert.equal(slashQuery('> /总结'), '总结');
});

void test('正文空白之后也能触发，词中间的斜杠不触发', () => {
  assert.equal(slashQuery('正文 /新建'), '新建');
  assert.equal(slashQuery('a/b'), null);
  assert.equal(slashQuery('2026/11/13'), null);
});

void test('斜杠后面的第二个斜杠不触发，避免路径被当命令', () => {
  assert.equal(slashQuery('/notes/2026'), null);
  assert.equal(slashQuery('//'), null);
  assert.equal(slashQuery('cd /usr/local'), null);
});

const docId = (value: string): DocId => {
  const id = asDocId(value);
  assert.ok(id !== null, `${value} 必须是合法文档 id`);
  return id;
};

const DOC_ID = docId('notes/示例.md');

const cmdId = (value: string): CommandId => {
  const id = asCommandId(value);
  assert.ok(id !== null, `${value} 必须是合法命令 id`);
  return id;
};

const COMMANDS: readonly CommandDescriptor[] = [
  { id: cmdId('ember.doc.create'), title: '新建文档', scope: 'editor', keybinding: null },
  { id: cmdId('ember.panel.health'), title: '检查库健康', scope: 'global', keybinding: null },
  { id: cmdId('ember.canvas.new'), title: '新建画布', scope: 'canvas', keybinding: null },
];

const source = slashCompletionSource({
  commands: {
    list: () => COMMANDS,
    execute: (id) => Promise.resolve({ id, ok: true, error: null }),
  },
  docId: DOC_ID,
  onError: () => undefined,
});

/** 用真实 EditorState 造补全上下文，走的是与运行时同一个判定函数 */
const completeAtEnd = (doc: string) => {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return source(new CompletionContext(state, doc.length, false));
};

void test('补全源：行首 / 缩进 / 列表 / 正文空白之后都能给出候选', () => {
  for (const doc of ['/', '  /', '- /', '1. /', '正文 /']) {
    const result = completeAtEnd(doc);
    assert.notEqual(result, null, `${JSON.stringify(doc)} 应该弹出菜单`);
    const labels = result?.options.map((option) => option.label) ?? [];
    assert.ok(labels.includes('新建文档'), `${JSON.stringify(doc)} 应包含编辑器命令`);
    assert.ok(labels.includes('检查库健康'), `${JSON.stringify(doc)} 应包含全局命令`);
    assert.equal(labels.includes('新建画布'), false, '画布命令不进编辑器菜单');
  }
});

void test('补全源：路径与代码块里不弹菜单', () => {
  assert.equal(completeAtEnd('a/b'), null);
  assert.equal(completeAtEnd('2026/11/13'), null);
  assert.equal(completeAtEnd('```\n/usr'), null);
});

void test('补全源：没有匹配命令时返回 null，不弹空菜单', () => {
  assert.equal(completeAtEnd('/不存在的命令'), null);
});
