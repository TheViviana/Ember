import { asDocId, type DocId } from '#doc-model';
import type { CommandDescriptor } from '../../kernel/types.ts';

/**
 * 命令面板与斜杠菜单共用的纯函数。
 * 命令本身只通过 kernel.commands 注册与执行，这里不持有任何命令实现。
 */

export const filterCommands = (
  commands: readonly CommandDescriptor[],
  query: string,
): readonly CommandDescriptor[] => {
  const keyword = query.trim().toLowerCase();
  if (keyword === '') return commands;
  return commands.filter(
    (command) =>
      command.title.toLowerCase().includes(keyword) ||
      String(command.id).toLowerCase().includes(keyword),
  );
};

export const scopeLabel = (scope: CommandDescriptor['scope']): string => {
  switch (scope) {
    case 'editor':
      return '当前文档';
    case 'canvas':
      return '画布';
    default:
      return '全局';
  }
};

/**
 * 编辑器命令的约定参数：面板与斜杠菜单把当前文档 id 放进 args。
 * 命令总线没有可用的 surface 上下文（setSurface 只在 host 内部），因此不去依赖 ctx.docId。
 */
export const editorArgsFor = (docId: DocId | null): { readonly docId: DocId } | null =>
  docId === null ? null : { docId };

export const commandDocId = (args: unknown): DocId | null => {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as { docId?: unknown }).docId;
  return typeof value === 'string' ? asDocId(value) : null;
};
