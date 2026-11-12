import type { EditorView } from '@codemirror/view';
import { OUTLINE_REFRESH_MS } from './float-editor-model.ts';
import { activeOutlineIndex, collectOutline, type OutlineHeading } from './outline.ts';
import { estimateReadingMinutes } from './reading-time.ts';

export interface OutlineTrackerDeps {
  readonly editor: EditorView;
  readonly isDisposed: () => boolean;
  readonly onOutline: (headings: readonly OutlineHeading[]) => void;
  readonly onActive: (index: number) => void;
  readonly onReadingMinutes: (minutes: number | null) => void;
  /** 滚动时优先收起跟随选区的浮层 */
  readonly onScroll: () => void;
}

export interface OutlineTracker {
  /** 文档变化后按 160ms 节流重算大纲、当前标题与阅读时长 */
  schedule(): void;
  dispose(): void;
}

/** 大纲 / 当前标题 / 阅读时长的滚动与防抖管理，随编辑器会话创建与销毁 */
export const createOutlineTracker = (deps: OutlineTrackerDeps): OutlineTracker => {
  const { editor, isDisposed, onOutline, onActive, onReadingMinutes, onScroll } = deps;
  let timer: number | null = null;
  let raf = 0;
  let disposed = false;
  let headings: readonly OutlineHeading[] = [];

  const publish = (): void => {
    headings = collectOutline(editor.state.doc.toString());
    onOutline(headings);
  };
  const syncActive = (): void => {
    if (isDisposed()) return;
    const top = editor.lineBlockAtHeight(editor.scrollDOM.scrollTop).from;
    const line = editor.state.doc.lineAt(top).number;
    onActive(activeOutlineIndex(headings, line));
  };

  const scrollHandler = (): void => {
    onScroll();
    if (raf !== 0) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      syncActive();
    });
  };

  publish();
  syncActive();
  editor.scrollDOM.addEventListener('scroll', scrollHandler, { passive: true });

  return {
    schedule: () => {
      if (disposed) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (disposed || isDisposed()) return;
        publish();
        syncActive();
        // 与大纲共用同一个 160ms 节奏，避免再引入第二个独立防抖计时器
        onReadingMinutes(estimateReadingMinutes(editor.state.doc.toString()));
      }, OUTLINE_REFRESH_MS);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      editor.scrollDOM.removeEventListener('scroll', scrollHandler);
    },
  };
};
