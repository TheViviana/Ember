import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'code';
export type BlockFormat = 'quote' | 'ul' | 'ol' | 'task';
export type HeadingLevel = 1 | 2;

export interface FormatState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  readonly heading: 0 | HeadingLevel;
  readonly quote: boolean;
  readonly list: BlockFormat | null;
  /** 代码块内禁用工具栏，避免把标记写进代码 */
  readonly inCodeBlock: boolean;
}

export const EMPTY_FORMAT_STATE: FormatState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  heading: 0,
  quote: false,
  list: null,
  inCodeBlock: false,
};

const MARKERS: Record<InlineFormat, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

const LIST_PREFIX = /^([-+*]|\d+[.)])[ \t]+/;
const BULLET_PREFIX = /^[-+*][ \t]+/;
const TASK_PREFIX = /^[-+*][ \t]+\[[ xX]\][ \t]+/;
const HEADING_PREFIX = /^#{1,6}[ \t]+/;
const QUOTE_PREFIX = /^>[ \t]?/;

export interface FormatChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface InlineEdit {
  readonly changes: readonly FormatChange[];
  readonly from: number;
  readonly to: number;
}

export const sameFormatState = (left: FormatState, right: FormatState): boolean =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.strike === right.strike &&
  left.code === right.code &&
  left.heading === right.heading &&
  left.quote === right.quote &&
  left.list === right.list &&
  left.inCodeBlock === right.inCodeBlock;

/**
 * 单字符标记（* ~ `）不能把双字符标记的一半当作自己的边界。
 * 例如在 **粗体** 里按斜体，不能把 ** 误判成 *。
 */
const markerBefore = (doc: Text, pos: number, marker: string): boolean => {
  if (pos < marker.length) return false;
  if (doc.sliceString(pos - marker.length, pos) !== marker) return false;
  if (marker.length === 1) {
    return pos - 1 <= 0 || doc.sliceString(pos - 2, pos - 1) !== marker;
  }
  return true;
};

const markerAfter = (doc: Text, pos: number, marker: string): boolean => {
  if (pos + marker.length > doc.length) return false;
  if (doc.sliceString(pos, pos + marker.length) !== marker) return false;
  if (marker.length === 1) {
    return pos + 1 >= doc.length || doc.sliceString(pos + 1, pos + 2) !== marker;
  }
  return true;
};

/**
 * 计算一个选区的行内标记切换：有则去、无则包。
 * 只返回纯数据，方便单测；真正的 dispatch 在 toggleInline 里做。
 */
export const inlineEdit = (doc: Text, from: number, to: number, marker: string): InlineEdit => {
  const size = marker.length;
  const wrappedOutside = markerBefore(doc, from, marker) && markerAfter(doc, to, marker);

  if (from === to) {
    if (wrappedOutside) {
      return {
        changes: [
          { from: from - size, to: from, insert: '' },
          { from: to, to: to + size, insert: '' },
        ],
        from: from - size,
        to: from - size,
      };
    }
    return {
      changes: [{ from, to, insert: marker + marker }],
      from: from + size,
      to: from + size,
    };
  }

  if (wrappedOutside) {
    return {
      changes: [
        { from: from - size, to: from, insert: '' },
        { from: to, to: to + size, insert: '' },
      ],
      from: from - size,
      to: to - size,
    };
  }

  const selected = doc.sliceString(from, to);
  if (selected.length >= size * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    return {
      changes: [{ from, to, insert: selected.slice(size, selected.length - size) }],
      from,
      to: to - size * 2,
    };
  }

  return {
    changes: [
      { from, to: from, insert: marker },
      { from: to, to, insert: marker },
    ],
    from: from + size,
    to: to + size,
  };
};

export const toggleInline = (view: EditorView, format: InlineFormat): void => {
  const { state } = view;
  const marker = MARKERS[format];
  const spec = state.changeByRange((range) => {
    const edit = inlineEdit(state.doc, range.from, range.to, marker);
    const changeSet = state.changes(edit.changes);
    return {
      changes: edit.changes,
      // 分别映射 anchor / head，保留反向选区的方向
      range: EditorSelection.range(
        changeSet.mapPos(range.anchor, range.anchor > range.head ? -1 : 1),
        changeSet.mapPos(range.head, range.head > range.anchor ? -1 : 1),
      ),
    };
  });
  view.dispatch({ ...spec, userEvent: 'input.format' });
  view.focus();
};

/** 选区覆盖到的行；选区终点正好落在下一行行首时，不把下一行算进来 */
const targetLines = (state: EditorState): readonly { from: number; text: string; number: number }[] => {
  const lines = new Map<number, { from: number; text: string; number: number }>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    let last = state.doc.lineAt(range.to);
    if (range.to > range.from && range.to === last.from && last.number > first.number) {
      last = state.doc.line(last.number - 1);
    }
    for (let number = first.number; number <= last.number; number += 1) {
      if (lines.has(number)) continue;
      const line = state.doc.line(number);
      lines.set(number, { from: line.from, text: line.text, number });
    }
  }
  return [...lines.values()].sort((left, right) => left.from - right.from);
};

const indentLength = (text: string): number => {
  const match = /^[ \t]*/.exec(text);
  return match === null ? 0 : match[0].length;
};

const headingPrefix = (level: HeadingLevel): string => `${'#'.repeat(level)} `;

const listPrefix = (format: BlockFormat, index: number): string => {
  if (format === 'ul') return '- ';
  if (format === 'task') return '- [ ] ';
  return `${index + 1}. `;
};

const existingPrefixLength = (content: string, format: BlockFormat | 'heading'): number => {
  if (format === 'heading') {
    const match = HEADING_PREFIX.exec(content);
    return match === null ? 0 : match[0].length;
  }
  if (format === 'quote') {
    const match = QUOTE_PREFIX.exec(content);
    return match === null ? 0 : match[0].length;
  }
  const task = TASK_PREFIX.exec(content);
  if (task !== null) return task[0].length;
  const list = LIST_PREFIX.exec(content);
  return list === null ? 0 : list[0].length;
};

const hasDesiredPrefix = (content: string, format: BlockFormat | 'heading', level?: HeadingLevel): boolean => {
  if (format === 'heading') {
    return new RegExp(`^#{${level ?? 1}}[ \\t]+`).test(content);
  }
  if (format === 'quote') return QUOTE_PREFIX.test(content);
  if (format === 'ol') return /^\d+[.)][ \t]+/.test(content);
  if (format === 'task') return TASK_PREFIX.test(content);
  return BULLET_PREFIX.test(content) && !TASK_PREFIX.test(content);
};

interface PrefixPlan {
  readonly changes: readonly FormatChange[];
  readonly lines: number;
}

const planPrefix = (
  state: EditorState,
  format: BlockFormat | 'heading',
  level?: HeadingLevel,
): PrefixPlan => {
  const lines = targetLines(state);
  if (lines.length === 0) return { changes: [], lines: 0 };

  const contents = lines.map((line) => line.text.slice(indentLength(line.text)));
  const allHave = contents.every((content) => hasDesiredPrefix(content, format, level));

  const changes = lines.map((line, index): FormatChange => {
    const indent = indentLength(line.text);
    const content = line.text.slice(indent);
    const existing = existingPrefixLength(content, format);
    const from = line.from + indent;
    return {
      from,
      to: from + existing,
      insert: allHave ? '' : format === 'heading' ? headingPrefix(level ?? 1) : format === 'quote' ? '> ' : listPrefix(format, index),
    };
  });

  return { changes, lines: lines.length };
};

const dispatchChanges = (view: EditorView, changes: readonly FormatChange[]): void => {
  if (changes.length === 0) return;
  const { state } = view;
  const changeSet = state.changes(changes);
  const selection = state.selection.map(changeSet);
  view.dispatch({ changes: changeSet, selection, scrollIntoView: true, userEvent: 'input.format' });
  view.focus();
};

export const toggleHeading = (view: EditorView, level: HeadingLevel): void => {
  dispatchChanges(view, planPrefix(view.state, 'heading', level).changes);
};

export const toggleBlock = (view: EditorView, format: BlockFormat): void => {
  dispatchChanges(view, planPrefix(view.state, format).changes);
};

/** 纯函数出口：与 toggleBlock 共用同一份前缀计划，方便单测 */
export const blockEdits = (state: EditorState, format: BlockFormat): readonly FormatChange[] =>
  planPrefix(state, format).changes;

/** 纯函数出口：与 toggleHeading 共用同一份前缀计划，方便单测 */
export const headingEdits = (state: EditorState, level: HeadingLevel): readonly FormatChange[] =>
  planPrefix(state, 'heading', level).changes;

/** 链接保留选区文本，光标落进 () 里，避免写死任何 URL */
export const insertLink = (view: EditorView): void => {
  const { state } = view;
  const spec = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, to: range.to, insert: '[]()' },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}]()` },
      range: EditorSelection.cursor(range.from + text.length + 3),
    };
  });
  view.dispatch({ ...spec, userEvent: 'input.format' });
  view.focus();
};

/** 只依赖语法树节点的公开结构，避免把 @lezer/common 变成直接依赖 */
interface SyntaxAncestor {
  readonly name: string;
  readonly parent: SyntaxAncestor | null;
}

export const formatStateAt = (state: EditorState): FormatState => {
  const head = state.selection.main.head;
  let bold = false;
  let italic = false;
  let strike = false;
  let code = false;
  let heading: 0 | HeadingLevel = 0;
  let quote = false;
  let list: BlockFormat | null = null;
  let inCodeBlock = false;

  let node: SyntaxAncestor | null = syntaxTree(state).resolveInner(head, -1);
  while (node !== null) {
    switch (node.name) {
      case 'StrongEmphasis':
        bold = true;
        break;
      case 'Emphasis':
        italic = true;
        break;
      case 'Strikethrough':
        strike = true;
        break;
      case 'InlineCode':
        code = true;
        break;
      case 'FencedCode':
      case 'CodeBlock':
        inCodeBlock = true;
        break;
      case 'ATXHeading1':
      case 'SetextHeading1':
        heading = 1;
        break;
      case 'ATXHeading2':
      case 'SetextHeading2':
        heading = 2;
        break;
      case 'Blockquote':
        quote = true;
        break;
      case 'TaskList':
        list = 'task';
        break;
      case 'OrderedList':
        if (list === null) list = 'ol';
        break;
      case 'BulletList':
        if (list === null || list === 'ol') list = 'ul';
        break;
      default:
        break;
    }
    node = node.parent;
  }

  // GFM 的任务列表在语法树里仍可能落入 BulletList，用行文本兜底判定
  if (list === 'ul') {
    const line = state.doc.lineAt(head);
    if (TASK_PREFIX.test(line.text.slice(indentLength(line.text)))) list = 'task';
  }

  return { bold, italic, strike, code, heading, quote, list, inCodeBlock };
};
