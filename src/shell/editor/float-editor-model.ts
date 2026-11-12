import type { DocId, VaultPath } from '#doc-model';
import type { StatusTone } from './FloatTitle.tsx';

export type SavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';
export type MetaField = 'title' | 'tags' | 'summary';

export const PHASE: Record<SavePhase, { readonly text: string; readonly tone: StatusTone }> = {
  idle: { text: '已保存', tone: 'ok' },
  dirty: { text: '未保存', tone: 'pending' },
  saving: { text: '保存中…', tone: 'pending' },
  saved: { text: '已保存', tone: 'ok' },
  conflict: { text: '冲突副本', tone: 'alert' },
  error: { text: '保存失败', tone: 'alert' },
};

export interface Notice {
  readonly tone: StatusTone;
  readonly text: string;
}

export interface WikiCandidate {
  readonly id: DocId;
  readonly path: VaultPath | null;
  readonly title: string;
}

/** 双链点击结果：歧义时列候选，未命中只提示；两种情况都不猜文档 */
export type WikiPrompt =
  | { readonly kind: 'unresolved'; readonly label: string }
  | {
      readonly kind: 'ambiguous';
      readonly label: string;
      readonly candidates: readonly WikiCandidate[];
    };

export interface FloatActions {
  readonly commitTitle: (value: string) => void;
  readonly commitTags: (next: readonly string[]) => void;
  readonly commitSummary: (value: string) => void;
}

export const DEBOUNCE_MS = 600;
/** 大纲重算延迟：输入过程中不必每个字符都扫全文 */
export const OUTLINE_REFRESH_MS = 160;

export const isMetaDirty = (dirty: Record<MetaField, boolean>): boolean =>
  dirty.title || dirty.tags || dirty.summary;

export const sameTags = (next: readonly string[], current: readonly string[]): boolean =>
  next.length === current.length && next.every((tag, index) => tag === current[index]);
