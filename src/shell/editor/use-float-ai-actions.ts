import { useCallback, useRef, useState } from 'react';
import type { useFloatDocument } from './use-float-document.ts';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import { startChat } from '../../data/tauri/ai.ts';
import type { KernelContext } from '../../kernel/context.ts';
import type { InlineAnchor } from '../ai/use-inline-ai.ts';
import type { InlineAi } from '../ai/use-inline-ai.ts';

type FloatDocument = ReturnType<typeof useFloatDocument>;

export type FloatAiActionsDoc = Pick<
  FloatDocument,
  'viewRef' | 'panelRef' | 'clearSelectionAnchor' | 'actionsRef' | 'phase'
>;

export interface FloatAiActions {
  readonly aiModelReady: boolean;
  readonly aiSummaryBusy: boolean;
  readonly aiSummaryError: string | null;
  readonly generateAiSummary: () => void;
  readonly applyContinue: () => void;
}

/**
 * 浮窗内的 AI 快捷动作：一键简介（写回 frontmatter.summary）与光标续写。
 * 都是一次性流式会话：busy/error 展示在标签栏 hint 与内联块上，不进持久化。
 */
export const useFloatAiActions = (
  kernel: KernelContext,
  doc: FloatAiActionsDoc,
  inlineAi: InlineAi,
): FloatAiActions => {
  const ai = useMachineStore((state) => state.ai);
  const [aiSummaryBusy, setAiSummaryBusy] = useState(false);
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);
  const busyRef = useRef(false);
  busyRef.current = aiSummaryBusy;

  const aiModelReady = ai.model.trim() !== '' && ai.baseUrl.trim() !== '';

  /** 一键简介：按正文生成 80 字以内的摘要，直接走 commitSummary 落 frontmatter */
  const generateAiSummary = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null || busyRef.current) return;
    if (kernel.env.readonlyMode) {
      setAiSummaryError('只读模式下无法写入简介。');
      return;
    }
    const body = view.state.doc.toString();
    if (body.trim().length === 0) {
      setAiSummaryError('正文为空，先写点内容再生成简介。');
      return;
    }
    setAiSummaryError(null);
    setAiSummaryBusy(true);
    let text = '';
    const session = startChat(
      ai,
      [
        {
          role: 'system',
          content: '你是 Ember 的本地知识库助手。只输出结果本身，不输出任何前后缀、解释或引号。',
        },
        {
          role: 'user',
          content:
            '为下面的文章写一段中文简介：80 字以内、一句话到两句话，概括核心主题与结论，不逐条列举，不使用 Markdown 标记。\n\n文章正文：\n' +
            body.slice(0, 6000),
        },
      ],
      {
        onDelta: (delta) => {
          text += delta;
        },
        onDone: () => {
          setAiSummaryBusy(false);
          const clean = text
            .trim()
            .replace(/^["「『]|["」』]$/g, '')
            .replace(/\s*\n\s*/g, ' ')
            .slice(0, 120);
          if (clean.length === 0) {
            setAiSummaryError('AI 没有返回内容，请重试。');
            return;
          }
          doc.actionsRef.current?.commitSummary(clean);
        },
        onError: (message) => {
          setAiSummaryBusy(false);
          setAiSummaryError(`简介生成失败：${message}`);
        },
      },
    );
    void session.done.finally(() => {
      setAiSummaryBusy(false);
    });
  }, [ai, doc, kernel]);

  /** 光标处 AI 续写：以光标前 1500 字为上下文，结果插在光标处 */
  const applyContinue = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    const main = view.state.selection.main;
    const head = main.head;
    const contextFrom = Math.max(0, head - 1500);
    const context = view.state.sliceDoc(contextFrom, head);
    if (context.trim().length === 0) return;
    const coords = view.coordsAtPos(head);
    const panel = doc.panelRef.current;
    if (coords === null || panel === null) return;
    const rect = panel.getBoundingClientRect();
    doc.clearSelectionAnchor();
    const anchor: InlineAnchor = {
      left: coords.left - rect.left,
      top: coords.top - rect.top,
      width: 1,
      height: Math.max(1, coords.bottom - coords.top),
    };
    inlineAi.start({
      action: 'continue',
      anchor,
      from: head,
      to: head,
      text: context,
      readBody: () => view.state.doc.toString(),
    });
  }, [doc, inlineAi]);

  return { aiModelReady, aiSummaryBusy, aiSummaryError, generateAiSummary, applyContinue };
};
