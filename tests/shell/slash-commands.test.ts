import assert from 'node:assert/strict';
import test from 'node:test';
import { slashQuery } from '../../src/shell/editor/slash-commands.ts';

void test('行首的斜杠唤出菜单，关键词为空时返回空串', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/新建'), '新建');
  assert.equal(slashQuery('/新建 文档'), null);
});

void test('只有缩进的行也算行首，正文中间的斜杠不触发', () => {
  assert.equal(slashQuery('  /番茄'), '番茄');
  assert.equal(slashQuery('\t/gallery'), 'gallery');
  assert.equal(slashQuery('正文 /新建'), null);
  assert.equal(slashQuery('a/b'), null);
});

void test('斜杠后面的第二个斜杠不触发，避免路径被当命令', () => {
  assert.equal(slashQuery('/notes/2026'), null);
  assert.equal(slashQuery('//'), null);
});
