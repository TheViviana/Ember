import assert from 'node:assert/strict';
import test from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { findWikiLinkAt, isInsideCode } from '../../src/shell/editor/wiki-link.ts';

const stateOf = (doc: string): EditorState => EditorState.create({ doc, extensions: [markdown()] });

void test('普通段落中能定位到覆盖点击位置的链接', () => {
  const doc = '前言\n点这里 [[目标|别名]] 结束';
  const state = stateOf(doc);
  const pos = doc.indexOf('[[') + 2;
  const link = findWikiLinkAt(state.doc, pos);
  assert.ok(link !== null);
  assert.equal(link.target, '目标');
  assert.equal(link.label, '别名');
  assert.equal(link.start, doc.indexOf('[['));
  assert.equal(link.end, doc.indexOf(']]') + 2);
});

void test('链接之外的位置返回 null', () => {
  const doc = '前言 [[目标]] 结束';
  const state = stateOf(doc);
  assert.equal(findWikiLinkAt(state.doc, 0), null);
  assert.equal(findWikiLinkAt(state.doc, doc.length - 1), null);
});

void test('多个链接时按点击位置返回对应那个', () => {
  const doc = '[[甲]] 与 [[乙]]';
  const state = stateOf(doc);
  const first = findWikiLinkAt(state.doc, doc.indexOf('[[甲]]') + 1);
  const second = findWikiLinkAt(state.doc, doc.indexOf('[[乙]]') + 1);
  assert.equal(first?.target, '甲');
  assert.equal(second?.target, '乙');
});

void test('普通段落里的链接不算代码区', () => {
  const doc = '正文 [[目标]] 结束';
  const state = stateOf(doc);
  assert.equal(isInsideCode(state, doc.indexOf('[[') + 1), false);
});

void test('行内代码里的 [[...]] 判定为代码区', () => {
  const doc = '前 `[[目标]]` 后';
  const state = stateOf(doc);
  const pos = doc.indexOf('[[') + 1;
  assert.equal(findWikiLinkAt(state.doc, pos)?.target, '目标');
  assert.equal(isInsideCode(state, pos), true);
});

void test('围栏代码块里的 [[...]] 判定为代码区，正文不受影响', () => {
  const doc = ['```', '[[目标]]', '```', '', '正文 [[真目标]]'].join('\n');
  const state = stateOf(doc);
  const inside = doc.indexOf('[[目标]]') + 1;
  const outside = doc.indexOf('[[真目标]]') + 1;
  assert.equal(isInsideCode(state, inside), true);
  assert.equal(isInsideCode(state, outside), false);
});

void test('缩进代码块里的 [[...]] 判定为代码区', () => {
  const doc = ['    [[目标]]', '', '正文'].join('\n');
  const state = stateOf(doc);
  assert.equal(isInsideCode(state, doc.indexOf('[[') + 1), true);
});
