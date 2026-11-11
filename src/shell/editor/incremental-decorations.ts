import type { ChangeSet, Text } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * 增量装饰引擎（I10 / E1）。
 *
 * 规则：
 * 1. 文档未变化时直接复用上一份状态（同一对象引用），不做任何重建；
 * 2. 文档变化时只对 `changes.iterChangedRanges` 覆盖到的"整行区间"重新收集装饰；
 * 3. 未受影响区间的装饰对象原样保留（通过 `DecorationSet.map` 平移，值引用不变）。
 */

export interface SpanDecoration {
  readonly from: number;
  readonly to: number;
  readonly decoration: Decoration;
}

export type SpanCollector = (doc: Text, from: number, to: number) => readonly SpanDecoration[];

export interface DecorationRange {
  readonly from: number;
  readonly to: number;
}

export interface IncrementalDecorationState {
  readonly decorations: DecorationSet;
  readonly spans: readonly SpanDecoration[];
  /** 本次实际重建的区间，空数组表示完整复用 */
  readonly rebuilt: readonly DecorationRange[];
}

export interface DecorationUpdate {
  readonly changes: ChangeSet;
  readonly newDoc: Text;
}

const buildState = (
  spans: readonly SpanDecoration[],
  rebuilt: readonly DecorationRange[],
): IncrementalDecorationState => {
  const sorted = [...spans].sort((left, right) => left.from - right.from || left.to - right.to);
  const decorations = Decoration.set(
    sorted.map((span) => span.decoration.range(span.from, span.to)),
    true,
  );
  return { decorations, spans: sorted, rebuilt };
};

export const createIncrementalDecorations = (
  doc: Text,
  collector: SpanCollector,
): IncrementalDecorationState => {
  const spans = collector(doc, 0, doc.length);
  return buildState(spans, [{ from: 0, to: doc.length }]);
};

const mergeRanges = (ranges: readonly DecorationRange[]): readonly DecorationRange[] => {
  const sorted = [...ranges].sort((left, right) => left.from - right.from);
  const merged: DecorationRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.from <= last.to) {
      merged[merged.length - 1] = { from: last.from, to: Math.max(last.to, range.to) };
    } else {
      merged.push(range);
    }
  }
  return merged;
};

export const updateIncrementalDecorations = (
  previous: IncrementalDecorationState,
  update: DecorationUpdate,
  collector: SpanCollector,
): IncrementalDecorationState => {
  const touched: DecorationRange[] = [];
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const start = update.newDoc.lineAt(fromB).from;
    const end = update.newDoc.lineAt(Math.max(fromB, toB)).to;
    touched.push({ from: start, to: end });
  });

  if (touched.length === 0) return previous;

  const rebuilt = mergeRanges(touched);
  const mapped = previous.decorations.map(update.changes);
  const kept: SpanDecoration[] = [];

  const iterator = mapped.iter();
  while (iterator.value !== null) {
    const overlaps = rebuilt.some((range) => iterator.from < range.to && iterator.to > range.from);
    if (!overlaps) {
      kept.push({ from: iterator.from, to: iterator.to, decoration: iterator.value });
    }
    iterator.next();
  }

  const fresh: SpanDecoration[] = [];
  for (const range of rebuilt) {
    fresh.push(...collector(update.newDoc, range.from, range.to));
  }

  return buildState([...kept, ...fresh], rebuilt);
};

export const incrementalDecorationPlugin = (collector: SpanCollector): Extension =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private state: IncrementalDecorationState;

      constructor(view: EditorView) {
        this.state = createIncrementalDecorations(view.state.doc, collector);
        this.decorations = this.state.decorations;
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        this.state = updateIncrementalDecorations(
          this.state,
          { changes: update.changes, newDoc: update.state.doc },
          collector,
        );
        this.decorations = this.state.decorations;
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

const WIKI_LINK = /\[\[[^[\]\n]+\]\]/g;

/** 示例装饰：把 [[wikilink]] 标成品牌色（真实功能，非占位） */
export const collectWikiLinks: SpanCollector = (doc, from, to) => {
  const text = doc.sliceString(from, to);
  const spans: SpanDecoration[] = [];
  for (const match of text.matchAll(WIKI_LINK)) {
    const start = from + (match.index ?? 0);
    spans.push({
      from: start,
      to: start + match[0].length,
      decoration: Decoration.mark({ class: 'ember-wikilink' }),
    });
  }
  return spans;
};
