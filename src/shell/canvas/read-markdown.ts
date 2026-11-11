import { parseMarkdown } from '#doc-model';

/**
 * 轻量 mdast → 渲染树。只消费内核唯一的 Markdown 解析管线（parseMarkdown），
 * 不引入第二套 parser；未知节点一律降级为文本。
 */

export type ReadInline =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'strong'; readonly children: readonly ReadInline[] }
  | { readonly kind: 'emphasis'; readonly children: readonly ReadInline[] }
  | { readonly kind: 'code'; readonly value: string }
  | { readonly kind: 'math'; readonly value: string }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly ReadInline[] }
  | { readonly kind: 'image'; readonly src: string; readonly alt: string }
  | { readonly kind: 'wiki'; readonly target: string; readonly label: string }
  | { readonly kind: 'break' };

export type TableAlign = 'left' | 'center' | 'right' | null;
export type TableRow = readonly (readonly ReadInline[])[];

export type ReadBlock =
  | { readonly kind: 'heading'; readonly depth: number; readonly children: readonly ReadInline[] }
  | { readonly kind: 'paragraph'; readonly children: readonly ReadInline[] }
  | { readonly kind: 'code'; readonly lang: string | null; readonly value: string }
  | { readonly kind: 'math'; readonly value: string }
  | {
      readonly kind: 'table';
      readonly align: readonly TableAlign[];
      readonly header: TableRow;
      readonly rows: readonly TableRow[];
    }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly (readonly ReadBlock[])[];
    }
  | { readonly kind: 'quote'; readonly children: readonly ReadBlock[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'text'; readonly value: string };

interface MdNode {
  readonly type: string;
  readonly value?: string;
  readonly depth?: number;
  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly lang?: string | null;
  readonly url?: string;
  readonly alt?: string | null;
  readonly align?: readonly (string | null)[];
  readonly children?: readonly MdNode[];
}

const SKIPPED_BLOCKS: ReadonlySet<string> = new Set([
  'yaml',
  'toml',
  'definition',
  'footnoteDefinition',
]);

const inlineText = (node: MdNode): string => {
  if (typeof node.value === 'string') return node.value;
  if (typeof node.alt === 'string') return node.alt;
  return (node.children ?? []).map(inlineText).join('');
};

const WIKI_LINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

const pushText = (result: ReadInline[], value: string, allowWiki: boolean): void => {
  if (!allowWiki) {
    if (value.length > 0) result.push({ kind: 'text', value });
    return;
  }
  let last = 0;
  WIKI_LINK.lastIndex = 0;
  for (let match = WIKI_LINK.exec(value); match !== null; match = WIKI_LINK.exec(value)) {
    const target = (match[1] ?? '').trim();
    if (target.length === 0) continue;
    if (match.index > last) result.push({ kind: 'text', value: value.slice(last, match.index) });
    const alias = (match[2] ?? '').trim();
    result.push({ kind: 'wiki', target, label: alias.length > 0 ? alias : target });
    last = match.index + match[0].length;
  }
  if (last < value.length) result.push({ kind: 'text', value: value.slice(last) });
};

const toInlines = (nodes: readonly MdNode[], allowWiki = true): readonly ReadInline[] => {
  const result: ReadInline[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        pushText(result, node.value ?? '', allowWiki);
        break;
      case 'strong':
        result.push({ kind: 'strong', children: toInlines(node.children ?? [], allowWiki) });
        break;
      case 'emphasis':
        result.push({ kind: 'emphasis', children: toInlines(node.children ?? [], allowWiki) });
        break;
      case 'inlineCode':
        result.push({ kind: 'code', value: node.value ?? '' });
        break;
      case 'inlineMath':
        result.push({ kind: 'math', value: node.value ?? '' });
        break;
      case 'link':
        result.push({
          kind: 'link',
          href: node.url ?? '',
          // 链接文字里不再解析双链，避免把按钮塞进 <a>
          children: toInlines(node.children ?? [], false),
        });
        break;
      case 'image':
        result.push({ kind: 'image', src: node.url ?? '', alt: node.alt ?? '' });
        break;
      case 'break':
        result.push({ kind: 'break' });
        break;
      default:
        // html / delete 等未知行内节点：保留可见文字
        result.push({ kind: 'text', value: inlineText(node) });
        break;
    }
  }
  return result;
};

const toBlocks = (nodes: readonly MdNode[]): ReadBlock[] => {
  const result: ReadBlock[] = [];
  for (const node of nodes) {
    if (SKIPPED_BLOCKS.has(node.type)) continue;
    switch (node.type) {
      case 'heading':
        result.push({
          kind: 'heading',
          depth: Math.min(6, Math.max(1, node.depth ?? 1)),
          children: toInlines(node.children ?? []),
        });
        break;
      case 'paragraph':
        result.push({ kind: 'paragraph', children: toInlines(node.children ?? []) });
        break;
      case 'code':
        result.push({
          kind: 'code',
          lang: typeof node.lang === 'string' && node.lang.length > 0 ? node.lang : null,
          value: node.value ?? '',
        });
        break;
      case 'math':
        result.push({ kind: 'math', value: node.value ?? '' });
        break;
      case 'table': {
        // GFM 表格：第一个 tableRow 是表头，其余为数据行
        const rows: TableRow[] = [];
        for (const child of node.children ?? []) {
          if (child.type !== 'tableRow') continue;
          const cells: (readonly ReadInline[])[] = [];
          for (const cell of child.children ?? []) {
            if (cell.type === 'tableCell') cells.push(toInlines(cell.children ?? []));
          }
          rows.push(cells);
        }
        result.push({
          kind: 'table',
          align: (node.align ?? []).map((value) =>
            value === 'left' || value === 'center' || value === 'right' ? value : null,
          ),
          header: rows[0] ?? [],
          rows: rows.slice(1),
        });
        break;
      }
      case 'list': {
        const items: ReadBlock[][] = [];
        for (const child of node.children ?? []) {
          if (child.type === 'listItem') {
            items.push(toBlocks(child.children ?? []));
          } else if (child.type === 'paragraph') {
            items.push([{ kind: 'paragraph', children: toInlines(child.children ?? []) }]);
          }
        }
        result.push({
          kind: 'list',
          ordered: node.ordered === true,
          start: typeof node.start === 'number' ? node.start : 1,
          items,
        });
        break;
      }
      case 'blockquote':
        result.push({ kind: 'quote', children: toBlocks(node.children ?? []) });
        break;
      case 'thematicBreak':
        result.push({ kind: 'rule' });
        break;
      default:
        result.push({ kind: 'text', value: inlineText(node) });
        break;
    }
  }
  return result;
};

/** 阅读态渲染树：note 的 Markdown 源码 → 受支持的块 / 行内结构 */
export const readingBlocks = (markdown: string): readonly ReadBlock[] => {
  const root = parseMarkdown(markdown) as unknown as MdNode;
  return toBlocks(root.children ?? []);
};

/** 阅读态纯文本（用于“是否为空”判断与未知节点降级） */
export const readingPlainText = (blocks: readonly ReadBlock[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return block.children.map(inlinePlainText).join('');
        case 'code':
          return block.value;
        case 'math':
          return block.value;
        case 'table':
          return [block.header, ...block.rows]
            .map((row) => row.map((cell) => cell.map(inlinePlainText).join('')).join(' '))
            .join('\n');
        case 'list':
          return block.items.map(readingPlainText).join('\n');
        case 'quote':
          return readingPlainText(block.children);
        case 'rule':
          return '';
        case 'text':
          return block.value;
      }
    })
    .join('\n')
    .trim();

const inlinePlainText = (inline: ReadInline): string => {
  switch (inline.kind) {
    case 'text':
      return inline.value;
    case 'code':
    case 'math':
      return inline.value;
    case 'image':
      return inline.alt;
    case 'wiki':
      return inline.label;
    case 'break':
      return '\n';
    default:
      return inline.children.map(inlinePlainText).join('');
  }
};
