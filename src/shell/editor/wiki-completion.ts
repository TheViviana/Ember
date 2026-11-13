import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorState, Text } from '@codemirror/state';
import { isInsideCode } from './wiki-link.ts';

/** 双链补全候选的最小文档信息；与 DocMeta 的字段对齐，测试可传替身 */
export interface WikiCompletionDoc {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly aliases: readonly string[];
}

export interface WikiCompletionOptions {
  /** 文档清单走 ref 读取：编辑器会话只创建一次，候选不能被闭包冻住 */
  readonly getDocuments: () => readonly WikiCompletionDoc[];
}

const MAX_OPTIONS = 12;

/** EditorState 的 sliceString 在 Text 类型上；统一从 doc 取，避免类型分叉 */
const stateSlice = (state: EditorState, from: number, to: number): string => {
  const doc: Text = state.doc;
  return doc.sliceString(from, to);
};

const stemOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  const file = at === -1 ? path : path.slice(at + 1);
  return file.replace(/\.md$/i, '');
};

interface Candidate {
  readonly label: string;
  readonly detail: string;
  readonly score: number;
}

/**
 * `[[` 双链自动补全。
 * 触发：光标前是 `[[` 且其后没有 `]`、换行（label 里不允许再出现方括号）；
 * 候选按标题前缀 > 标题包含 > 别名 > 路径 排序，最多 12 条。
 * 应用时插入 `[[标题]]` 并把光标放在 `]]` 前，方便继续写别名或锚点。
 */
export const wikiCompletionSource =
  ({ getDocuments }: WikiCompletionOptions) =>
  (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[([^\]\n]*)$/);
    if (match === null) return null;
    if (isInsideCode(context.state, match.from)) return null;

    const query = stateSlice(context.state, match.from + 2, context.pos).trim().toLowerCase();
    const ranked: Candidate[] = [];
    for (const doc of getDocuments()) {
      const title = doc.title.trim();
      const label = title.length > 0 ? title : stemOf(doc.path);
      if (label.length === 0) continue;
      const lower = label.toLowerCase();
      let score: number | null = null;
      let detail = doc.path;
      if (query.length === 0) {
        score = 3;
      } else if (lower.startsWith(query)) {
        score = 0;
      } else if (lower.includes(query)) {
        score = 1;
      } else {
        const alias = doc.aliases.find((item) => item.toLowerCase().includes(query));
        if (alias !== undefined) {
          score = 2;
          detail = `别名：${alias}`;
        } else if (doc.path.toLowerCase().includes(query)) {
          score = 2;
          detail = doc.path;
        }
      }
      if (score !== null) ranked.push({ label, detail, score });
    }
    if (ranked.length === 0) return null;

    ranked.sort((left, right) => left.score - right.score || left.label.localeCompare(right.label, 'zh-Hans-CN'));
    const options: readonly Completion[] = ranked.slice(0, MAX_OPTIONS).map((candidate) => ({
      label: candidate.label,
      detail: candidate.detail,
      type: 'text',
      apply: (view, _completion, _from, to) => {
        // match.from 指向 `[[` 的第一个字符，整个 `[[query` 由 `[[title]]` 替换
        const insert = `[[${candidate.label}]]`;
        view.dispatch({
          changes: { from: match.from, to, insert },
          selection: { anchor: match.from + insert.length - 2 },
          userEvent: 'input.wiki',
        });
      },
    }));

    return { from: match.from + 2, to: context.pos, options, filter: false };
  };
