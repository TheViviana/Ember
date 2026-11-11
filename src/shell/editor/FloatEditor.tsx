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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import {
  buildResolutionIndex,
  resolveLink,
  splitFrontmatter,
  type DocId,
  type LinkTarget,
  type VaultPath,
  type WikiLink,
} from '#doc-model';
import { useMachineStore, type FloatPosition } from '../../data/stores/machine-store.ts';
import type { EditorSession } from '../../kernel/editor-host.ts';
import { EmberError, isEmberError, toErrorText } from '../../kernel/errors.ts';
import type { Disposable, DocChange, DocRevision, DocSnapshot } from '../../kernel/types.ts';
import { cssVars } from '../canvas/css-vars.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import type { AiActionId } from '../ai/actions.ts';
import { InlineAiResult } from '../ai/InlineAiResult.tsx';
import { SelectionAiMenu, type SelectionAnchor } from '../ai/SelectionAiMenu.tsx';
import { useInlineAi } from '../ai/use-inline-ai.ts';
import { layout, space } from '../theme/tokens.ts';
import { emberEditorThemeExtensions } from './cm-theme.ts';
import type { CursorPosition } from './cursor.ts';
import { settleFloatWrite, trackFloatWrite } from './float-flush.ts';
import {
  cascadeFloatFrame,
  clampFloatSize,
  FLOAT_ZONES,
  initialFloatFrame,
  moveFloatFrame,
  resolveFloatResize,
  titlePathCandidates,
  type FloatBounds,
  type FloatContainer,
  type FloatFrame,
  type FloatSize,
  type FloatZone,
} from './float-layout.ts';
import { useFloatStore } from './float-store.ts';
import { focusedFloatFrame } from './focus-layout.ts';
import { useFocusStore } from './focus-store.ts';
import { collectWikiLinks, incrementalDecorationPlugin } from './incremental-decorations.ts';
import { activeOutlineIndex, collectOutline, type OutlineHeading } from './outline.ts';
import { estimateReadingMinutes } from './reading-time.ts';
import { findWikiLinkAt, isInsideCode } from './wiki-link.ts';
import { slashCommands } from './slash-commands.ts';
import {
  EMPTY_FORMAT_STATE,
  formatStateAt,
  insertLink,
  sameFormatState,
  toggleBlock,
  toggleHeading,
  toggleInline,
  type BlockFormat,
  type FormatState,
  type HeadingLevel,
  type InlineFormat,
} from './format-commands.ts';
import { FormatToolbar, type ToolbarMode } from './FormatToolbar.tsx';
import { ReadingView } from './ReadingView.tsx';
import { BacklinksPanel } from './BacklinksPanel.tsx';
import { OutlinePanel } from './OutlinePanel.tsx';
import { FloatTagBar } from './FloatTagBar.tsx';
import { FloatTitle, type StatusTone } from './FloatTitle.tsx';
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

type SavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';
type MetaField = 'title' | 'tags' | 'summary';

const PHASE: Record<SavePhase, { readonly text: string; readonly tone: StatusTone }> = {
  idle: { text: '已保存', tone: 'ok' },
  dirty: { text: '未保存', tone: 'pending' },
  saving: { text: '保存中…', tone: 'pending' },
  saved: { text: '已保存', tone: 'ok' },
  conflict: { text: '冲突副本', tone: 'alert' },
  error: { text: '保存失败', tone: 'alert' },
};

interface Notice {
  readonly tone: StatusTone;
  readonly text: string;
}

interface WikiCandidate {
  readonly id: DocId;
  readonly path: VaultPath | null;
  readonly title: string;
}

/** 双链点击结果：歧义时列候选，未命中只提示；两种情况都不猜文档 */
type WikiPrompt =
  | { readonly kind: 'unresolved'; readonly label: string }
  | {
      readonly kind: 'ambiguous';
      readonly label: string;
      readonly candidates: readonly WikiCandidate[];
    };

interface ResizeDrag {
  readonly zone: FloatZone;
  readonly start: FloatFrame;
  readonly bounds: FloatBounds;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
}

/** 标题栏拖动：超过阈值才接管，未超过时把点击留给标题（原地改名） */
interface MoveDrag {
  readonly start: FloatFrame;
  readonly container: FloatContainer;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  engaged: boolean;
}

interface FloatActions {
  readonly commitTitle: (value: string) => void;
  readonly commitTags: (next: readonly string[]) => void;
  readonly commitSummary: (value: string) => void;
}

const DEBOUNCE_MS = 600;
/** 大纲重算延迟：输入过程中不必每个字符都扫全文 */
const OUTLINE_REFRESH_MS = 160;
/** 拖窗判定阈值：小于它算点击（标题原地改名），不小于它才算拖动 */
const MOVE_THRESHOLD_PX = 3;

const SPACE_XL = Number.parseFloat(space.xl);
const FLOAT_INSET_RIGHT = SPACE_XL;
const FLOAT_INSET_BOTTOM = SPACE_XL + layout.statusbarHeight;

const readBounds = (): FloatBounds => {
  const width = typeof window === 'undefined' ? 0 : (window.screen?.availWidth ?? 0);
  const height = typeof window === 'undefined' ? 0 : (window.screen?.availHeight ?? 0);
  return {
    maxWidth: width > 0 ? width : layout.floatWidth,
    maxHeight: height > 0 ? height : layout.floatHeight,
  };
};

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
  /** 选区 AI 的内联结果：流式内容、替换与撤销都只在本次运行内 */
  const inlineAi = useInlineAi(kernel, docId);
  /** Esc 仲裁层 id：每个浮窗实例独立（多浮窗时后挂载者持有 Esc） */
  const escLayerId = useId();
  const inlineClose = inlineAi.close;
  const inlineCloseRef = useRef(inlineClose);
  inlineCloseRef.current = inlineClose;

  const panelRef = useRef<HTMLElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [frame, setFrame] = useState<FloatFrame | null>(null);
  const frameRef = useRef<FloatFrame | null>(null);
  const dragRef = useRef<ResizeDrag | null>(null);
  const moveRef = useRef<MoveDrag | null>(null);
  const resizedRef = useRef(false);
  const movedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const initializedSizeRef = useRef<FloatSize | undefined>(undefined);
  const initializedPositionRef = useRef<FloatPosition | undefined>(undefined);
  const [resizing, setResizing] = useState(false);
  const [moving, setMoving] = useState(false);
  const bounds = useMemo(readBounds, []);
  /** 专注模式只对当前目标浮窗生效；几何在渲染时临时计算，不写回 frame */
  const focusActive = useFocusStore((state) => state.active);
  const focusDocId = useFocusStore((state) => state.docId);
  const focused = focusActive && focusDocId !== null && String(focusDocId) === String(docId);
  /** 容器实测尺寸：专注几何需要随窗口缩放实时居中放大 */
  const [containerSize, setContainerSize] = useState<FloatContainer | null>(null);

  const savedSize = useMachineStore((state) => state.floatSizes[String(docId)]);
  const savedPosition = useMachineStore((state) => state.floatPositions[String(docId)]);
  const rememberFloatSize = (id: string, size: FloatSize): void => {
    useMachineStore.getState().rememberFloatSize(id, size);
  };
  const rememberFloatPosition = (id: string, position: FloatPosition): void => {
    useMachineStore.getState().rememberFloatPosition(id, position);
  };

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  // 双链解析复用 doc-model 的四级索引：路径 → 文件名 → 标题 → 别名
  const linkTargets = useMemo<readonly LinkTarget[]>(
    () =>
      (documents.data ?? []).map((doc) => ({
        id: doc.id,
        path: doc.path,
        title: doc.title,
        aliases: doc.aliases,
      })),
    [documents.data],
  );
  const linkIndex = useMemo(() => buildResolutionIndex(linkTargets), [linkTargets]);
  const targetById = useMemo(() => {
    const map = new Map<string, LinkTarget>();
    for (const target of linkTargets) map.set(String(target.id), target);
    return map;
  }, [linkTargets]);
  // 点击处理里闭包捕获的是创建编辑器时的值，索引与候选信息统一走 ref 保持最新
  const linkIndexRef = useRef(linkIndex);
  const targetByIdRef = useRef(targetById);
  useEffect(() => {
    linkIndexRef.current = linkIndex;
    targetByIdRef.current = targetById;
  }, [linkIndex, targetById]);

  /**
   * 双链点击：命中直接走浮窗 store 的 open 语义；
   * 标题/别名多命中只列候选，解析不到只提示 —— 两种情况都不猜文档。
   * 编辑态点击与阅读态点击共用这一处，避免两套解析。
   */
  const openWikiLink = useCallback((link: WikiLink): void => {
    const resolved = resolveLink(link, linkIndexRef.current);
    if (resolved.targetId !== null) {
      setWikiPrompt(null);
      useFloatStore.getState().open(resolved.targetId, null);
      return;
    }
    if (resolved.resolver === 'ambiguous') {
      setWikiPrompt({
        kind: 'ambiguous',
        label: link.target,
        candidates: resolved.candidates.map((id) => {
          const target = targetByIdRef.current.get(String(id));
          return { id, path: target?.path ?? null, title: target?.title ?? '' };
        }),
      });
      return;
    }
    setWikiPrompt({ kind: 'unresolved', label: link.target });
  }, []);

  /** 阅读态只拿到目标文本：补一个最小 WikiLink，复用同一套命中逻辑 */
  const openWikiTarget = useCallback(
    (target: string): void => {
      // `[[文档#小节]]` 与编辑态一致：文档部分参与命中，锚点暂不滚动
      const hash = target.indexOf('#');
      const name = hash >= 0 ? target.slice(0, hash) : target;
      if (name.trim().length === 0) return;
      const anchor = hash >= 0 ? target.slice(hash + 1).trim() : '';
      openWikiLink({
        embed: false,
        target: name,
        label: null,
        anchor: anchor.length > 0 ? anchor : null,
        raw: `[[${target}]]`,
        start: 0,
        end: 0,
      });
    },
    [openWikiLink],
  );

  const knownTags = useMemo(() => {
    const set = new Set<string>(tags);
    for (const doc of documents.data ?? []) {
      for (const tag of doc.tags) set.add(tag);
    }
    return [...set].sort((left, right) => left.localeCompare(right));
  }, [documents.data, tags]);

  const titleField = useRef('');
  const tagsField = useRef<readonly string[]>([]);
  const summaryField = useRef('');
  const dirty = useRef<Record<MetaField, boolean>>({ title: false, tags: false, summary: false });
  const scheduleRef = useRef<() => void>(() => undefined);
  const actionsRef = useRef<FloatActions | null>(null);

  const applyFrame = useCallback((next: FloatFrame): void => {
    frameRef.current = next;
    setFrame(next);
  }, []);

  // 右侧 AI 面板开合会缩窄画布：只按新容器重新夹取当前帧，绝不写回位置记忆
  useEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement ?? null;
    if (container === null) return;
    const observer = new ResizeObserver(() => {
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
      const area = { width: container.clientWidth, height: container.clientHeight };
      // 专注几何依赖容器实测尺寸；与下面的普通帧夹紧共用同一次观测
      setContainerSize(area);
      const current = frameRef.current;
      if (current === null) return;
      const sized = clampFloatSize({ width: current.width, height: current.height }, bounds);
      const next = moveFloatFrame({ ...current, width: sized.width, height: sized.height }, 0, 0, area);
      if (
        next.left !== current.left ||
        next.top !== current.top ||
        next.width !== current.width ||
        next.height !== current.height
      ) {
        applyFrame(next);
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [applyFrame, bounds]);

  // 首次打开（或水合完成）时按记忆尺寸与位置摆放；用户拖动/缩放过后不再被存储更新覆盖
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement ?? null;
    if (container === null) return;
    if (
      frameRef.current !== null &&
      (resizedRef.current ||
        movedRef.current ||
        (savedSize === initializedSizeRef.current && savedPosition === initializedPositionRef.current))
    ) {
      return;
    }
    if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
    const target = clampFloatSize(
      savedSize ?? { width: layout.floatWidth, height: layout.floatHeight },
      bounds,
    );
    const area = { width: container.clientWidth, height: container.clientHeight };
    initializedSizeRef.current = savedSize;
    initializedPositionRef.current = savedPosition;
    const base =
      savedPosition === undefined
        ? cascadeFloatFrame(
            area,
            target,
            { right: FLOAT_INSET_RIGHT, bottom: FLOAT_INSET_BOTTOM },
            defaultSlot,
          )
        : initialFloatFrame(area, target, { right: FLOAT_INSET_RIGHT, bottom: FLOAT_INSET_BOTTOM });
    // 记忆位置可能来自更宽的窗口/另一块屏，恢复时按当前容器夹紧
    applyFrame(
      savedPosition === undefined
        ? base
        : moveFloatFrame({ ...base, left: savedPosition.left, top: savedPosition.top }, 0, 0, area),
    );
  }, [applyFrame, bounds, defaultSlot, savedPosition, savedSize]);

  const beginMove = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    // 专注模式下位置由临时几何决定，标题栏不再承担拖动
    if (focused) return;
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, [contenteditable="true"], [data-float-close], [data-float-focus]',
      ) !== null
    ) {
      return;
    }
    const start = frameRef.current;
    const container = panelRef.current?.parentElement ?? null;
    if (start === null || container === null) return;
    suppressClickRef.current = false;
    moveRef.current = {
      start,
      container: { width: container.clientWidth, height: container.clientHeight },
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      engaged: false,
    };
  };

  const moveMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = moveRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.engaged) {
      if (Math.abs(deltaX) < MOVE_THRESHOLD_PX && Math.abs(deltaY) < MOVE_THRESHOLD_PX) return;
      drag.engaged = true;
      // 拖动一旦成立就吃掉随后的 click，避免松手顺带把标题切进编辑态
      suppressClickRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMoving(true);
    }
    event.preventDefault();
    applyFrame(moveFloatFrame(drag.start, deltaX, deltaY, drag.container));
  };

  const endMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = moveRef.current;
    if (drag === null) return;
    moveRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.engaged) return;
    setMoving(false);
    movedRef.current = true;
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆位置；拖动期间不写文档、也不写机器状态
      rememberFloatPosition(String(docId), { left: current.left, top: current.top });
    }
  };

  const suppressDraggedClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const beginResize = (zone: FloatZone, event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const start = frameRef.current;
    if (start === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      zone,
      start,
      // 每次拖动重新读取工作区，换显示器后夹紧范围仍然正确
      bounds: readBounds(),
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    resizedRef.current = true;
    setResizing(true);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    applyFrame(
      resolveFloatResize(drag.zone, drag.start, event.clientX - drag.x, event.clientY - drag.y, drag.bounds),
    );
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆；拖动期间不写文档、也不写机器状态
      rememberFloatSize(String(docId), { width: current.width, height: current.height });
    }
  };

  // 浮窗内的滚轮只作用于编辑器/大纲，不冒泡到画布触发缩放。
  // 用原生监听而非 React onWheel：画布的 wheel 监听挂在浮窗的祖先节点上，
  // React 的合成事件在根节点才派发，拦不住祖先的原生监听。
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return undefined;
    const stopWheel = (event: WheelEvent): void => {
      event.stopPropagation();
    };
    node.addEventListener('wheel', stopWheel, { passive: true });
    return () => {
      node.removeEventListener('wheel', stopWheel);
    };
  }, []);

  useEffect(() => {
    if (host === null) return undefined;

    let disposed = false;
    let view: EditorView | null = null;
    let session: EditorSession | null = null;
    let subscription: Disposable | null = null;
    let timer: number | null = null;
    let saving = false;
    let pending: (() => void) | null = null;
    let savedBody = '';
    let base: DocRevision | null = null;
    let suppress = false;
    let outlineTimer: number | null = null;
    let outlineRaf = 0;
    let scrollHandler: (() => void) | null = null;
    let scheduleOutline: (() => void) | null = null;

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

    const applySnapshot = (snapshot: DocSnapshot): void => {
      base = snapshot.meta.rev;
      savedBody = splitFrontmatter(snapshot.text).body;
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

    /** 标题改名后同步文件名；只改路径，不改内容。 */
    const syncFileName = async (snapshot: DocSnapshot, rawTitle: string): Promise<DocSnapshot> => {
      for (const candidate of titlePathCandidates(snapshot.meta.path, rawTitle)) {
        if (String(candidate) === String(snapshot.meta.path)) return snapshot;
        try {
          const renamed = await kernel.docs.rename(docId, candidate, {
            base: snapshot.meta.rev,
            intent: 'user',
          });
          return renamed.snapshot;
        } catch (error) {
          if (isEmberError(error) && error.code === 'path_exists') continue;
          throw error;
        }
      }
      throw new EmberError('path_exists', '找不到可用的文件名，标题已保留');
    };

    const persist = async (bodyOverride?: string): Promise<void> => {
      if (base === null) return;
      const body = bodyOverride ?? (view === null ? null : view.state.doc.toString());
      if (body === null) return;
      if (saving) {
        pending = () => {
          void persist();
        };
        return;
      }

      const bodyPatch = body === savedBody ? null : body;
      const titleChanged = dirty.current.title;
      const requestedTitle = titleField.current;
      const tagsChanged = dirty.current.tags;
      const requestedTags = tagsField.current;
      const summaryChanged = dirty.current.summary;
      const requestedSummary = summaryField.current;
      const frontmatter: {
        title?: string | null;
        tags?: readonly string[];
        summary?: string | null;
      } = {};
      if (titleChanged) {
        const value = requestedTitle.trim();
        frontmatter.title = value.length === 0 ? null : value;
      }
      if (tagsChanged) frontmatter.tags = requestedTags;
      if (summaryChanged) {
        const value = requestedSummary.trim();
        // 清空 = 删键，回落到正文派生；绝不把派生值写盘
        frontmatter.summary = value.length === 0 ? null : value;
      }
      const hasFrontmatter = Object.keys(frontmatter).length > 0;
      if (bodyPatch === null && !hasFrontmatter) {
        setPhase('saved');
        return;
      }

      saving = true;
      setPhase('saving');
      try {
        const outcome = await kernel.docs.update(
          docId,
          {
            ...(bodyPatch === null ? {} : { body: bodyPatch }),
            ...(hasFrontmatter ? { frontmatter } : {}),
          },
          { base, intent: 'user' },
        );
        base = outcome.snapshot.meta.rev;
        savedBody = splitFrontmatter(outcome.snapshot.text).body;
        // 只清掉本次真正写入的字段；保存期间的新改动留给排队中的下一次保存。
        // 冲突时本地元数据在冲突副本里、未进磁盘，保留 dirty 以便下次重试。
        if (outcome.conflict === null) {
          if (titleChanged && titleField.current === requestedTitle) dirty.current.title = false;
          if (tagsChanged && tagsField.current === requestedTags) dirty.current.tags = false;
          if (summaryChanged && summaryField.current === requestedSummary) dirty.current.summary = false;
        }

        let snapshot = outcome.snapshot;
        let renameWarning: string | null = null;
        if (titleChanged && outcome.conflict === null) {
          try {
            snapshot = await syncFileName(snapshot, requestedTitle);
            base = snapshot.meta.rev;
          } catch (error) {
            // 标题已落盘；改名失败只提示，不清空输入或正文
            renameWarning = `标题已保存，但文件名同步失败：${toErrorText(error)}（内容未丢失）`;
          }
        }

        if (!disposed) {
          setHasSummary(snapshot.frontmatter.summary !== null);
          if (outcome.conflict !== null) {
            setPhase('conflict');
            setBanner({
              tone: 'alert',
              text: `三方合并失败，已保留磁盘版本并生成冲突副本：${String(outcome.conflict.path)}`,
            });
          } else if (renameWarning !== null) {
            setPhase('saved');
            setBanner({ tone: 'pending', text: renameWarning });
          } else {
            setPhase('saved');
            setBanner(null);
          }
        }
        void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
      } catch (error) {
        if (!disposed) {
          setPhase('error');
          setBanner({ tone: 'alert', text: toErrorText(error) });
        }
      } finally {
        saving = false;
        const next = pending;
        pending = null;
        if (next !== null) next();
      }
    };

    /**
     * 关闭浮窗前调用：等正在进行的写入与排队中的一次写入都结束，
     * 再用关闭瞬间捕获的正文补写，避免「保存中关闭」丢掉最后一次输入。
     */
    const flushOnClose = async (body: string): Promise<void> => {
      while (saving) {
        await new Promise<void>((resolve) => {
          const previous = pending;
          pending = () => {
            previous?.();
            resolve();
          };
        });
      }
      await persist(body);
    };

    const scheduleSave = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (!disposed) void persist();
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
      void persist();
    };

    const commitTags = (next: readonly string[]): void => {
      const same =
        next.length === tagsField.current.length &&
        next.every((tag, index) => tag === tagsField.current[index]);
      if (same) return;
      tagsField.current = next;
      setTags(next);
      dirty.current.tags = true;
      setPhase('saving');
      void persist();
    };

    const commitSummary = (value: string): void => {
      if (value === summaryField.current.trim()) return;
      summaryField.current = value;
      dirty.current.summary = true;
      setPhase('saving');
      void persist();
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
                  const start = update.view.coordsAtPos(main.from);
                  const end = update.view.coordsAtPos(main.to);
                  if (start !== null && end !== null) {
                    const panelRect = panel.getBoundingClientRect();
                    const left = Math.min(start.left, end.left) - panelRect.left;
                    const top = Math.min(start.top, end.top) - panelRect.top;
                    const right = Math.max(start.right, end.right) - panelRect.left;
                    const bottom = Math.max(start.bottom, end.bottom) - panelRect.top;
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
                scheduleOutline?.();
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

        const editor = view;
        const publishOutline = (): void => {
          const next = collectOutline(editor.state.doc.toString());
          outlineRef.current = next;
          if (!disposed) setOutline(next);
        };
        const syncActive = (): void => {
          if (disposed) return;
          const top = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop).from;
          const line = editor.state.doc.lineAt(top).number;
          setActiveOutline(activeOutlineIndex(outlineRef.current, line));
        };
        publishOutline();
        syncActive();

        scheduleOutline = (): void => {
          if (outlineTimer !== null) window.clearTimeout(outlineTimer);
          outlineTimer = window.setTimeout(() => {
            outlineTimer = null;
            if (disposed) return;
            publishOutline();
            syncActive();
            // 与大纲共用同一个 160ms 节奏，避免再引入第二个独立防抖计时器
            setReadingMinutes(estimateReadingMinutes(editor.state.doc.toString()));
          }, OUTLINE_REFRESH_MS);
        };

        scrollHandler = (): void => {
          // 选区菜单滚出原位后不再跟随，直接收起；内联块留在冻结的锚点上，不被滚动打断
          setSelectionAnchor(null);
          if (outlineRaf !== 0) return;
          outlineRaf = window.requestAnimationFrame(() => {
            outlineRaf = 0;
            syncActive();
          });
        };
        editor.scrollDOM.addEventListener('scroll', scrollHandler, { passive: true });

        subscription = kernel.events.on('doc:changed', (change: DocChange) => {
          if (String(change.id) !== String(docId)) return;
          if (change.kind === 'removed' || change.kind === 'renamed') {
            void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
            return;
          }
          if (change.kind !== 'external' && change.kind !== 'updated') return;
          if (saving || (base !== null && change.revision.hash === base.hash)) return;

          const metaDirty = dirty.current.title || dirty.current.tags || dirty.current.summary;
          if (view !== null && view.state.doc.toString() !== savedBody) {
            setBanner({
              tone: 'pending',
              text: '磁盘内容已变更；下次保存会自动合并，无法合并时生成冲突副本',
            });
            return;
          }
          if (metaDirty) {
            setBanner({ tone: 'pending', text: '磁盘上的元数据已变更；继续编辑会以本地内容为准' });
            return;
          }

          void (async () => {
            try {
              const snapshot = await kernel.docs.read(docId);
              if (disposed || view === null) return;
              applySnapshot(snapshot);
              suppress = true;
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: savedBody } });
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
      scheduleRef.current = () => undefined;
      actionsRef.current = null;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (outlineTimer !== null) {
        window.clearTimeout(outlineTimer);
        outlineTimer = null;
      }
      if (outlineRaf !== 0) {
        window.cancelAnimationFrame(outlineRaf);
        outlineRaf = 0;
      }
      if (scrollHandler !== null && view !== null) {
        view.scrollDOM.removeEventListener('scroll', scrollHandler);
        scrollHandler = null;
      }
      scheduleOutline = null;
      if (view !== null) {
        const body = view.state.doc.toString();
        const metaDirty = dirty.current.title || dirty.current.tags || dirty.current.summary;
        if (body !== savedBody || metaDirty) {
          // 登记到落盘队列：同一篇立刻重开时，新实例会先等这次写入完成
          trackFloatWrite(String(docId), flushOnClose(body));
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
  }, [docId, host, kernel, openWikiLink, queryClient]);

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

  /** 专注几何只覆盖渲染值；底层 frame 保持原样，退出后原位置尺寸立即回来 */
  const focusFrame = useMemo(
    () => (focused && containerSize !== null ? focusedFloatFrame(containerSize) : null),
    [containerSize, focused],
  );
  const renderedFrame = focusFrame ?? frame;

  const geometry =
    renderedFrame === null
      ? undefined
      : cssVars({
          '--float-left': `${renderedFrame.left}px`,
          '--float-top': `${renderedFrame.top}px`,
          '--float-right': 'auto',
          '--float-bottom': 'auto',
          '--float-w': `${renderedFrame.width}px`,
          '--float-h': `${renderedFrame.height}px`,
        });

  const phaseInfo = PHASE[phase];

  useEffect(() => {
    if (!active) {
      setSelectionAnchor(null);
      inlineCloseRef.current();
    }
  }, [active]);

  const closeSelectionMenu = useCallback((): void => {
    setSelectionAnchor(null);
  }, []);

  /** 选中文本就地生成：锚点、偏移与正文快照都在这时冻结，之后不再依赖实时选区 */
  const pickSelectionAction = useCallback(
    (action: AiActionId): void => {
      const view = viewRef.current;
      const anchor = selectionAnchor;
      if (view === null || anchor === null) return;
      const main = view.state.selection.main;
      if (main.empty) return;
      const text = view.state.sliceDoc(main.from, main.to);
      if (text.trim() === '') return;
      setSelectionAnchor(null);
      inlineAi.start({
        action,
        anchor,
        from: main.from,
        to: main.to,
        text,
        readBody: () => view.state.doc.toString(),
      });
    },
    [inlineAi, selectionAnchor],
  );

  const jumpToHeading = (line: number): void => {
    const view = viewRef.current;
    if (view === null) return;
    const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 8 }),
    });
    view.focus();
  };

  const applyInlineFormat = useCallback((format: InlineFormat): void => {
    const view = viewRef.current;
    if (view === null) return;
    toggleInline(view, format);
  }, []);

  const applyBlockFormat = useCallback((format: BlockFormat): void => {
    const view = viewRef.current;
    if (view === null) return;
    toggleBlock(view, format);
  }, []);

  const applyHeading = useCallback((level: HeadingLevel): void => {
    const view = viewRef.current;
    if (view === null) return;
    toggleHeading(view, level);
  }, []);

  const applyLink = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    insertLink(view);
  }, []);

  /** 进入阅读：记录滚动位置与正文快照，只隐藏 EditorView，不销毁 */
  const enterReadMode = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    readScrollRef.current = view.scrollDOM.scrollTop;
    setReadMarkdown(view.state.doc.toString());
    setSelectionAnchor(null);
    inlineCloseRef.current();
    setWikiPrompt(null);
    modeRef.current = 'read';
    setMode('read');
    // 正文不可见时不让键盘继续落进隐藏的编辑器
    view.contentDOM.blur();
  }, []);

  const toggleMode = useCallback((): void => {
    if (modeRef.current === 'read') {
      modeRef.current = 'edit';
      setMode('edit');
      return;
    }
    enterReadMode();
  }, [enterReadMode]);

  // 退出阅读：焦点先回编辑器，再把进入前的滚动位置写回去（focus 可能触发滚动）
  useLayoutEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = mode;
    if (previous !== 'read' || mode !== 'edit') return undefined;
    const view = viewRef.current;
    if (view === null) return undefined;
    const top = readScrollRef.current;
    if (activeRef.current) view.focus();
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
  }, [mode]);

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
  }, [escLayerId, focused, mode, wikiPrompt]);

  // 编辑态专注的 Esc 出口；标题改名、选区菜单与内联结果自己消费 Esc，不在这里抢
  useEscLayer(`float-focus${escLayerId}`, focused && mode === 'edit');
  useEffect(() => {
    if (!focused || mode !== 'edit') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 选区 AI 菜单或内联结果打开时，先让它们按自己的 Esc 收起（它们也更晚入栈）
      if (selectionAnchor !== null || inlineAi.run !== null) return;
      if (!isEscTop(`float-focus${escLayerId}`)) return;
      event.preventDefault();
      useFocusStore.getState().exit();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [escLayerId, focused, mode, selectionAnchor, inlineAi.run]);

  return (
    <section
      ref={panelRef}
      className={`${styles.float} ${resizing ? styles.resizing : ''} ${moving ? styles.moving : ''}`}
      style={geometry}
      data-canvas-overlay
      data-float-editor=""
      aria-label="文档浮窗"
    >
      <header
        className={styles.header}
        onPointerDown={beginMove}
        onPointerMove={moveMove}
        onPointerUp={endMove}
        onPointerCancel={endMove}
        onLostPointerCapture={endMove}
        onClickCapture={suppressDraggedClick}
      >
        <FloatTitle
          title={title}
          statusText={phaseInfo.text}
          statusTone={phaseInfo.tone}
          readingMinutes={readingMinutes}
          autoFocus={focus === 'title' && active}
          focused={focused}
          onCommit={(value) => {
            actionsRef.current?.commitTitle(value);
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
        tags={tags}
        knownTags={knownTags}
        summary={summary}
        hasSummary={hasSummary}
        onTagsChange={(next) => {
          actionsRef.current?.commitTags(next);
        }}
        onSummaryCommit={(value) => {
          actionsRef.current?.commitSummary(value);
        }}
      />

      <FormatToolbar
        state={formatState}
        disabled={phase === 'error'}
        mode={mode}
        onInline={applyInlineFormat}
        onBlock={applyBlockFormat}
        onHeading={applyHeading}
        onLink={applyLink}
        onToggleMode={toggleMode}
      />

      <div className={styles.content}>
        <div className={styles.host} ref={setHost} hidden={mode === 'read'} />
        {mode === 'read' ? (
          <ReadingView markdown={readMarkdown} onWikiLink={openWikiTarget} />
        ) : (
          <>
            <OutlinePanel headings={outline} activeIndex={activeOutline} onJump={jumpToHeading} />
            <BacklinksPanel docId={docId} />
          </>
        )}

        {wikiPrompt === null ? null : (
          <div className={styles.wikiPrompt} role="dialog" aria-label="双链跳转">
            <div className={styles.wikiHead}>
              <span className={styles.wikiTarget}>[[{wikiPrompt.label}]]</span>
              <button
                type="button"
                className={styles.wikiClose}
                aria-label="关闭双链提示"
                onClick={() => {
                  setWikiPrompt(null);
                }}
              >
                ×
              </button>
            </div>

            {wikiPrompt.kind === 'unresolved' ? (
              <>
                <p className={styles.wikiText}>未找到《{wikiPrompt.label}》对应的文档，未跳转。</p>
                <p className={styles.wikiHint}>请检查标题、文件名或 frontmatter 别名是否一致。</p>
              </>
            ) : (
              <>
                <p className={styles.wikiText}>
                  《{wikiPrompt.label}》匹配到 {wikiPrompt.candidates.length} 篇文档，请选择要打开的一篇：
                </p>
                <div className={styles.wikiList}>
                  {wikiPrompt.candidates.map((candidate) => (
                    <button
                      type="button"
                      className={styles.wikiCandidate}
                      key={String(candidate.id)}
                      onClick={() => {
                        setWikiPrompt(null);
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

      {selectionAnchor === null ? null : (
        <SelectionAiMenu
          anchor={selectionAnchor}
          disabled={kernel.env.readonlyMode}
          onPick={pickSelectionAction}
          onClose={closeSelectionMenu}
        />
      )}

      {focused
        ? null
        : FLOAT_ZONES.map((zone) => (
            <div
              key={zone}
              className={styles.handle}
              data-zone={zone}
              aria-hidden="true"
              onPointerDown={(event) => {
                beginResize(zone, event);
              }}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onLostPointerCapture={endResize}
            />
          ))}
    </section>
  );
};
