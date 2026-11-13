import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { DocId } from '#doc-model';
import { tooltips } from '@codemirror/view';
import type { KernelContext } from '../../kernel/context.ts';
import { filterCommands } from '../commands/palette.ts';
import { isInsideCode } from './wiki-link.ts';

export interface SlashCommandOptions {
  /** 命令总线用例：只要求 list/execute，测试可以传替身，不必构造整个 kernel */
  readonly commands: Pick<KernelContext['commands'], 'list' | 'execute'>;
  readonly docId: DocId;
  readonly onError: (message: string) => void;
  /** 额外补全源（如 [[ 双链补全）：与斜杠源共用同一个 autocompletion 实例 */
  readonly extraSources?: readonly CompletionSource[];
}

/**
 * `/` 菜单的触发判定。
 * 参数是从行首到光标的文本：命中返回斜杠后的关键词，否则返回 null。
 * 触发位是"词首"：行首、缩进后、列表/引用标记之后，以及正文中空白之后；
 * 关键词里不能出现空白或第二个斜杠，所以 `a/b`、`https://x`、`2026/11/13` 不会误触发。
 */
const SLASH_AT_WORD_START = /(?:^|[ \t])\/([^\s/]*)$/;

export const slashQuery = (linePrefix: string): string | null => {
  const match = SLASH_AT_WORD_START.exec(linePrefix);
  return match === null ? null : (match[1] ?? '');
};

/**
 * 编辑器里的 `/` 命令菜单的补全源。
 * 候选来自既有命令总线（editor + global 两个作用域），过滤复用命令面板的 filterCommands，
 * 执行也走 commands.execute；这里只负责把 `/关键词` 从正文删掉，并补上当前文档 id。
 * 上下键、Enter、Esc 由 CodeMirror 的 completionKeymap（默认开启）统一处理。
 * 代码块与行内代码里不弹菜单，避免写路径 `/usr/local` 时被打扰。
 */
export const slashCompletionSource =
  ({ commands, docId, onError }: SlashCommandOptions) =>
  (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\/[^\s/]*$/);
    if (match === null) return null;

    const line = context.state.doc.lineAt(match.from);
    const query = slashQuery(context.state.doc.sliceString(line.from, context.pos));
    if (query === null) return null;
    if (isInsideCode(context.state, match.from)) return null;

    const candidates = filterCommands(
      commands
        .list()
        .filter((command) => command.scope === 'editor' || command.scope === 'global'),
      query,
    );
    if (candidates.length === 0) return null;

    const options = candidates.map(
      (command): Completion => ({
        label: command.title,
        detail: command.scope === 'editor' ? '当前文档' : '全局',
        type: 'keyword',
        apply: (view, _completion, _from, to) => {
          view.dispatch({
            changes: { from: match.from, to, insert: '' },
            selection: { anchor: match.from },
          });
          // 与命令面板一致：只有编辑器命令需要 docId，全局命令不传参数
          const args = command.scope === 'editor' ? { docId } : undefined;
          void commands.execute(command.id, args).then((result) => {
            if (!result.ok && result.error !== null) onError(result.error);
          });
        },
      }),
    );

    return {
      // 斜杠本身由 apply 处理，参与过滤的只有它后面的关键词
      from: match.from + 1,
      to: context.pos,
      options,
      filter: false,
    };
  };

export const slashCommands = (options: SlashCommandOptions) => [
  autocompletion({
    override: [slashCompletionSource(options), ...(options.extraSources ?? [])],
    activateOnTyping: true,
    icons: false,
  }),
  /**
   * 补全浮层默认按整个窗口算可用空间，于是它会朝浮窗下边缘方向铺开，
   * 一旦超出就被 .float 的 overflow:hidden 裁掉（命令能触发但看不全）。
   * 把可用空间限定在编辑器的可见滚动区，CodeMirror 的空间不够就自动翻到光标上方、
   * 超出就压高度，浮层因此始终落在浮窗内部，不需要 portal，也不改动浮窗的裁切与圆角。
   */
  tooltips({
    tooltipSpace: (view) => {
      const rect = view.scrollDOM.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    },
  }),
];
