import { findAiAction, type AiActionId } from './actions.ts';

export const SYSTEM_PROMPT =
  '你是 Ember 的本地知识库助手。只处理用户给出的片段，不要假设自己读过别的内容；' +
  '信息不足时直接说明缺少什么。使用简体中文，不输出寒暄。';

/**
 * 选区操作的提示词：只装选中片段与文章标题，不读、也不送整篇正文。
 * 标题仅用于统一称呼与语气，不构成可改写的语料；请求体积与选区长度同量级。
 */
export const buildSelectionPrompt = (
  actionId: AiActionId,
  title: string,
  selectedText: string,
): string => {
  const action = findAiAction(actionId);
  if (action === undefined) throw new Error(`未知的 AI 操作：${actionId}`);
  return `${action.instruction}\n\n文章标题：${title}\n\n选中片段：\n${selectedText}`;
};
