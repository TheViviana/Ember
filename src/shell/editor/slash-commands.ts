import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { DocId } from '#doc-model';
import type { KernelContext } from '../../kernel/context.ts';
import { filterCommands } from '../commands/palette.ts';

export interface SlashCommandOptions {
  readonly kernel: KernelContext;
  readonly docId: DocId;
  readonly onError: (message: string) => void;
}

/**
 * `/` 菜单的触发判定，只认行首或整行只有空白的情况。
 * 参数是从行首到光标的文本：命中返回斜杠后的关键词，否则返回 null。
 * 正文中间的斜杠（路径、日期、普通符号）不会命中，避免打扰写作。
 */
export const slashQuery = (linePrefix: string): string | null => {
  const match = /^[ \t]*\/([^\s/]*)$/.exec(linePrefix);
  return match === null ? null : (match[1] ?? '');
};

/**
 * 编辑器里的 `/` 命令菜单。
 * 候选来自既有命令总线（editor + global 两个作用域），过滤复用命令面板的 filterCommands，
 * 执行也走 commands.execute；这里只负责把 `/关键词` 从正文删掉，并补上当前文档 id。
 * 上下键、Enter、Esc 由 CodeMirror 的 autocompletion 统一处理。
 */
export const slashCommands = ({ kernel, docId, onError }: SlashCommandOptions) =>
  autocompletion({
    override: [
      (context: CompletionContext): CompletionResult | null => {
        const match = context.matchBefore(/\/[^\s/]*$/);
        if (match === null) return null;

        const line = context.state.doc.lineAt(match.from);
        const query = slashQuery(context.state.doc.sliceString(line.from, context.pos));
        if (query === null) return null;

        const commands = filterCommands(
          kernel.commands
            .list()
            .filter((command) => command.scope === 'editor' || command.scope === 'global'),
          query,
        );
        if (commands.length === 0) return null;

        const options = commands.map(
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
              void kernel.commands.execute(command.id, args).then((result) => {
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
      },
    ],
    activateOnTyping: true,
    icons: false,
  });
