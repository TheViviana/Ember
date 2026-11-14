import { useCallback, useEffect, useRef, useState } from 'react';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import {
  aiKeySaved,
  cancelPublicTranslate,
  describeAiError,
  startChat,
  translatePublicBlock,
  type ChatSession,
} from '../../data/tauri/ai.ts';
import { translationChannelChanged } from './translation-channel.ts';
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
 * 整篇双语对照的会话：按设置里的翻译通道逐段串行取译文，译文只留在当前浮窗的视图层。
 * model 通道走 ai_chat_stream；public 通道走 Rust 侧的公共免费接口。
 * 不写 ui.json、不写 localStorage；离开阅读态、关闭浮窗或切换通道即中止并清空。
 */
export const useTranslation = () => {
  const ai = useMachineStore((state) => state.ai);
  const translationChannel = useMachineStore((state) => state.translationChannel);
  const [state, setState] = useState<TranslationState>(IDLE);
  /** 云端提供方还要有密钥；Ollama 与公共免费接口不需要 */
  const [keyReady, setKeyReady] = useState<boolean>(ai.provider === 'ollama');
  const runIdRef = useRef(0);
  const sessionRef = useRef<ChatSession | null>(null);
  const publicRequestRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    if (translationChannel === 'public' || ai.provider === 'ollama') {
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
  }, [ai, translationChannel]);

  const cancelSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session !== null) void session.cancel();
  }, []);

  const cancelPublic = useCallback((): void => {
    const requestId = publicRequestRef.current;
    publicRequestRef.current = null;
    if (requestId !== null) void cancelPublicTranslate(requestId);
  }, []);

  const cancelActive = useCallback((): void => {
    cancelSession();
    cancelPublic();
  }, [cancelSession, cancelPublic]);

  // 卸载 / 切换文档时中止取数，避免后台继续占用连接
  useEffect(
    () => () => {
      runIdRef.current += 1;
      cancelActive();
    },
    [cancelActive],
  );

  /** 收起译文：中止进行中的翻译并清空视图层 */
  const restore = useCallback((): void => {
    runIdRef.current += 1;
    cancelActive();
    setState(IDLE);
  }, [cancelActive]);

  const stop = restore;

  // 切换通道立即取消进行中的取数，避免旧通道的结果落进新通道的视图
  const channelRef = useRef(translationChannel);
  useEffect(() => {
    if (!translationChannelChanged(channelRef.current, translationChannel)) return;
    channelRef.current = translationChannel;
    restore();
  }, [translationChannel, restore]);

  const start = useCallback(
    (markdown: string): void => {
      const publicChannel = translationChannel === 'public';
      if (!publicChannel && (ai.model.trim() === '' || ai.baseUrl.trim() === '')) {
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
      cancelActive();
      setState({ phase: 'running', entries: {}, total: blocks.length, done: 0, note: null });

      const update = (next: (current: TranslationState) => TranslationState): void => {
        setState((current) => (runIdRef.current !== id ? current : next(current)));
      };

      if (publicChannel) {
        void (async () => {
          let failed = 0;
          let firstError: string | null = null;
          for (const block of blocks) {
            if (runIdRef.current !== id) return;
            const requestId = crypto.randomUUID();
            publicRequestRef.current = requestId;
            try {
              const outcome = await translatePublicBlock(block.text, requestId);
              if (runIdRef.current !== id) return;
              publicRequestRef.current = null;
              failed += outcome.failed;
              update((current) => ({
                ...current,
                entries: { ...current.entries, [block.index]: outcome.text },
                done: current.done + 1,
              }));
            } catch (cause) {
              if (runIdRef.current !== id) return;
              publicRequestRef.current = null;
              failed += 1;
              if (firstError === null) firstError = describeAiError(cause);
              // 整段请求失败：不写 entry，原文照旧
              update((current) => ({ ...current, done: current.done + 1 }));
            }
          }
          if (runIdRef.current !== id) return;
          update((current) => ({
            ...current,
            phase: 'done',
            note:
              failed === 0
                ? null
                : `${failed} 处翻译失败，已保留原文${firstError === null ? '' : `：${firstError}`}`,
          }));
        })();
        return;
      }

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
    [ai, cancelActive, translationChannel],
  );

  /** 未配置或暂无密钥时入口置灰：公共免费接口不需要模型与密钥 */
  const ready =
    translationChannel === 'public' ||
    (ai.model.trim() !== '' && ai.baseUrl.trim() !== '' && keyReady);

  return { state, ready, start, stop, restore };
};
