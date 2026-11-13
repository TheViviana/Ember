import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { useQuery } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
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
  insertCodeBlock,
  insertHorizontalRule,
  insertLink,
  insertTable,
  toggleBlock,
  toggleHeading,
  toggleInline,
  type BlockFormat,
  type HeadingLevel,
  type InlineFormat,
} from './format-commands.ts';
import { FormatToolbar } from './FormatToolbar.tsx';
import { ReadingView } from './ReadingView.tsx';
import { useTranslation } from '../ai/use-translation.ts';
import { BacklinksPanel } from './BacklinksPanel.tsx';
import { HistoryPanel } from './HistoryPanel.tsx';
import { OutlinePanel } from './OutlinePanel.tsx';
import { FloatTagBar } from './FloatTagBar.tsx';
import { FloatTitle } from './FloatTitle.tsx';
import { useFloatAiActions } from './use-float-ai-actions.ts';
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
 * 由 useFloatDocument 管理文档会话，浮窗是唯一编辑器实例 —— 同一文档只创建一个 EditorView；
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
  // 与 App / 设置面板共用同一份缓存：settings:changed 会 setQueryData，这里随之重渲染
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => kernel.settings.read() });
  const lineNumbers = settingsQuery.data?.ui.editorLineNumbers !== false;
  /** 选区 AI 的内联结果：流式内容、替换与撤销都只在本次运行内 */
  const inlineAi = useInlineAi(kernel, docId);
  /** 整篇双语对照：译文只活在阅读态视图里，切换模式即清空 */
  const translation = useTranslation();
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
    lineNumbers,
  });
  const frame = useFloatFrame({ docId, defaultSlot, panelRef: doc.panelRef });
  const [historyOpen, setHistoryOpen] = useState(false);

  // 切换文档时收起历史：避免把上一篇的版本列表带到新文档上
  useEffect(() => {
    setHistoryOpen(false);
  }, [docId]);

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

  const applyCodeBlock = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    insertCodeBlock(view);
  }, [doc]);

  const applyHorizontalRule = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    insertHorizontalRule(view);
  }, [doc]);

  const applyTable = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    insertTable(view);
  }, [doc]);

  const aiActions = useFloatAiActions(kernel, doc, inlineAi);

  const applyUndo = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    undo(view);
  }, [doc]);

  const applyRedo = useCallback((): void => {
    const view = doc.viewRef.current;
    if (view === null) return;
    redo(view);
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

  const translateRestore = translation.restore;
  const translateStart = translation.start;
  const translateState = translation.state;

  /** 点「翻译」：编辑态先落到阅读态（用同一份正文快照），再进行中可停止、完成后可收起 */
  const startTranslation = useCallback((): void => {
    if (translateState.phase === 'running') {
      translateRestore();
      return;
    }
    if (translateState.phase === 'done') {
      translateRestore();
      return;
    }
    const view = doc.viewRef.current;
    if (view === null) return;
    const markdown = modeRef.current === 'read' ? doc.readMarkdown : view.state.doc.toString();
    if (modeRef.current !== 'read') enterReadMode();
    translateStart(markdown);
  }, [doc, enterReadMode, modeRef, translateRestore, translateStart, translateState.phase]);

  // 译文只属于阅读态：退回编辑、换文档或关闭浮窗都不保留
  useEffect(() => {
    if (mode !== 'read') translateRestore();
  }, [docId, mode, translateRestore]);

  const translateLabel =
    translateState.phase === 'running'
      ? `翻译中 ${translateState.done}/${translateState.total}`
      : translateState.phase === 'done'
        ? '收起译文'
        : '翻译';
  const translateTitle =
    translateState.phase === 'running'
      ? '停止翻译'
      : translateState.phase === 'done'
        ? '收起译文，只保留原文'
        : translation.ready
          ? '整篇翻译，译文显示在每段下方'
          : '先在设置里配置 AI 提供方与模型';
  const translateDisabled = translateState.phase === 'idle' && !translation.ready;

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
          wordCount={doc.wordCount}
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
        onAiSummary={
          aiActions.aiModelReady && doc.phase !== 'error' ? aiActions.generateAiSummary : null
        }
        aiSummaryBusy={aiActions.aiSummaryBusy}
        aiSummaryError={aiActions.aiSummaryError}
      />

      <FormatToolbar
        state={doc.formatState}
        disabled={doc.phase === 'error'}
        mode={mode}
        onInline={applyInlineFormat}
        onBlock={applyBlockFormat}
        onHeading={applyHeading}
        onLink={applyLink}
        onCodeBlock={applyCodeBlock}
        onHorizontalRule={applyHorizontalRule}
        onTable={applyTable}
        onContinue={aiActions.applyContinue}
        continueDisabled={!aiActions.aiModelReady || kernel.env.readonlyMode}
        onToggleMode={toggleMode}
        onHistory={() => {
          setHistoryOpen(true);
        }}
        onUndo={applyUndo}
        onRedo={applyRedo}
        translateLabel={translateLabel}
        translateTitle={translateTitle}
        translateDisabled={translateDisabled}
        onTranslate={startTranslation}
      />

      <div className={styles.content}>
        {doc.loadFailure === null ? null : (
          <div className={styles.loadFailure} role="alert">
            <p className={styles.loadFailureTitle}>
              {doc.loadFailure.kind === 'permission' ? '无法读取这篇文档' : '读取失败'}
            </p>
            <p className={styles.loadFailureText}>
              {doc.loadFailure.kind === 'permission'
                ? 'macOS 没有授予 Ember 访问「文稿」文件夹的权限，所以正文显示不出来。文件仍在磁盘上，没有被清空。'
                : '读取这篇文档时出错，正文暂不可用。'}
            </p>
            <p className={styles.loadFailureHint}>
              {doc.loadFailure.kind === 'permission'
                ? '请到「系统设置 → 隐私与安全性 → 文件与文件夹」中允许 Ember 访问「文稿」，然后点重试。'
                : doc.loadFailure.text}
            </p>
            <button
              type="button"
              className={styles.loadFailureRetry}
              onClick={doc.retryLoad}
            >
              重试
            </button>
          </div>
        )}
        <div className={styles.host} ref={doc.setHost} hidden={mode === 'read'} />
        {mode === 'read' ? (
          <ReadingView
            markdown={doc.readMarkdown}
            onWikiLink={doc.openWikiTarget}
            translations={translateState.entries}
            note={translateState.note}
          />
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

        {historyOpen ? (
          <HistoryPanel
            docId={docId}
            onClose={() => {
              setHistoryOpen(false);
            }}
            onBeforeRestore={doc.flushNow}
          />
        ) : null}
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
          readonlyReason={kernel.env.readonlyReason}
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
