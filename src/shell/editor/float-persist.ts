import type { QueryClient } from '@tanstack/react-query';
import { splitFrontmatter } from '#doc-model';
import type { DocId } from '#doc-model';
import type { KernelContext } from '../../kernel/context.ts';
import { EmberError, isEmberError, toErrorText } from '../../kernel/errors.ts';
import type { DocRevision, DocSnapshot } from '../../kernel/types.ts';
import { titlePathCandidates } from './float-layout.ts';
import {
  isMetaDirty,
  type MetaField,
  type Notice,
  type SavePhase,
} from './float-editor-model.ts';

export interface FloatPersisterDeps {
  readonly kernel: KernelContext;
  readonly queryClient: QueryClient;
  readonly docId: DocId;
  /** 编辑器当前正文；编辑器尚未创建时返回 null */
  readonly getBody: () => string | null;
  readonly titleField: { current: string };
  readonly tagsField: { current: readonly string[] };
  readonly summaryField: { current: string };
  readonly dirty: { current: Record<MetaField, boolean> };
  readonly isDisposed: () => boolean;
  readonly setPhase: (phase: SavePhase) => void;
  readonly setBanner: (notice: Notice | null) => void;
  readonly setHasSummary: (value: boolean) => void;
}

export interface FloatPersister {
  /** 写入快照后把基线重置为磁盘版本 */
  reset(snapshot: DocSnapshot): void;
  persist(bodyOverride?: string): Promise<void>;
  /** 关窗前：等正在进行的写入结束，再用关闭瞬间的正文补写一次 */
  flushOnClose(body: string): Promise<void>;
  isSaving(): boolean;
  getBase(): DocRevision | null;
  getSavedBody(): string;
}

/**
 * 浮窗文档持久化：正文与 frontmatter 的合并、改名、冲突、写入排队。
 * 状态（基线 revision / 已保存正文 / 写入中）都封装在闭包里，随编辑器会话创建与销毁。
 */
export const createFloatPersister = (deps: FloatPersisterDeps): FloatPersister => {
  const {
    kernel,
    queryClient,
    docId,
    getBody,
    titleField,
    tagsField,
    summaryField,
    dirty,
    isDisposed,
    setPhase,
    setBanner,
    setHasSummary,
  } = deps;

  let saving = false;
  let pending: (() => void) | null = null;
  let savedBody = '';
  let base: DocRevision | null = null;

  const reset = (snapshot: DocSnapshot): void => {
    base = snapshot.meta.rev;
    savedBody = splitFrontmatter(snapshot.text).body;
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
    const body = bodyOverride ?? getBody();
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

      if (!isDisposed()) {
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
      if (!isDisposed()) {
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

  return {
    reset,
    persist,
    flushOnClose,
    isSaving: () => saving,
    getBase: () => base,
    getSavedBody: () => savedBody,
  };
};

/** 关闭 / 切换文档时是否需要补写：正文或元数据有未落盘改动 */
export const hasPendingWrite = (body: string, savedBody: string, dirty: Record<MetaField, boolean>): boolean =>
  body !== savedBody || isMetaDirty(dirty);
