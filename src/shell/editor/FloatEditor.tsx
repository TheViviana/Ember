import { EditorView } from '@codemirror/view';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactElement,
} from 'react';
import type { DocId } from '#doc-model';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import type { AiActionId } from '../ai/actions.ts';
import { InlineAiResult } from '../ai/InlineAiResult.tsx';
import { SelectionAiMenu } from '../ai/SelectionAiMenu.tsx';
import { useInlineAi } from '../ai/use-inline-ai.ts';
import type { CursorPosition } from './cursor.ts';
import { useFloatStore } from './float-store.ts';
import { useFocusStore } from './focus-store.ts';
import { PHASE, type Notice } from './float-editor-model.ts';
import {
  insertLink,
  toggleBlock,
  toggleHeading,
  toggleInline,
  type BlockFormat,
  type HeadingLevel,
  type InlineFormat,
} from './format-commands.ts';
import { FormatToolbar } from './FormatToolbar.tsx';
import { ReadingView } from './ReadingView.tsx';
import { BacklinksPanel } from './BacklinksPanel.tsx';
import { OutlinePanel } from './OutlinePanel.tsx';
import { FloatTagBar } from './FloatTagBar.tsx';
import { FloatTitle } from './FloatTitle.tsx';
import { useFloatDocument } from './use-float-document.ts';
import { useFloatFrame } from './use-float-frame.ts';
import styles from './FloatEditor.module.css';

export interface FloatEditorProps {
  readonly docId: DocId;
  /** 编辑元数据入口：把焦点直接放到标题 */
  readonly focus: 'title' | null;
  /** 每次「打开同一篇」递增：把焦点还给正文，而不是重建编辑器 */
  readonly focusNonce: number;
  readonly onClose: () => void;
  /** 上报光标位置（1 基行 / 列）；浮窗关闭或切换文档时回调 null */
  readonly onCursor: (position: CursorPosition | null) => void;
  /** 无保存位置时的层叠槽位，接 cascadeFloatFrame */
  readonly defaultSlot?: number;
  /** 是否最前窗：只有最前窗上报光标与响应标题聚焦 */
  readonly active?: boolean;
}

/**
 * 文档浮窗：标题栏 / 标签栏 / 内容区三段式。
 * 复用 EditorHost 的会话，浮窗是唯一编辑器实例 —— 同一文档只创建一个 EditorView；
 * 尺寸按 docId 记在机器本地 ui.json，缩放全程不触发文档写入。
 */
export const FloatEditor = ({
  docId,
  focus,
  focusNonce,
  onClose,
  onCursor,
  defaultSlot = 0,
  active = true,
}: FloatEditorProps): ReactElement => {
  const kernel = useKernel();
  /** 选区 AI 的内联结果：流式内容、替换与撤销都只在本次运行内 */
  const inlineAi = useInlineAi(kernel, docId);
  /** Esc 仲裁层 id：每个浮窗实例独立（多浮窗时后挂载者持有 Esc） */
  const escLayerId = useId();
  const inlineCloseRef = useRef(inlineAi.close);
  inlineCloseRef.current = inlineAi.close;

  const doc = useFloatDocument({
    docId,
    focus,
    focusNonce,
    onCursor,
    active,
    inlineCloseRef,
  });
  const frame = useFloatFrame({ docId, defaultSlot, panelRef: doc.panelRef });

  const { mode, setMode, modeRef } = doc;
  const clearSelectionAnchor = doc.clearSelectionAnchor;
  const { setWikiPrompt, wikiPrompt } = doc;
  const focused = frame.focused;
  const phaseInfo = PHASE[doc.phase];

  useEffect(() => {
    if (!active) {
      clearSelectionAnchor();
      inlineCloseRef.current();
    }
  }, [active, clearSelectionAnchor]);

  /** 选中文本就地生成：锚点、偏移与正文快照都在这时冻结，之后不再依赖实时选区 */
  const pickSelectionAction = useCallback(
    (action: AiActionId): void => {
      const view = doc.viewRef.current;
      const anchor = doc.selectionAnchor;
      if (view === null || anchor === null) return;
      const main = view.state.selection.main;
      if (main.empty) return;
      const text = view.state.sliceDoc(main.from, main.to);
      if (text.trim() === '') return;
      doc.clearSelectionAnchor();
      inlineAi.start({
        action,
        anchor,
        from: main.from,
        to: main.to,
        text,
        readBody: () => view.state.doc.toString(),
      });
    },
    [doc, inlineAi],
  );

  const jumpToHeading = (line: number): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 8 }),
    });
    view.focus();
  };

  const applyInlineFormat = useCallback((format: InlineFormat): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    toggleInline(view, format);
  }, [doc]);

  const applyBlockFormat = useCallback((format: BlockFormat): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    toggleBlock(view, format);
  }, [doc]);

  const applyHeading = useCallback((level: HeadingLevel): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    toggleHeading(view, level);
  }, [doc]);

  const applyLink = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    insertLink(view);
  }, [doc]);

  /** 进入阅读：记录滚动位置与正文快照，只隐藏 EditorView，不销毁 */
  const enterReadMode = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    doc.readScrollRef.current = view.scrollDOM.scrollTop;
    doc.setReadMarkdown(view.state.doc.toString());
    doc.clearSelectionAnchor();
    inlineCloseRef.current();
    doc.setWikiPrompt(null);
    modeRef.current = 'read';
    setMode('read');
    // 正文不可见时不让键盘继续落进隐藏的编辑器
    view.contentDOM.blur();
  }, [doc, modeRef, setMode]);

  const toggleMode = useCallback((): void => {
    if (modeRef.current === 'read') {
      modeRef.current = 'edit';
      setMode('edit');
      return;
    }
    enterReadMode();
  }, [enterReadMode, modeRef, setMode]);

  // 退出阅读：焦点先回编辑器，再把进入前的滚动位置写回去（focus 可能触发滚动）
  useLayoutEffect(() => {
    const previous = doc.previousModeRef.current;
    doc.previousModeRef.current = mode;
    if (previous !== 'read' || mode !== 'edit') return undefined;
    const view = doc.viewRef.current;
    if (view === null) return undefined;
    const top = doc.readScrollRef.current;
    if (active) view.focus();
    view.requestMeasure({
      read: () => top,
      write: (value) => {
        view.scrollDOM.scrollTop = value;
      },
    });
    // 焦点滚动发生在下一帧，补一次确保落回进入阅读前的位置
    const raf = window.requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = top;
    });
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [active, doc.previousModeRef, doc.readScrollRef, doc.viewRef, mode]);

  // 阅读态 Esc：有双链提示先收提示，其次退出专注，最后返回编辑。
  // 统一仲裁：更晚打开的浮层（设置/命令面板/工具面板）持有 Esc 时让位。
  useEscLayer(`float-read${escLayerId}`, mode === 'read');
  useEffect(() => {
    if (mode !== 'read') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop(`float-read${escLayerId}`)) return;
      event.preventDefault();
      if (wikiPrompt !== null) {
        setWikiPrompt(null);
        return;
      }
      if (focused) {
        useFocusStore.getState().exit();
        return;
      }
      modeRef.current = 'edit';
      setMode('edit');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [escLayerId, focused, mode, modeRef, setMode, setWikiPrompt, wikiPrompt]);

  // 编辑态专注的 Esc 出口；标题改名、选区菜单与内联结果自己消费 Esc，不在这里抢
  useEscLayer(`float-focus${escLayerId}`, focused && mode === 'edit');
  useEffect(() => {
    if (!focused || mode !== 'edit') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 选区 AI 菜单或内联结果打开时，先让它们按自己的 Esc 收起（它们也更晚入栈）
      if (doc.selectionAnchor !== null || inlineAi.run !== null) return;
      if (!isEscTop(`float-focus${escLayerId}`)) return;
      event.preventDefault();
      useFocusStore.getState().exit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [doc.selectionAnchor, escLayerId, focused, inlineAi.run, mode]);

  const banner: Notice | null = doc.banner;

  return (
    <section
      ref={doc.panelRef}
      className={`${styles.float} ${frame.resizing ? styles.resizing : ''} ${frame.moving ? styles.moving : ''}`}
      style={frame.geometry}
      data-canvas-overlay
      data-float-editor=""
      aria-label="文档浮窗"
    >
      <header
        className={styles.header}
        onPointerDown={frame.beginMove}
        onPointerMove={frame.moveMove}
        onPointerUp={frame.endMove}
        onPointerCancel={frame.endMove}
        onLostPointerCapture={frame.endMove}
        onClickCapture={frame.suppressDraggedClick}
      >
        <FloatTitle
          title={doc.title}
          statusText={phaseInfo.text}
          statusTone={phaseInfo.tone}
          readingMinutes={doc.readingMinutes}
          autoFocus={focus === 'title' && active}
          focused={focused}
          onCommit={(value) => {
            doc.actionsRef.current?.commitTitle(value);
          }}
          onToggleFocus={() => {
            if (focused) {
              useFocusStore.getState().exit();
              return;
            }
            useFloatStore.getState().activate(docId);
            useFocusStore.getState().enter(docId);
          }}
          onClose={onClose}
        />
        {banner === null ? null : (
          <p className={`${styles.notice} ${styles[`notice_${banner.tone}`] ?? ''}`} role="status">
            {banner.text}
          </p>
        )}
      </header>

      <FloatTagBar
        tags={doc.tags}
        knownTags={doc.knownTags}
        summary={doc.summary}
        hasSummary={doc.hasSummary}
        onTagsChange={(next) => {
          doc.actionsRef.current?.commitTags(next);
        }}
        onSummaryCommit={(value) => {
          doc.actionsRef.current?.commitSummary(value);
        }}
      />

      <FormatToolbar
        state={doc.formatState}
        disabled={doc.phase === 'error'}
        mode={mode}
        onInline={applyInlineFormat}
        onBlock={applyBlockFormat}
        onHeading={applyHeading}
        onLink={applyLink}
        onToggleMode={toggleMode}
      />

      <div className={styles.content}>
        <div className={styles.host} ref={doc.setHost} hidden={mode === 'read'} />
        {mode === 'read' ? (
          <ReadingView markdown={doc.readMarkdown} onWikiLink={doc.openWikiTarget} />
        ) : (
          <>
            <OutlinePanel
              headings={doc.outline}
              activeIndex={doc.activeOutline}
              onJump={jumpToHeading}
            />
            <BacklinksPanel docId={docId} />
          </>
        )}

        {doc.wikiPrompt === null ? null : (
          <div className={styles.wikiPrompt} role="dialog" aria-label="双链跳转">
            <div className={styles.wikiHead}>
              <span className={styles.wikiTarget}>[[{doc.wikiPrompt.label}]]</span>
              <button
                type="button"
                className={styles.wikiClose}
                aria-label="关闭双链提示"
                onClick={() => {
                  doc.setWikiPrompt(null);
                }}
              >
                ×
              </button>
            </div>

            {doc.wikiPrompt.kind === 'unresolved' ? (
              <>
                <p className={styles.wikiText}>未找到《{doc.wikiPrompt.label}》对应的文档，未跳转。</p>
                <p className={styles.wikiHint}>请检查标题、文件名或 frontmatter 别名是否一致。</p>
              </>
            ) : (
              <>
                <p className={styles.wikiText}>
                  《{doc.wikiPrompt.label}》匹配到 {doc.wikiPrompt.candidates.length} 篇文档，请选择要打开的一篇：
                </p>
                <div className={styles.wikiList}>
                  {doc.wikiPrompt.candidates.map((candidate) => (
                    <button
                      type="button"
                      className={styles.wikiCandidate}
                      key={String(candidate.id)}
                      onClick={() => {
                        doc.setWikiPrompt(null);
                        useFloatStore.getState().open(candidate.id, null);
                      }}
                    >
                      <span className={styles.wikiTitle}>
                        {candidate.title.length === 0 ? '未命名' : candidate.title}
                      </span>
                      {candidate.path === null ? null : (
                        <span className={styles.wikiPath}>{String(candidate.path)}</span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {inlineAi.run === null ? null : (
        <InlineAiResult
          run={inlineAi.run}
          onStop={inlineAi.stop}
          onDiscard={inlineAi.discard}
          onApply={inlineAi.apply}
          onUndo={inlineAi.undo}
          onClose={inlineAi.close}
        />
      )}

      {doc.selectionAnchor === null ? null : (
        <SelectionAiMenu
          anchor={doc.selectionAnchor}
          disabled={kernel.env.readonlyMode}
          onPick={pickSelectionAction}
          onClose={doc.clearSelectionAnchor}
        />
      )}

      {focused
        ? null
        : frame.zones.map((zone) => (
            <div
              key={zone}
              className={styles.handle}
              data-zone={zone}
              aria-hidden="true"
              onPointerDown={(event) => {
                frame.beginResize(zone, event);
              }}
              onPointerMove={frame.moveResize}
              onPointerUp={frame.endResize}
              onPointerCancel={frame.endResize}
              onLostPointerCapture={frame.endResize}
            />
          ))}
    </section>
  );
};
