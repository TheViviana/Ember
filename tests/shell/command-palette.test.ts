import assert from 'node:assert/strict';
import test from 'node:test';
import { asCommandId, asDocId, type CommandId } from '#doc-model';
import type { CommandDescriptor } from '../../src/kernel/types.ts';
import {
  commandDocId,
  editorArgsFor,
  filterCommands,
  scopeLabel,
} from '../../src/shell/commands/palette.ts';

const id = (value: string): CommandId => {
  const parsed = asCommandId(value);
  assert.notEqual(parsed, null);
  return parsed as CommandId;
};

const command = (value: string, title: string, scope: CommandDescriptor['scope']): CommandDescriptor => ({
  id: id(value),
  title,
  scope,
  keybinding: null,
  owner: null,
});

const COMMANDS: readonly CommandDescriptor[] = [
  command('ember.doc.create', '新建文档', 'global'),
  command('ember.doc.duplicate', '复制当前文档', 'editor'),
  command('example.hello.greet', '示例：打招呼', 'global'),
];

void test('命令搜索：空关键词返回全部，标题与 id 都参与匹配', () => {
  assert.equal(filterCommands(COMMANDS, '').length, 3);
  assert.deepEqual(
    filterCommands(COMMANDS, '文档').map((item) => String(item.id)),
    ['ember.doc.create', 'ember.doc.duplicate'],
  );
  assert.deepEqual(
    filterCommands(COMMANDS, 'HELLO').map((item) => String(item.id)),
    ['example.hello.greet'],
  );
  assert.deepEqual(filterCommands(COMMANDS, '不存在'), []);
});

void test('命令作用域文案', () => {
  assert.equal(scopeLabel('global'), '全局');
  assert.equal(scopeLabel('editor'), '当前文档');
  assert.equal(scopeLabel('canvas'), '画布');
});

void test('编辑器命令参数：没有活动文档时不构造参数', () => {
  const docId = asDocId('01J9Z6Q2M8V4N7K3R5T1W9X0AB');
  assert.notEqual(docId, null);
  assert.deepEqual(editorArgsFor(docId), { docId });
  assert.equal(editorArgsFor(null), null);
});

void test('从命令参数中取回 docId，非法输入返回 null', () => {
  const docId = asDocId('01J9Z6Q2M8V4N7K3R5T1W9X0AB');
  assert.equal(commandDocId({ docId }), docId);
  assert.equal(commandDocId({ docId: 'not-a-ulid' }), null);
  assert.equal(commandDocId({}), null);
  assert.equal(commandDocId(null), null);
  assert.equal(commandDocId('doc'), null);
});
