import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  clampAiPanelRect,
  DEFAULT_PANEL_AREA,
  useMachineStore,
  type AiPanelRect,
  type PanelArea,
} from '../../data/stores/machine-store.ts';
import { startChat, type ChatSession, type ChatTurnInput } from '../../data/tauri/ai.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { useFloatStore } from '../editor/float-store.ts';
import { useKernel } from '../kernel-provider.tsx';
import {
  applyProposalDoc,
  undoLabel,
  undoProposalDoc,
  type Proposal,
  type UndoAction,
} from './proposal.ts';
import styles from './AiPanel.module.css';

interface AiPanelProps {
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}

interface Turn {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
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

  const send = (): void => {
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
    stream([{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: text }], text);
  };

  const stop = (): void => {
    const session = sessionRef.current;
    if (session === null) return;
    void session.cancel();
    setStreaming(false);
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
      send();
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
              对话只保留在本次运行的内存里，不写入库文件。回答由你在设置中配置的服务生成。
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
                {turn.content === '' ? <span className={styles.typing}>…</span> : turn.content}
              </div>
              {turn.role === 'assistant' && !streaming && turn.content.trim() !== '' ? (
                <div className={styles.turnActions}>
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
                : `删除《${proposal.title}》？文件会移入 .workbench/trash/，可撤销。`}
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
            className={styles.remove}
            disabled={streaming || busy || activeDocId === null}
            title="删除当前文章（移入回收站）"
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
              onClick={send}
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
