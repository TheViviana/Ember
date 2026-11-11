import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import { scanWikiLinks, type WikiLink } from '#doc-model';

/** lezer-markdown 中代表代码的节点：行内代码、缩进代码块、围栏代码块及其标记 */
const CODE_NODE_NAMES = new Set([
  'InlineCode',
  'CodeText',
  'CodeMark',
  'CodeInfo',
  'CodeBlock',
  'FencedCode',
]);

interface SyntaxNodeLike {
  readonly name: string;
  readonly parent: SyntaxNodeLike | null;
}

/** 光标位置是否落在行内代码或代码块里 */
export const isInsideCode = (state: EditorState, pos: number): boolean => {
  let node: SyntaxNodeLike | null = syntaxTree(state).resolveInner(pos, 1);
  while (node !== null) {
    if (CODE_NODE_NAMES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
};

/**
 * 找到覆盖指定位置的 `[[...]]`。
 * 词法扫描复用 doc-model（转义、嵌入、label/anchor 规则与解析层一致），
 * 返回的 start/end 已平移为整篇文档坐标。
 */
export const findWikiLinkAt = (doc: Text, pos: number): WikiLink | null => {
  if (pos < 0 || pos > doc.length) return null;
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  for (const link of scanWikiLinks(line.text)) {
    if (offset >= link.start && offset <= link.end) {
      return { ...link, start: link.start + line.from, end: link.end + line.from };
    }
  }
  return null;
};
