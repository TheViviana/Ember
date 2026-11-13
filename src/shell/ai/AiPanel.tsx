import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  clampAiPanelRect,
  DEFAULT_PANEL_AREA,
  useMachineStore,
  type AiPanelRect,
  type PanelArea,
} from '../../data/stores/machine-store.ts';
import { splitFrontmatter } from '#doc-model';
import { startChat, describeAiError, type ChatSession, type ChatTurnInput } from '../../data/tauri/ai.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { mindMapMutations, parseMindMap } from './canvas-mindmap.ts';
import { useFloatStore } from '../editor/float-store.ts';
import { createUlid, unsafeContentHash, type CanvasId, type DocId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { readCapturePoint } from '../canvas/canvas-capture.ts';
import {
  applyProposalDoc,
  undoLabel,
  undoProposalDoc,
  type Proposal,
  type UndoAction,
} from './proposal.ts';
import {
  getDefaultSessionPort,
  hydrateSession,
  persistSession,
  type AiSessionProposalFile,
} from './session-store.ts';
import styles from './AiPanel.module.css';

interface AiPanelProps {
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}

interface Turn {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  /** 用户手动停止：气泡要有可见的「已停止」标记，不能停在流式占位符上 */
  readonly stopped?: boolean;
}

const SYSTEM_PROMPT =
  '你是 Ember 的本地知识库助手。只依据用户提供的文章内容作答，不要编造文中没有的事实；' +
  '信息不足时直接说明缺少什么。使用简体中文，不输出寒暄。';

export const AiPanel = ({ onClose, onOpenSettings }: AiPanelProps) => {
  const ai = useMachineStore((state) => state.ai);
  const aiPanel = useMachineStore((state) => state.panels.ai);
  const kernel = useKernel();
  const activeDocId = useFloatStore((state) => state.activeId);
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  /** 对话引用当前文章：发送时把正文作为上下文注入（不持久化，每次发送现读） */
  const [citeDoc, setCiteDoc] = useState(true);
  const [mindmapBusy, setMindmapBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoText, setUndoText] = useState<string | null>(null);
  /** 拖动 / 缩放过程中的临时矩形：只在松手时写回 ui.json */
  const [liveRect, setLiveRect] = useState<AiPanelRect | null>(null);
  const [area, setArea] = useState<PanelArea>(DEFAULT_PANEL_AREA);
  const sessionRef = useRef<ChatSession | null>(null);
  const undoRef = useRef<UndoAction | null>(null);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    kind: 'move' | 'resize';
    startX: number;
    startY: number;
    rect: AiPanelRect;
  } | null>(null);

  // -------- AI 会话持久化（阶段 7） --------
  const sessionPortRef = useRef(getDefaultSessionPort());
  const sessionHydratedRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);

  /** Proposal → 持久化格式：只存 base.hash，不存 rev */
  const proposalToFile = (p: Proposal): AiSessionProposalFile => {
    if (p.kind === 'create') return { kind: 'create', title: p.title, body: p.body };
    if (p.kind === 'replace') {
      return {
        kind: 'replace',
        docId: p.docId,
        base: { hash: p.base.hash },
        title: p.title,
        body: p.body,
        previousBody: p.previousBody,
      };
    }
    return {
      kind: 'delete',
      docId: p.docId,
      base: { hash: p.base.hash },
      title: p.title,
    };
  };

  /** 水合：启动只读一次；损坏 / 过期静默降级 */
  useEffect(() => {
    if (sessionHydratedRef.current) return;
    const vaultId = kernel.env.vaultId;
    if (!vaultId) {
      sessionHydratedRef.current = true;
      return;
    }
    sessionHydratedRef.current = true;
    void hydrateSession({
      vaultId,
      port: sessionPortRef.current,
      readDoc: async (id: DocId) => {
        try {
          const snap = await kernel.docs.read(id);
          return { meta: { rev: snap.meta.rev } };
        } catch {
          return null;
        }
      },
    }).then((result) => {
      if (result.fileError !== null) {
        setNotice(result.fileError);
        return;
      }
      if (result.turns.length > 0) {
        const maxId = result.turns.length * 2; // 保守推断，避免 id 冲突
        nextIdRef.current = maxId + 1;
        setTurns(result.turns.map((t, i) => ({ id: i + 1, role: t.role, content: t.content, ...(t.stopped === true ? { stopped: true } : {}) })));
      }
      if (result.proposal !== null) {
        const p = result.proposal;
        if (p.kind === 'create') {
          setProposal({ kind: 'create', title: p.title, body: p.body });
        } else {
          // replace / delete 需要 rev 占位：过期校验已在 hydrate 层做完，恢复的 proposal 到应用时
          // 会再走一次 applyProposalDoc 内的 base.hash 校验
          const baseRev = { rev: 0, hash: unsafeContentHash(p.base.hash) };
          if (p.kind === 'replace') {
            setProposal({
              kind: 'replace',
              docId: p.docId,
              base: baseRev,
              title: p.title,
              body: p.body,
              previousBody: p.previousBody,
            });
          } else {
            setProposal({ kind: 'delete', docId: p.docId, base: baseRev, title: p.title });
          }
        }
      }
      if (result.applyingDowngraded) {
        setNotice('上次程序在应用 AI 提案时意外退出，该提案已恢复为待确认（将在应用时再次校验）。');
      }
      if (result.staleProposalMessage !== null) {
        setNotice(result.staleProposalMessage);
      }
    });
  }, [kernel]);

  /** debounce 持久化：turns / proposal / streaming / busy 变化 → 500ms 后写盘 */
  useEffect(() => {
    if (!sessionHydratedRef.current) return; // 水合前不写盘
    const vaultId = kernel.env.vaultId;
    if (!vaultId) return;
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      const state: 'idle' | 'streaming' | 'applying' = streaming
        ? 'streaming'
        : busy && proposal !== null
          ? 'applying'
          : 'idle';
      void persistSession({
        vaultId,
        turns: turns.map((t) => ({ role: t.role, content: t.content, ...(t.stopped === true ? { stopped: true as const } : {}) })),
        proposal: proposal !== null ? proposalToFile(proposal) : null,
        state,
        port: sessionPortRef.current,
      });
      persistTimerRef.current = null;
    }, 500);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [kernel.env.vaultId, turns, proposal, streaming, busy]);

  /** 卸载前 flush 一次持久化，保证最后状态不丢；从 ref 读最新值避免 deps 数组膨胀 */
  const latestStateRef = useRef({ turns, proposal, streaming, busy, vaultId: kernel.env.vaultId });
  latestStateRef.current = { turns, proposal, streaming, busy, vaultId: kernel.env.vaultId };
  useEffect(() => {
    const port = sessionPortRef.current;
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }
      const { turns: t, proposal: p, streaming: s, busy: b, vaultId: v } = latestStateRef.current;
      if (!v) return;
      const state: 'idle' | 'streaming' | 'applying' = s ? 'streaming' : b && p !== null ? 'applying' : 'idle';
      void persistSession({
        vaultId: v,
        turns: t.map((turn) => ({ role: turn.role, content: turn.content })),
        proposal: p !== null ? proposalToFile(p) : null,
        state,
        port,
      });
    };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [turns]);

  // 主内容区（顶栏与状态栏之间）尺寸变化时重新夹取显示位置；不写回 ui.json
  useEffect(() => {
    const host = panelRef.current?.parentElement;
    if (host === null || host === undefined) return undefined;
    const measure = (): void => {
      setArea({ width: host.clientWidth, height: host.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      // 面板卸载时中止仍在进行的流，避免后台继续占用连接
      void sessionRef.current?.cancel();
      sessionRef.current = null;
    },
    [],
  );

  const stream = (outgoing: ChatTurnInput[], display: string): void => {
    const userTurn: Turn = { id: nextIdRef.current++, role: 'user', content: display };
    const assistantTurn: Turn = { id: nextIdRef.current++, role: 'assistant', content: '' };
    setTurns([...turns, userTurn, assistantTurn]);
    setError(null);
    setStreaming(true);
    const session = startChat(ai, outgoing, {
      onDelta: (delta) => {
        setTurns((current) =>
          current.map((turn, index) =>
            index === current.length - 1 ? { ...turn, content: turn.content + delta } : turn,
          ),
        );
      },
      onDone: () => {
        setStreaming(false);
      },
      onError: (message) => {
        setError(message);
        setStreaming(false);
      },
    });
    sessionRef.current = session;
    void session.done.finally(() => {
      if (sessionRef.current === session) sessionRef.current = null;
      setStreaming(false);
    });
  };

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text === '' || streaming) return;
    if (ai.model.trim() === '') {
      setError('先在设置里填写模型名称，再开始对话。');
      return;
    }
    const history: ChatTurnInput[] = turns
      .filter((turn) => turn.content.trim() !== '')
      .map((turn) => ({ role: turn.role, content: turn.content }));
    setInput('');
    // 引用当前文章：正文作为 system 上下文现读现用，不进持久化 turns
    const messages: ChatTurnInput[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (citeDoc && activeDocId !== null) {
      try {
        const snapshot = await kernel.docs.read(activeDocId);
        const body = splitFrontmatter(snapshot.text).body.slice(0, 8000);
        const title = snapshot.meta.title;
        messages.push({
          role: 'system',
          content:
            `当前文章《${title}》的正文如下，回答时优先依据它；正文之外的信息以用户输入为准：\n\n${body}`,
        });
      } catch {
        setError('读取当前文章失败，本次对话未附带正文。');
      }
    }
    messages.push(...history, { role: 'user', content: text });
    void stream(messages, text);
  };

  /** 把当前文章整理成思维导图落在当前画布：产物是普通画布节点，可自由拖动改写 */
  const generateCanvasMindMap = (): void => {
    if (mindmapBusy || streaming || busy) return;
    if (activeDocId === null) {
      setError('先打开一篇文档浮窗，再生成画布结构。');
      return;
    }
    const capture = readCapturePoint();
    if (capture === null) {
      setError('画布未就绪，先打开一张画布。');
      return;
    }
    setMindmapBusy(true);
    setError(null);
    void (async () => {
      try {
        const snapshot = await kernel.docs.read(activeDocId);
        const body = splitFrontmatter(snapshot.text).body;
        let text = '';
        let failure: string | null = null;
        const session = startChat(ai, [
          { role: 'system', content: '你是 Ember 的本地知识库助手。只输出要求的 JSON，不输出解释或代码围栏之外的内容。' },
          {
            role: 'user',
            content:
              '把下面的文章整理成思维导图。只输出一个 JSON 对象：{"title":"中心主题","children":[{"title":"分支","children":[...]}]}。' +
              '最多 3 层，每层最多 6 个节点，节点标题不超过 20 字，不得编造文章没有的内容。\n\n文章正文：\n' +
              body.slice(0, 8000),
          },
        ], {
          onDelta: (delta) => {
            text += delta;
          },
          onDone: () => undefined,
          onError: (message) => {
            failure = message;
          },
        });
        await session.done;
        if (failure !== null) throw new Error(failure);
        const parsed = parseMindMap(text);
        if (parsed === null) {
          throw new Error('AI 没有返回有效的结构 JSON，请重试。');
        }
        const spec = mindMapMutations(parsed, capture.point, capture.z, String(activeDocId));
        await kernel.canvas.apply(capture.canvasId as Parameters<typeof kernel.canvas.apply>[0], spec.mutations);
        setNotice(`已在当前画布生成思维导图：${spec.nodeCount} 节点、${spec.edgeCount} 条连线（可自由拖动改写）`);
      } catch (cause) {
        setError(`生成画布结构失败：${describeAiError(cause)}`);
      } finally {
        setMindmapBusy(false);
      }
    })();
  };

  const stop = (): void => {
    const session = sessionRef.current;
    if (session === null) return;
    void session.cancel();
    // 给最后一个助手气泡打上「已停止」标记：半截内容和空占位都要能被识别
    setTurns((current) =>
      current.map((turn, index) =>
        index === current.length - 1 && turn.role === 'assistant' ? { ...turn, stopped: true } : turn,
      ),
    );
    setStreaming(false);
  };

  /** AI 结果节点：生成内容存为自由文本节点，落在当前镜头中心（必须用户点按钮才写画布） */
  const requestCanvasNode = (turn: Turn): void => {
    const capture = readCapturePoint();
    if (capture === null) {
      setError('画布未就绪，先打开一张画布再落节点');
      return;
    }
    const node = {
      id: `n_${createUlid()}`,
      kind: 'note' as const,
      docId: null,
      text: turn.content,
      rect: { x: capture.point.x, y: capture.point.y, w: 320, h: 220 },
      z: capture.z,
      groupId: null,
      meta: { color: 'secondary' },
    };
    void kernel.canvas
      .apply(capture.canvasId as CanvasId, [{ type: 'addNode', node }])
      .then(() => {
        setNotice('已落为画布文本节点');
      })
      .catch((cause: unknown) => {
        setError(`落节点失败：${String(cause)}`);
      });
  };

  const requestCreate = (turn: Turn): void => {
    if (turn.content.trim() === '') return;
    const firstLine =
      turn.content
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find((line) => line !== '') ?? 'AI 草稿';
    setNotice(null);
    setProposal({ kind: 'create', title: firstLine.slice(0, 40), body: turn.content });
  };

  const requestDelete = async (): Promise<void> => {
    // busy 期间发起删除会用新提案覆盖进行中的 applyProposal，完成后 setProposal(null)
    // 会把刚弹出的确认框无声抹掉——先挡掉
    if (busy || activeDocId === null) return;
    setError(null);
    try {
      const snapshot = await kernel.docs.read(activeDocId);
      setNotice(null);
      setProposal({
        kind: 'delete',
        docId: snapshot.meta.id,
        base: snapshot.meta.rev,
        title: snapshot.meta.title,
      });
    } catch (cause) {
      setError(toErrorText(cause));
    }
  };

  const applyProposal = async (): Promise<void> => {
    if (proposal === null || busy) return;
    const pending = proposal;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await applyProposalDoc(kernel.docs, kernel.paths, pending);
      // 只清掉仍是本提案的确认框：中途被换成新提案时不得顺手抹掉它
      setProposal((current) => (current === pending ? null : current));
      if (result.kind === 'error') {
        setError(result.message);
        return;
      }
      setNotice(result.notice);
      if (result.createdId !== null) useFloatStore.getState().open(result.createdId, 'title');
      if (pending.kind === 'delete') useFloatStore.getState().close(pending.docId);
      if (result.undo === null) {
        undoRef.current = null;
        setUndoText(null);
      } else {
        undoRef.current = result.undo;
        setUndoText(undoLabel(result.undo));
      }
    } catch (cause) {
      setError(toErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const undoLast = async (): Promise<void> => {
    const undo = undoRef.current;
    if (undo === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      setNotice(await undoProposalDoc(kernel.docs, undo));
      if (undo.kind === 'remove-created') useFloatStore.getState().close(undo.docId);
      if (undo.kind === 'restore-deleted' && undo.input.id !== undefined) {
        useFloatStore.getState().open(undo.input.id, null);
      }
      undoRef.current = null;
      setUndoText(null);
    } catch (cause) {
      setError(toErrorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // IME 组合态回车是确认候选词，不是发送
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const storedRect: AiPanelRect = {
    x: aiPanel.x,
    y: aiPanel.y,
    width: aiPanel.width,
    height: aiPanel.height,
  };
  const rect = clampAiPanelRect(liveRect ?? storedRect, area);

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    kind: 'move' | 'resize',
  ): void => {
    if (event.button !== 0) return;
    // 标题栏上的关闭按钮等控件不触发拖动
    if (kind === 'move' && event.target instanceof Element && event.target.closest('button') !== null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, rect };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next =
      drag.kind === 'move'
        ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
        : { ...drag.rect, width: drag.rect.width + dx, height: drag.rect.height + dy };
    setLiveRect(clampAiPanelRect(next, area));
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const next = clampAiPanelRect(
      drag.kind === 'move'
        ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
        : { ...drag.rect, width: drag.rect.width + dx, height: drag.rect.height + dy },
      area,
    );
    setLiveRect(null);
    // 只在松手时写回 ui.json，拖动过程不落盘
    useMachineStore.getState().setAiPanel({
      x: next.x,
      y: next.y,
      width: next.width,
      height: next.height,
    });
  };

  /** 捕获被系统抢走（IME/辅助功能/DOM 重建）：按最近一次夹紧后的位置就地收尾 */
  const lostDrag = (): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    const final = liveRect;
    setLiveRect(null);
    if (final !== null) {
      useMachineStore
        .getState()
        .setAiPanel({ x: final.x, y: final.y, width: final.width, height: final.height });
    }
  };

  return (
    <aside
      ref={panelRef}
      className={styles.panel}
      data-ai-panel=""
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      aria-label="AI 助手"
    >
      <header
        className={styles.header}
        onPointerDown={(event) => {
          beginDrag(event, 'move');
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={lostDrag}
      >
        <div>
          <h2 className={styles.title}>AI 助手</h2>
          <p className={styles.subtitle}>
            {ai.provider === 'ollama' ? 'Ollama · 本机' : 'OpenAI 兼容 · 外部'}
            {ai.model === '' ? ' · 未设置模型' : ` · ${ai.model}`}
          </p>
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label="关闭 AI 面板"
          onClick={() => {
            onClose();
          }}
        >
          ×
        </button>
      </header>

      <div className={styles.messages} ref={listRef}>
        {turns.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>基于本地知识库的对话</p>
            <p className={styles.emptyText}>
              回答由你在设置中配置的服务生成。对话会保存于此 Mac（<em>不进知识库，不导出</em>）。
            </p>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => {
                onOpenSettings();
              }}
            >
              打开设置
            </button>
          </div>
        ) : (
          turns.map((turn) => (
            <article key={turn.id} className={`${styles.turn} ${styles[turn.role]}`}>
              <span className={styles.role}>{turn.role === 'user' ? '你' : 'AI'}</span>
              <div className={styles.bubble}>
                {turn.content === '' ? (
                  turn.stopped === true ? (
                    '（已停止，没有收到内容）'
                  ) : (
                    <span className={styles.typing}>…</span>
                  )
                ) : (
                  <>
                    {turn.content}
                    {turn.stopped === true ? <span className={styles.stoppedMark}>（已停止）</span> : null}
                  </>
                )}
              </div>
              {turn.role === 'assistant' && !streaming && turn.content.trim() !== '' ? (
                <div className={styles.turnActions}>
                  <button
                    type="button"
                    className={styles.turnAction}
                    title="生成内容落成当前画布的自由文本节点（结果留在空间里）"
                    onClick={() => {
                      requestCanvasNode(turn);
                    }}
                  >
                    落为画布节点
                  </button>
                  <button
                    type="button"
                    className={styles.turnAction}
                    onClick={() => {
                      requestCreate(turn);
                    }}
                  >
                    存为新文章…
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>

      {error === null ? null : <p className={styles.error}>{error}</p>}

      {notice === null ? null : (
        <p className={styles.notice}>
          {notice}
          {undoText === null ? null : (
            <button
              type="button"
              className={styles.undo}
              disabled={busy}
              onClick={() => {
                void undoLast();
              }}
            >
              {undoText}
            </button>
          )}
        </p>
      )}

      {proposal === null ? null : (
        <div className={styles.proposal}>
          <p className={styles.proposalText}>
            {proposal.kind === 'replace'
              ? `把《${proposal.title}》正文替换为 AI 结果？旧正文会暂存在本次运行内，可撤销。`
              : proposal.kind === 'create'
                ? '新建文章，写入 notes/ 目录：'
                : `删除《${proposal.title}》？文件会移入系统回收站，本次运行内仍可撤销（撤销是重建，不从回收站取回）。`}
          </p>
          {proposal.kind === 'create' ? (
            <input
              className={styles.proposalInput}
              value={proposal.title}
              aria-label="新文章标题"
              onChange={(event) => {
                setProposal({ ...proposal, title: event.currentTarget.value });
              }}
            />
          ) : null}
          <div className={styles.proposalButtons}>
            <button
              type="button"
              className={styles.apply}
              disabled={busy || streaming || (proposal.kind === 'create' && proposal.title.trim() === '')}
              onClick={() => {
                void applyProposal();
              }}
            >
              {busy ? '处理中…' : '应用'}
            </button>
            <button
              type="button"
              className={styles.discard}
              disabled={busy}
              onClick={() => {
                setProposal(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className={styles.composer}>
        <textarea
          className={styles.textarea}
          value={input}
          rows={3}
          placeholder="问点什么，Enter 发送，Shift+Enter 换行"
          onChange={(event) => {
            setInput(event.currentTarget.value);
          }}
          onKeyDown={onComposerKeyDown}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.citeChip} ${citeDoc && activeDocId !== null ? styles.citeChipOn : ''}`}
            aria-pressed={citeDoc && activeDocId !== null}
            disabled={activeDocId === null}
            title={
              activeDocId === null
                ? '先打开一篇文档浮窗，再启用正文引用'
                : citeDoc
                  ? '对话将带上当前文章正文作为上下文；点击关闭'
                  : '点击开启：对话带上当前文章正文作为上下文'
            }
            onClick={() => {
              setCiteDoc((value) => !value);
            }}
          >
            ⎘ 引用当前文章
          </button>
          <button
            type="button"
            className={styles.citeChip}
            disabled={mindmapBusy || streaming || busy || activeDocId === null}
            title="把当前文章整理成思维导图，落在当前画布（生成的是普通节点，可自由拖动改写）"
            onClick={generateCanvasMindMap}
          >
            {mindmapBusy ? '生成中…' : '⊸ 生成画布'}
          </button>
          <button
            type="button"
            className={styles.remove}
            disabled={streaming || busy || activeDocId === null}
            title="删除当前文章（移入系统回收站）"
            onClick={() => {
              void requestDelete();
            }}
          >
            删除…
          </button>
          {streaming ? (
            <button type="button" className={styles.stop} onClick={stop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className={styles.send}
              disabled={input.trim() === ''}
              onClick={() => {
                void send();
              }}
            >
              发送
            </button>
          )}
        </div>
      </div>

      <div
        className={styles.resizeCorner}
        role="separator"
        aria-label="调整 AI 浮窗尺寸"
        onPointerDown={(event) => {
          beginDrag(event, 'resize');
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={lostDrag}
      />
    </aside>
  );
};
