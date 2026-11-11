import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import {
  collectWikiLinks,
  createIncrementalDecorations,
  updateIncrementalDecorations,
} from '../../src/shell/editor/incremental-decorations.ts';

const SOURCE = '[[alpha]]\nline two\n[[beta]]\nline four';

const decorationAt = (
  spans: readonly { readonly from: number; readonly to: number; readonly decoration: unknown }[],
  from: number,
): unknown => spans.find((span) => span.from === from)?.decoration;

void test('文档未变化时完全复用上一份状态（同一引用）', () => {
  const state = EditorState.create({ doc: SOURCE });
  const decorations = createIncrementalDecorations(state.doc, collectWikiLinks);
  assert.equal(decorations.spans.length, 2);

  const transaction = state.update({ selection: { anchor: 1 } });
  const next = updateIncrementalDecorations(decorations, transaction, collectWikiLinks);

  assert.equal(next, decorations);
});

void test('只重建 changedRanges 覆盖的行，未受影响装饰保持同一引用', () => {
  const state = EditorState.create({ doc: SOURCE });
  const decorations = createIncrementalDecorations(state.doc, collectWikiLinks);
  const alphaFrom = SOURCE.indexOf('[[alpha]]');
  const betaFrom = SOURCE.indexOf('[[beta]]');
  const alphaBefore = decorationAt(decorations.spans, alphaFrom);
  const betaBefore = decorationAt(decorations.spans, betaFrom);
  assert.ok(alphaBefore !== undefined && betaBefore !== undefined);

  const transaction = state.update({ changes: { from: betaFrom + 2, to: betaFrom + 6, insert: 'BETA' } });
  const next = updateIncrementalDecorations(decorations, transaction, collectWikiLinks);

  const betaLine = state.doc.line(3);
  assert.deepEqual(
    next.rebuilt.map((range) => ({ from: range.from, to: range.to })),
    [{ from: betaLine.from, to: betaLine.to }],
  );
  assert.notEqual(next.decorations, decorations.decorations);

  const alphaAfter = decorationAt(next.spans, alphaFrom);
  const betaAfter = decorationAt(next.spans, betaFrom);
  assert.equal(alphaAfter, alphaBefore);
  assert.ok(betaAfter !== undefined);
  assert.notEqual(betaAfter, betaBefore);
});

void test('编辑与链接无关的行不触碰任何链接装饰', () => {
  const state = EditorState.create({ doc: SOURCE });
  const decorations = createIncrementalDecorations(state.doc, collectWikiLinks);
  const alphaFrom = SOURCE.indexOf('[[alpha]]');
  const betaFrom = SOURCE.indexOf('[[beta]]');
  const alphaBefore = decorationAt(decorations.spans, alphaFrom);
  const betaBefore = decorationAt(decorations.spans, betaFrom);

  const lineTwo = state.doc.line(2);
  const transaction = state.update({ changes: { from: lineTwo.from, to: lineTwo.to, insert: 'LINE TWO' } });
  const next = updateIncrementalDecorations(decorations, transaction, collectWikiLinks);

  assert.deepEqual(
    next.rebuilt.map((range) => ({ from: range.from, to: range.to })),
    [{ from: lineTwo.from, to: lineTwo.to }],
  );
  assert.equal(decorationAt(next.spans, alphaFrom), alphaBefore);
  assert.equal(decorationAt(next.spans, betaFrom), betaBefore);
});
