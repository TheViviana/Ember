import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { DocId } from '#doc-model';
import type { EditorSession } from '../../kernel/editor-host.ts';
import { toErrorText } from '../../kernel/errors.ts';
import type { Disposable, DocChange, DocSnapshot } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import { emberEditorThemeExtensions } from './cm-theme.ts';
import type { CursorPosition } from './cursor.ts';
import { registerFloatFlusher, settleFloatWrite, trackFloatWrite } from './float-flush.ts';
import {
  DEBOUNCE_MS,
  isMetaDirty,
  sameTags,
  type FloatActions,
  type MetaField,
  type Notice,
  type SavePhase,
  type WikiPrompt,
} from './float-editor-model.ts';
import { createFloatPersister, hasPendingWrite } from './float-persist.ts';
import { createOutlineTracker, type OutlineTracker } from './float-outline.ts';
import type { FormatState } from './format-commands.ts';
import { EMPTY_FORMAT_STATE, formatStateAt, sameFormatState } from './format-commands.ts';
import { collectWikiLinks, incrementalDecorationPlugin } from './incremental-decorations.ts';
import type { OutlineHeading } from './outline.ts';
import { estimateReadingMinutes } from './reading-time.ts';
import { slashCommands } from './slash-commands.ts';
import { findWikiLinkAt, isInsideCode } from './wiki-link.ts';
import type { SelectionAnchor } from '../ai/SelectionAiMenu.tsx';
import type { ToolbarMode } from './FormatToolbar.tsx';
import { useFloatLinks } from './use-float-links.ts';

export interface FloatDocumentOptions {
  readonly docId: DocId;
  readonly focus: 'title' | null;
  readonly focusNonce: number;
  readonly onCursor: (position: CursorPosition | null) => void;
  readonly active: boolean;
  readonly inlineCloseRef: RefObject<() => void>;
}

/**
 * 浮窗文档会话：唯一 EditorView、正文落盘、元数据、双链与大纲。
 * 编辑器生命周期只随 docId / host 变化，其余状态走 ref 保持回调最新。
 */
export const useFloatDocument = ({
  docId,
  focus,
  focusNonce,
  onCursor,
  active,
  inlineCloseRef,
}: FloatDocumentOptions) => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  // 回调走 ref：既保证状态栏拿到最新函数，又不把 onCursor 放进会话重建依赖
  const onCursorRef = useRef(onCursor);
  useEffect(() => {
    onCursorRef.current = onCursor;
  }, [onCursor]);
  // 光标归属走 ref：updateListener 在会话创建时闭包捕获，切换最前窗不能重建编辑器
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  // 打开意图同样走 ref：focus 变化只影响聚焦行为，不重建 EditorView
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<SavePhase>('saving');
  const [formatState, setFormatState] = useState<FormatState>(EMPTY_FORMAT_STATE);
  /** 编辑 / 阅读：阅读态只隐藏 EditorView，不销毁（撤销、选区、滚动都要保留） */
  const [mode, setMode] = useState<ToolbarMode>('edit');
  const modeRef = useRef<ToolbarMode>('edit');
  /** 进入阅读时的正文快照；编辑态不使用 */
  const [readMarkdown, setReadMarkdown] = useState('');
  /** 进入阅读前的滚动位置，退出时恢复 */
  const readScrollRef = useRef(0);
  const previousModeRef = useRef<ToolbarMode>('edit');
  const [banner, setBanner] = useState<Notice | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<readonly string[]>([]);
  const [summary, setSummary] = useState('');
  /** 简介是否来自 frontmatter（false = 正文派生值，不落盘） */
  const [hasSummary, setHasSummary] = useState(false);
  /** 大纲：与编辑器文档同步，滚动时高亮当前标题 */
  const [outline, setOutline] = useState<readonly OutlineHeading[]>([]);
  const [activeOutline, setActiveOutline] = useState(-1);
  const outlineRef = useRef<readonly OutlineHeading[]>([]);
  /** 阅读时长（分钟）：空正文为 null，不展示 */
  const [readingMinutes, setReadingMinutes] = useState<number | null>(null);
  const [wikiPrompt, setWikiPrompt] = useState<WikiPrompt | null>(null);
  /** 选区菜单锚点：相对本浮窗左上角；null = 不显示 */
  const [selectionAnchor, setSelectionAnchor] = useState<SelectionAnchor | null>(null);

  const panelRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  const links = useFloatLinks(kernel, tags, setWikiPrompt);
  const { openWikiLink, openWikiTarget, knownTags, documents } = links;

  const titleField = useRef('');
  const tagsField = useRef<readonly string[]>([]);
  const summaryField = useRef('');
  const dirty = useRef<Record<MetaField, boolean>>({ title: false, tags: false, summary: false });
  const scheduleRef = useRef<() => void>(() => undefined);
  const actionsRef = useRef<FloatActions | null>(null);

  useEffect(() => {
    if (host === null) return undefined;

    let disposed = false;
    let view: EditorView | null = null;
    let session: EditorSession | null = null;
    let subscription: Disposable | null = null;
    let timer: number | null = null;
    let suppress = false;
    let tracker: OutlineTracker | null = null;

    // 切换文档时先清空上一份的大纲，避免旧标题短暂残留
    outlineRef.current = [];
    setOutline([]);
    setActiveOutline(-1);
    setReadingMinutes(null);
    setWikiPrompt(null);
    // 换文档回到编辑态：阅读快照与滚动记忆都不属于新文档
    modeRef.current = 'edit';
    setMode('edit');
    setReadMarkdown('');
    readScrollRef.current = 0;

    const persister = createFloatPersister({
      kernel,
      queryClient,
      docId,
      getBody: () => (view === null ? null : view.state.doc.toString()),
      titleField,
      tagsField,
      summaryField,
      dirty,
      isDisposed: () => disposed,
      setPhase,
      setBanner,
      setHasSummary,
    });

    const applySnapshot = (snapshot: DocSnapshot): void => {
      persister.reset(snapshot);
      const savedBody = persister.getSavedBody();
      const frontmatter = snapshot.frontmatter;
      titleField.current = frontmatter.title ?? snapshot.meta.title;
      tagsField.current = frontmatter.tags;
      summaryField.current = frontmatter.summary ?? snapshot.meta.summary;
      dirty.current = { title: false, tags: false, summary: false };
      if (!disposed) {
        setTitle(titleField.current);
        setTags(frontmatter.tags);
        setSummary(summaryField.current);
        setHasSummary(frontmatter.summary !== null);
        setReadingMinutes(estimateReadingMinutes(savedBody));
      }
    };

    // 窗口关闭不会卸载 React 树：登记到全局，关窗请求里主动把待写内容落盘
    const unregisterFlusher = registerFloatFlusher(async () => {
      if (view === null) return;
      const body = view.state.doc.toString();
      if (!hasPendingWrite(body, persister.getSavedBody(), dirty.current)) return;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      await persister.flushOnClose(body);
    });

    const scheduleSave = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!disposed) void persister.persist();
      }, DEBOUNCE_MS);
    };
    scheduleRef.current = scheduleSave;

    const commitTitle = (value: string): void => {
      const next = value.trim();
      if (next === titleField.current) return;
      titleField.current = next;
      dirty.current.title = true;
      setTitle(next);
      setPhase('saving');
      void persister.persist();
    };

    const commitTags = (next: readonly string[]): void => {
      if (sameTags(next, tagsField.current)) return;
      tagsField.current = next;
      setTags(next);
      dirty.current.tags = true;
      setPhase('saving');
      void persister.persist();
    };

    const commitSummary = (value: string): void => {
      if (value === summaryField.current.trim()) return;
      summaryField.current = value;
      dirty.current.summary = true;
      setPhase('saving');
      void persister.persist();
    };

    actionsRef.current = { commitTitle, commitTags, commitSummary };

    const start = async (): Promise<void> => {
      try {
        // 同一篇刚被关闭时，先等关闭前的写入落盘，避免读到旧快照
        await settleFloatWrite(String(docId));
        const opened = await kernel.editor.open(docId);
        if (disposed) {
          opened.close();
          return;
        }
        session = opened;
        applySnapshot(opened.snapshot);
        setPhase('idle');

        const savedBody = persister.getSavedBody();
        const state = EditorState.create({
          doc: savedBody,
          extensions: [
            lineNumbers(),
            history(),
            drawSelection(),
            highlightActiveLine(),
            bracketMatching(),
            closeBrackets(),
            EditorView.lineWrapping,
            placeholder('开始写作…'),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
            ...emberEditorThemeExtensions,
            markdown(),
            slashCommands({
              kernel,
              docId,
              onError: (message) => {
                if (!disposed) setBanner({ tone: 'alert', text: message });
              },
            }),
            incrementalDecorationPlugin(collectWikiLinks),
            EditorView.domEventHandlers({
              click: (event, editor) => {
                const element = event.target;
                if (!(element instanceof Element) || element.closest('.ember-wikilink') === null) {
                  return false;
                }
                const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos === null) return false;
                const link = findWikiLinkAt(editor.state.doc, pos);
                if (link === null) return false;
                // 代码块与行内代码里的 [[...]] 继续不参与跳转
                if (isInsideCode(editor.state, pos)) return false;
                event.preventDefault();
                openWikiLink(link);
                return true;
              },
              contextmenu: () => {
                // 右键菜单优先：选区菜单先收起，不与它抢位置
                setSelectionAnchor(null);
                return false;
              },
            }),
            EditorView.updateListener.of((update) => {
              if (activeRef.current && (update.selectionSet || update.docChanged)) {
                const head = update.state.selection.main.head;
                const line = update.state.doc.lineAt(head);
                onCursorRef.current({ line: line.number, column: head - line.from + 1 });
              }
              if (update.selectionSet || update.docChanged) {
                const next = formatStateAt(update.state);
                setFormatState((current) => (sameFormatState(current, next) ? current : next));
              }
              if (update.selectionSet) {
                const main = update.state.selection.main;
                const panel = panelRef.current;
                if (main.empty || update.docChanged || !activeRef.current || panel === null) {
                  // 输入与自动重载也会报新选区（docChanged），那不是用户重新框选：
                  // 只收起菜单，不打断正在生成或已就绪的内联块
                  setSelectionAnchor(null);
                } else {
                  // 新选区与内联块互斥：同一浮窗只保留一个选区 AI 会话
                  inlineCloseRef.current();
                  const startCoords = update.view.coordsAtPos(main.from);
                  const endCoords = update.view.coordsAtPos(main.to);
                  if (startCoords !== null && endCoords !== null) {
                    const panelRect = panel.getBoundingClientRect();
                    const left = Math.min(startCoords.left, endCoords.left) - panelRect.left;
                    const top = Math.min(startCoords.top, endCoords.top) - panelRect.top;
                    const right = Math.max(startCoords.right, endCoords.right) - panelRect.left;
                    const bottom = Math.max(startCoords.bottom, endCoords.bottom) - panelRect.top;
                    setSelectionAnchor({
                      left,
                      top,
                      width: Math.max(1, right - left),
                      height: Math.max(1, bottom - top),
                    });
                  } else {
                    setSelectionAnchor(null);
                  }
                }
              }
              if (update.docChanged) {
                tracker?.schedule();
                // 外部重载会替换整篇正文：阅读态跟着刷新，避免停留在旧快照
                if (modeRef.current === 'read') setReadMarkdown(update.state.doc.toString());
              }
              if (!update.docChanged || suppress) return;
              setPhase('dirty');
              scheduleSave();
            }),
          ],
        });

        view = new EditorView({ state, parent: host });
        viewRef.current = view;
        setFormatState(formatStateAt(view.state));
        const head = view.state.selection.main.head;
        const firstLine = view.state.doc.lineAt(head);
        if (activeRef.current) {
          onCursorRef.current({ line: firstLine.number, column: head - firstLine.from + 1 });
        }
        if (focusRef.current !== 'title') view.focus();

        tracker = createOutlineTracker({
          editor: view,
          isDisposed: () => disposed,
          onOutline: (next) => {
            outlineRef.current = next;
            if (!disposed) setOutline(next);
          },
          onActive: (index) => {
            if (!disposed) setActiveOutline(index);
          },
          onReadingMinutes: (minutes) => {
            if (!disposed) setReadingMinutes(minutes);
          },
          // 选区菜单滚出原位后不再跟随，直接收起；内联块留在冻结的锚点上，不被滚动打断
          onScroll: () => setSelectionAnchor(null),
        });

        subscription = kernel.events.on('doc:changed', (change: DocChange) => {
          if (String(change.id) !== String(docId)) return;
          if (change.kind === 'removed' || change.kind === 'renamed') {
            void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
            return;
          }
          if (change.kind !== 'external' && change.kind !== 'updated') return;
          const base = persister.getBase();
          if (persister.isSaving() || (base !== null && change.revision.hash === base.hash)) return;

          if (view !== null && view.state.doc.toString() !== persister.getSavedBody()) {
            setBanner({
              tone: 'pending',
              text: '磁盘内容已变更；下次保存会自动合并，无法合并时生成冲突副本',
            });
            return;
          }
          if (isMetaDirty(dirty.current)) {
            setBanner({ tone: 'pending', text: '磁盘上的元数据已变更；继续编辑会以本地内容为准' });
            return;
          }

          void (async () => {
            try {
              const snapshot = await kernel.docs.read(docId);
              if (disposed || view === null) return;
              applySnapshot(snapshot);
              suppress = true;
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: persister.getSavedBody() },
              });
              suppress = false;
              setPhase('idle');
              setBanner({ tone: 'ok', text: '磁盘内容已变更，浮窗已自动重载' });
            } catch (error) {
              if (!disposed) setBanner({ tone: 'alert', text: toErrorText(error) });
            }
          })();
        });
      } catch (error) {
        if (!disposed) {
          setPhase('error');
          setBanner({ tone: 'alert', text: toErrorText(error) });
        }
      }
    };

    void start();

    return () => {
      disposed = true;
      unregisterFlusher();
      scheduleRef.current = () => undefined;
      actionsRef.current = null;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      tracker?.dispose();
      tracker = null;
      if (view !== null) {
        const body = view.state.doc.toString();
        if (hasPendingWrite(body, persister.getSavedBody(), dirty.current)) {
          // 登记到落盘队列：同一篇立刻重开时，新实例会先等这次写入完成
          trackFloatWrite(String(docId), persister.flushOnClose(body));
        }
        view.destroy();
        viewRef.current = null;
        view = null;
      }
      subscription?.dispose();
      subscription = null;
      session?.close();
      session = null;
      // 浮窗关闭 / 切换文档：状态栏不能停在上一份文档的行列号
      if (activeRef.current) onCursorRef.current(null);
    };
  }, [docId, host, kernel, inlineCloseRef, openWikiLink, queryClient]);

  // 只有最前窗响应打开意图：再次打开同一篇时把焦点还给正文 / 标题，不重建 EditorView
  const handledFocusNonce = useRef(0);
  useEffect(() => {
    if (!active || handledFocusNonce.current === focusNonce) return;
    handledFocusNonce.current = focusNonce;
    if (focus === 'title') {
      panelRef.current?.querySelector<HTMLButtonElement>('header button[title]')?.click();
      return;
    }
    // 阅读态下正文不可见，不把焦点交还给隐藏的 EditorView
    if (modeRef.current === 'read') return;
    viewRef.current?.focus();
  }, [active, focus, focusNonce]);

  // 切到最前窗立刻刷新状态栏光标：后台窗不写，新最前窗补报当前选区
  useEffect(() => {
    if (!active) return;
    const view = viewRef.current;
    if (view === null) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    onCursorRef.current({ line: line.number, column: head - line.from + 1 });
  }, [active]);

  const clearSelectionAnchor = useCallback(() => {
    setSelectionAnchor(null);
  }, []);

  return {
    host,
    setHost,
    phase,
    banner,
    title,
    tags,
    summary,
    hasSummary,
    formatState,
    mode,
    setMode,
    modeRef,
    readMarkdown,
    setReadMarkdown,
    readScrollRef,
    previousModeRef,
    outline,
    activeOutline,
    readingMinutes,
    wikiPrompt,
    setWikiPrompt,
    selectionAnchor,
    setSelectionAnchor,
    clearSelectionAnchor,
    documents,
    knownTags,
    openWikiTarget,
    actionsRef,
    panelRef,
    viewRef,
  };
};
