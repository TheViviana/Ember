import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  buildResolutionIndex,
  resolveLink,
  type LinkTarget,
  type WikiLink,
} from '#doc-model';
import type { KernelContext } from '../../kernel/context.ts';
import { useFloatStore } from './float-store.ts';
import type { WikiPrompt } from './float-editor-model.ts';

/** 双链解析与文档元数据：编辑态点击与阅读态点击共用同一套解析 */
export const useFloatLinks = (
  kernel: KernelContext,
  tags: readonly string[],
  setWikiPrompt: (prompt: WikiPrompt | null) => void,
) => {
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
   */
  const openWikiLink = useCallback(
    (link: WikiLink): void => {
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
    },
    [setWikiPrompt],
  );

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

  return { documents, openWikiLink, openWikiTarget, knownTags };
};
