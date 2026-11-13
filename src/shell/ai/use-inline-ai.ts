import { useCallback, useEffect, useRef, useState } from 'react';
import { splitFrontmatter, type DocId } from '#doc-model';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import { describeAiError, startChat, type ChatSession } from '../../data/tauri/ai.ts';
import type { KernelContext } from '../../kernel/context.ts';
import type { DocRevision } from '../../kernel/types.ts';
import { findAiAction, type AiActionId, type AiApplyMode } from './actions.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { buildContinuePrompt, buildSelectionPrompt, SYSTEM_PROMPT } from './context.ts';
import { undoLabel, undoProposalDoc, type UndoAction } from './proposal.ts';

/** 相对浮窗面板左上角的选区矩形，进入内联块后即冻结 */
export interface InlineAnchor {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type InlinePhase = 'streaming' | 'ready' | 'error' | 'replaced';

export interface InlineRun {
  readonly action: AiActionId;
  readonly label: string;
  /** 产物落盘方式：改写类可替换选区，说明类只能插到选区之后 */
  readonly apply: AiApplyMode;
  readonly anchor: InlineAnchor;
  readonly phase: InlinePhase;
  readonly text: string;
  readonly error: string | null;
  readonly notice: string | null;
  readonly undoText: string | null;
  readonly busy: boolean;
}

export interface InlineStartInput {
  readonly action: AiActionId;
  readonly anchor: InlineAnchor;
  /** 选区在正文中的偏移（frontmatter 已剥离） */
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** 当前编辑器正文；替换前用它识别未落盘的本地编辑 */
  readonly readBody: () => string | null;
}

export const INLINE_STALE_MESSAGE = '文章在生成之后已被修改，已作废；请重新选中生成。';
export const INLINE_RANGE_MESSAGE = '这次写入会改动选中段之外的正文，已作废；请重新选中生成。';
export const INLINE_EMPTY_MESSAGE = 'AI 没有返回内容，请重试。';
export const INLINE_NO_MODEL_MESSAGE = '先在设置里填写模型名称，再使用文章操作。';
/** 只读文案与状态栏同源：带上具体原因，而不是笼统「只读模式」 */
export const inlineReadonlyMessage = (reason: string | null): string =>
  `${readonlyText(reason)}，无法替换正文。`;

interface RunMeta {
  readonly base: DocRevision;
  readonly from: number;
  readonly to: number;
  /** 发起时的选区原文：落盘前用它确认这段偏移仍然指向同一段文字 */
  readonly selected: string;
  readonly title: string;
  readonly readBody: () => string | null;
}

/**
 * 选区 AI 的内联会话：流式结果、丢弃、替换与撤销都只活在当前浮窗内，
 * 不写 ui.json，也不用 localStorage。同一时间只保留一个内联块。
 */
export type InlineAi = ReturnType<typeof useInlineAi>;

export const useInlineAi = (kernel: KernelContext, docId: DocId) => {
  const ai = useMachineStore((state) => state.ai);
  const [run, setRun] = useState<InlineRun | null>(null);
  const runIdRef = useRef(0);
  const sessionRef = useRef<ChatSession | null>(null);
  const metaRef = useRef<RunMeta | null>(null);
  const undoRef = useRef<UndoAction | null>(null);

  const cancelSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session !== null) void session.cancel();
  }, []);

  const close = useCallback((): void => {
    runIdRef.current += 1;
    cancelSession();
    metaRef.current = null;
    undoRef.current = null;
    setRun(null);
  }, [cancelSession]);

  useEffect(
    () => () => {
      // 卸载 / 切换文档时中止流，避免后台继续占用连接
      cancelSession();
    },
    [cancelSession],
  );

  const start = useCallback(
    (input: InlineStartInput): void => {
      if (kernel.env.readonlyMode) {
        setRun({
          action: input.action,
          label: findAiAction(input.action)?.label ?? '',
          apply: findAiAction(input.action)?.apply ?? 'insert',
          anchor: input.anchor,
          phase: 'error',
          text: '',
          error: inlineReadonlyMessage(kernel.env.readonlyReason),
          notice: null,
          undoText: null,
          busy: false,
        });
        return;
      }
      const action = findAiAction(input.action);
      if (action === undefined) return;
      // 续写是光标级操作（from === to），text 里装的是光标前的上下文；
      // 其余操作必须有非空选区
      const isContinue = input.action === 'continue';
      if (isContinue) {
        if (input.from !== input.to || input.text.trim() === '') return;
      } else if (input.to <= input.from || input.text.trim() === '') {
        return;
      }

      cancelSession();
      runIdRef.current += 1;
      const id = runIdRef.current;
      metaRef.current = null;
      undoRef.current = null;
      setRun({
        action: action.id,
        label: action.label,
        apply: action.apply,
        anchor: input.anchor,
        phase: 'streaming',
        text: '',
        error: null,
        notice: null,
        undoText: null,
        busy: false,
      });

      if (ai.model.trim() === '') {
        setRun((current) =>
          current === null ? current : { ...current, phase: 'error', error: INLINE_NO_MODEL_MESSAGE },
        );
        return;
      }

      const update = (next: (current: InlineRun) => InlineRun): void => {
        setRun((current) => (current === null || runIdRef.current !== id ? current : next(current)));
      };

      void (async () => {
        try {
          // 只为拿目录元数据（标题 / 修订号），不读正文：请求体积必须与选区同量级
          const metas = await kernel.docs.list();
          if (runIdRef.current !== id) return;
          const meta = metas.find((entry) => String(entry.id) === String(docId));
          if (meta === undefined) {
            update((current) => ({ ...current, phase: 'error', text: '', error: INLINE_STALE_MESSAGE }));
            return;
          }
          metaRef.current = {
            base: meta.rev,
            from: input.from,
            to: input.to,
            // 续写没有选区：偏移处是空串，落盘前的区间复核仍然成立
            selected: isContinue ? '' : input.text,
            title: meta.title,
            readBody: input.readBody,
          };
          const prompt = isContinue
            ? buildContinuePrompt(meta.title, input.text)
            : buildSelectionPrompt(action.id, meta.title, input.text);
          const session = startChat(
            ai,
            [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            {
              onDelta: (delta) => {
                update((current) => ({ ...current, text: current.text + delta }));
              },
              onDone: () => {
                update((current) =>
                  current.text.trim() === ''
                    ? { ...current, phase: 'error', text: '', error: INLINE_EMPTY_MESSAGE }
                    : { ...current, phase: 'ready' },
                );
              },
              onError: (message) => {
                update((current) => ({ ...current, phase: 'error', text: '', error: message }));
              },
            },
          );
          if (runIdRef.current !== id) {
            void session.cancel();
            return;
          }
          sessionRef.current = session;
        } catch (cause) {
          update((current) => ({
            ...current,
            phase: 'error',
            text: '',
            error: describeAiError(cause),
          }));
        }
      })();
    },
    [ai, docId, kernel, cancelSession],
  );

  /** 生成中取消：整块收起，半截内容不保留 */
  const stop = close;
  /** 丢弃生成结果，不改正文 */
  const discard = close;

  /** 落盘：改写类替换选区，说明类插到选区之后；两者都只在区间内改动 */
  const apply = useCallback((): void => {
    const current = run;
    const meta = metaRef.current;
    if (current === null || meta === null || current.phase !== 'ready' || current.busy) return;
    // 本轮会话 id：apply 的全部异步完成路径都过 runId 守卫——
    // 关闭后立刻开启的新会话不得被旧会话的迟到结果整体覆写（与流式路径同一防护）
    const id = runIdRef.current;
    const stale = (): boolean => runIdRef.current !== id;
    const patch = (next: (latest: InlineRun) => InlineRun): void => {
      setRun((latest) => (latest === null || runIdRef.current !== id ? latest : next(latest)));
    };
    if (kernel.env.readonlyMode) {
      setRun({ ...current, phase: 'error', error: inlineReadonlyMessage(kernel.env.readonlyReason) });
      return;
    }
    const inserting = current.apply === 'insert';
    setRun({ ...current, busy: true, error: null });
    void (async () => {
      const abort = (message: string): void => {
        if (stale()) return; // meta/undo 归新会话所有，本轮不得清理
        metaRef.current = null;
        setRun({ ...current, phase: 'error', text: '', error: message, busy: false });
      };
      try {
        const live = meta.readBody();
        if (live === null) {
          abort(INLINE_STALE_MESSAGE);
          return;
        }
        const latest = await kernel.docs.read(docId);
        const diskBody = splitFrontmatter(latest.text).body;
        // 编辑区与磁盘逐字节一致、修订号仍是发起时那一个，才允许落盘
        if (latest.meta.rev.hash !== meta.base.hash || diskBody !== live) {
          abort(INLINE_STALE_MESSAGE);
          return;
        }
        // 这段偏移必须仍指向当时选中的那段文字，否则说明正文在此期间被改过
        if (meta.to > diskBody.length || diskBody.slice(meta.from, meta.to) !== meta.selected) {
          abort(INLINE_STALE_MESSAGE);
          return;
        }
        // 插入是 [to,to) 的空区间：不删原文，只在选区末尾落字
        const writeFrom = inserting ? meta.to : meta.from;
        const writeTo = meta.to;
        const prefix = diskBody.slice(0, writeFrom);
        const suffix = diskBody.slice(writeTo);
        const insert = current.text;
        const nextBody = `${prefix}${insert}${suffix}`;
        // 写前复核：拼出的新正文除 [writeFrom,writeTo) 之外与原文逐字节相同
        const outsideIntact =
          nextBody.length === prefix.length + insert.length + suffix.length &&
          nextBody.slice(0, prefix.length) === prefix &&
          nextBody.slice(prefix.length, prefix.length + insert.length) === insert &&
          nextBody.slice(prefix.length + insert.length) === suffix;
        if (!outsideIntact) {
          abort(INLINE_RANGE_MESSAGE);
          return;
        }
        if (nextBody === diskBody) {
          if (stale()) return;
          metaRef.current = null;
          patch(() => ({
            ...current,
            phase: 'replaced',
            busy: false,
            notice: '生成内容与选中文本一致，正文未改动',
            undoText: null,
          }));
          return;
        }
        const outcome = await kernel.docs.update(
          docId,
          { body: nextBody },
          { base: latest.meta.rev, intent: 'user' },
        );
        if (outcome.conflict !== null) {
          if (stale()) return;
          const conflictPath = String(outcome.conflict.path);
          metaRef.current = null;
          patch(() => ({
            ...current,
            phase: 'error',
            text: '',
            error: `三方合并失败，已保留磁盘版本并生成冲突副本：${conflictPath}`,
            busy: false,
          }));
          return;
        }
        const undo: UndoAction = {
          kind: 'restore-body',
          docId,
          title: meta.title,
          body: diskBody,
          appliedBody: nextBody,
        };
        if (stale()) return;
        undoRef.current = undo;
        metaRef.current = null;
        patch(() => ({
          ...current,
          phase: 'replaced',
          busy: false,
          notice: inserting
            ? current.action === 'continue'
              ? '已在光标处续写'
              : '已插入到选区之后'
            : '已替换选中文本',
          undoText: inserting ? `撤销插入《${meta.title}》` : undoLabel(undo),
        }));
      } catch (cause) {
        if (stale()) return;
        setRun({ ...current, phase: 'error', text: '', error: describeAiError(cause), busy: false });
      }
    })();
  }, [docId, kernel, run]);

  const undo = useCallback((): void => {
    const action = undoRef.current;
    const current = run;
    if (action === null || current === null || current.busy) return;
    // 与 apply 相同的 runId 守卫：迟到结果不覆写新会话，也不误清新会话的 undoRef
    const id = runIdRef.current;
    const stale = (): boolean => runIdRef.current !== id;
    const patch = (next: (latest: InlineRun) => InlineRun): void => {
      setRun((latest) => (latest === null || runIdRef.current !== id ? latest : next(latest)));
    };
    setRun({ ...current, busy: true, error: null });
    void (async () => {
      try {
        const message = await undoProposalDoc(kernel.docs, action);
        if (stale()) return;
        undoRef.current = null;
        patch((latest) =>
          latest === null
            ? latest
            : {
                ...latest,
                busy: false,
                notice:
                  latest.apply === 'insert' ? '已撤销插入，正文已还原' : message,
                undoText: null,
                phase: latest.phase === 'replaced' ? 'replaced' : latest.phase,
              },
        );
      } catch (cause) {
        if (stale()) return;
        patch((latest) =>
          latest === null ? latest : { ...latest, busy: false, error: describeAiError(cause) },
        );
      }
    })();
  }, [kernel, run]);

  return { run, start, stop, discard, apply, undo, close };
};
