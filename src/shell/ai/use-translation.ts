import { useCallback, useEffect, useRef, useState } from 'react';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import { aiKeySaved, describeAiError, startChat, type ChatSession } from '../../data/tauri/ai.ts';
import { buildTranslatePrompt, translatableBlocks, TRANSLATE_SYSTEM_PROMPT } from './translate.ts';

export type TranslationPhase = 'idle' | 'running' | 'done';

export interface TranslationState {
  readonly phase: TranslationPhase;
  /** 顶层块下标 → 译文纯文本；流式期间也会随增量更新 */
  readonly entries: Readonly<Record<number, string>>;
  readonly total: number;
  readonly done: number;
  /** 失败、空段、未配置等提示；只做展示，不参与落盘 */
  readonly note: string | null;
}

const IDLE: TranslationState = { phase: 'idle', entries: {}, total: 0, done: 0, note: null };

export const TRANSLATE_NOT_CONFIGURED = '先在设置里配置 AI 提供方与模型。';
export const TRANSLATE_EMPTY_MESSAGE = '这篇文章没有需要翻译的外文段落。';

/**
 * 整篇双语对照的会话：逐段串行走 ai_chat_stream，译文只留在当前浮窗的视图层。
 * 不写 ui.json、不写 localStorage；离开阅读态或关闭浮窗即中止并清空。
 */
export const useTranslation = () => {
  const ai = useMachineStore((state) => state.ai);
  const [state, setState] = useState<TranslationState>(IDLE);
  /** 云端提供方还要有密钥；Ollama 不需要 */
  const [keyReady, setKeyReady] = useState<boolean>(ai.provider === 'ollama');
  const runIdRef = useRef(0);
  const sessionRef = useRef<ChatSession | null>(null);

  useEffect(() => {
    let active = true;
    if (ai.provider === 'ollama') {
      setKeyReady(true);
      return () => {
        active = false;
      };
    }
    setKeyReady(false);
    void aiKeySaved(ai)
      .then((saved) => {
        if (active) setKeyReady(saved);
      })
      .catch(() => {
        if (active) setKeyReady(false);
      });
    return () => {
      active = false;
    };
  }, [ai]);

  const cancelSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session !== null) void session.cancel();
  }, []);

  // 卸载 / 切换文档时中止流，避免后台继续占用连接
  useEffect(
    () => () => {
      runIdRef.current += 1;
      cancelSession();
    },
    [cancelSession],
  );

  /** 收起译文：中止进行中的翻译并清空视图层 */
  const restore = useCallback((): void => {
    runIdRef.current += 1;
    cancelSession();
    setState(IDLE);
  }, [cancelSession]);

  const stop = restore;

  const start = useCallback(
    (markdown: string): void => {
      if (ai.model.trim() === '' || ai.baseUrl.trim() === '') {
        setState({ ...IDLE, note: TRANSLATE_NOT_CONFIGURED });
        return;
      }
      const blocks = translatableBlocks(markdown);
      if (blocks.length === 0) {
        setState({ ...IDLE, note: TRANSLATE_EMPTY_MESSAGE });
        return;
      }

      runIdRef.current += 1;
      const id = runIdRef.current;
      cancelSession();
      setState({ phase: 'running', entries: {}, total: blocks.length, done: 0, note: null });

      const update = (next: (current: TranslationState) => TranslationState): void => {
        setState((current) => (runIdRef.current !== id ? current : next(current)));
      };

      void (async () => {
        let failed = 0;
        let firstError: string | null = null;
        for (const block of blocks) {
          if (runIdRef.current !== id) return;
          const outcome = await new Promise<{ text: string | null; error: string | null }>((resolve) => {
            let buffered = '';
            let settled = false;
            let session: ChatSession;
            try {
              session = startChat(
                ai,
                [
                  { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
                  { role: 'user', content: buildTranslatePrompt(block.text) },
                ],
                {
                  onDelta: (delta) => {
                    buffered += delta;
                    update((current) =>
                      current.phase === 'running'
                        ? { ...current, entries: { ...current.entries, [block.index]: buffered } }
                        : current,
                    );
                  },
                  onDone: () => {
                    if (settled) return;
                    settled = true;
                    resolve({ text: buffered.trim(), error: null });
                  },
                  onError: (message) => {
                    if (settled) return;
                    settled = true;
                    resolve({ text: null, error: message });
                  },
                },
              );
            } catch (cause) {
              resolve({ text: null, error: describeAiError(cause) });
              return;
            }
            sessionRef.current = session;
            void session.done.then(() => {
              // done 在 onDone / onError 之后必然已 settle；这里只兜住不发事件的极端收尾
              if (settled) return;
              settled = true;
              resolve({ text: buffered.trim(), error: null });
            });
          });
          if (runIdRef.current !== id) return;
          sessionRef.current = null;
          if (outcome.text === null || outcome.text === '') {
            failed += 1;
            if (firstError === null && outcome.error !== null) firstError = outcome.error;
            // 失败段回落原文：撤掉半截流式文本，只留原文
            update((current) => {
              const entries = { ...current.entries };
              delete entries[block.index];
              return { ...current, entries, done: current.done + 1 };
            });
            continue;
          }
          update((current) => ({ ...current, done: current.done + 1 }));
        }
        if (runIdRef.current !== id) return;
        update((current) => ({
          ...current,
          phase: 'done',
          note:
            failed === 0
              ? null
              : `${failed} 段翻译失败，已保留原文${firstError === null ? '' : `：${firstError}`}`,
        }));
      })();
    },
    [ai, cancelSession],
  );

  /** 未配置或暂无密钥时入口置灰：给出同一条指引，不静默失败 */
  const ready = ai.model.trim() !== '' && ai.baseUrl.trim() !== '' && keyReady;

  return { state, ready, start, stop, restore };
};
