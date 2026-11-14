import { useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { unsafeDocId, unsafeVaultPath } from '#doc-model';
import type { DocMeta } from '../../kernel/types.ts';
import { isEmberError, toErrorText } from '../../kernel/errors.ts';
import { useKernel } from '../kernel-provider.tsx';
import { baseNameOf, compareNatural, joinDirPath, parentDirOf } from './doc-tree.ts';

export interface PanelNotice {
  readonly tone: 'ok' | 'error';
  readonly text: string;
  readonly action?: { readonly label: string; readonly run: () => void };
}

export interface DocMoveApi {
  /** 右键「移动到…」的可选目录：磁盘目录 ∪ 文档路径反推（库根由调用方单独提供） */
  readonly moveDirs: readonly string[];
  readonly moveDoc: (docId: string, fromPath: string, targetDir: string) => void;
  readonly undoLastMove: () => void;
}

interface MoveRecord {
  readonly docId: string;
  readonly from: string;
  readonly to: string;
}

/**
 * 文档移动的唯一入口（拖拽与右键菜单共用）：
 * 统一走 `docs.rename`，成功后内存记一条可撤销记录；预检只读正文反链、不改写任何文章。
 * 撤销是反向 rename；目标被占用时明确失败并保留新位置。
 */
export const useDocMove = (
  documents: readonly DocMeta[],
  setNotice: (notice: PanelNotice | null) => void,
  dirs: readonly string[] = [],
): DocMoveApi => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const lastMoveRef = useRef<MoveRecord | null>(null);

  const invalidateDocs = useCallback((): void => {
    // 目录查询与文档查询一起失效：建/删目录不产生 watcher 事件，不能等轮询
    void queryClient.invalidateQueries({ queryKey: ['docs'] });
  }, [queryClient]);

  /** 预检：正文里指向这篇文档的显式路径链接（含 `/` 或 `.md`）以索引反链为准，只读不改写 */
  const countExplicitPathRefs = useCallback(
    async (docId: string): Promise<number> => {
      try {
        const links = await kernel.index.backlinks(unsafeDocId(docId));
        return links.filter((link) => link.raw.includes('/') || link.raw.toLowerCase().endsWith('.md')).length;
      } catch {
        return 0;
      }
    },
    [kernel],
  );

  const undoLastMove = useCallback((): void => {
    const record = lastMoveRef.current;
    lastMoveRef.current = null;
    if (record === null) return;
    void (async () => {
      try {
        const snapshot = await kernel.docs.read(unsafeDocId(record.docId));
        if (String(snapshot.meta.path) !== record.to) {
          setNotice({ tone: 'error', text: '文档已不在移动后的位置，无法撤销' });
          return;
        }
        await kernel.docs.rename(unsafeDocId(record.docId), unsafeVaultPath(record.from), {
          base: snapshot.meta.rev,
          intent: 'user',
        });
        invalidateDocs();
        const home = parentDirOf(record.from);
        setNotice({ tone: 'ok', text: `已撤销移动，回到 ${home.length === 0 ? '库根' : home}` });
      } catch (cause) {
        if (isEmberError(cause) && cause.code === 'path_exists') {
          setNotice({ tone: 'error', text: '撤销失败：原位置已被占用，保留当前位置' });
        } else {
          setNotice({ tone: 'error', text: `撤销失败：${toErrorText(cause)}` });
        }
      }
    })();
  }, [invalidateDocs, kernel, setNotice]);

  const moveDoc = useCallback(
    (docId: string, fromPath: string, targetDir: string): void => {
      const toPath = joinDirPath(targetDir, baseNameOf(fromPath));
      // 拖到当前父文件夹：高亮已经表示「不改变」，松手不写盘
      if (toPath === fromPath) return;
      void (async () => {
        try {
          const refs = await countExplicitPathRefs(docId);
          const snapshot = await kernel.docs.read(unsafeDocId(docId));
          if (String(snapshot.meta.path) !== fromPath) {
            setNotice({ tone: 'error', text: '文档路径已变化，请刷新列表后重试' });
            return;
          }
          await kernel.docs.rename(unsafeDocId(docId), unsafeVaultPath(toPath), {
            base: snapshot.meta.rev,
            intent: 'user',
          });
          lastMoveRef.current = { docId, from: fromPath, to: toPath };
          invalidateDocs();
          const where = targetDir.length === 0 ? '库根' : `${targetDir}/`;
          const refNote = refs > 0 ? `；另有 ${refs} 处正文显式路径链接仍指向旧路径（未改写）` : '';
          setNotice({
            tone: 'ok',
            text: `已移动到 ${where}《${baseNameOf(fromPath)}》${refNote}`,
            action: { label: '撤销', run: undoLastMove },
          });
        } catch (cause) {
          invalidateDocs();
          if (isEmberError(cause) && cause.code === 'path_exists') {
            setNotice({ tone: 'error', text: '目标位置已有同名文件，未移动' });
          } else {
            setNotice({ tone: 'error', text: `移动失败：${toErrorText(cause)}` });
          }
        }
      })();
    },
    [countExplicitPathRefs, invalidateDocs, kernel, setNotice, undoLastMove],
  );

  const moveDirs = useMemo(() => {
    // 磁盘目录优先（空文件夹也能成为移动目标），文档路径反推用于兜底
    const paths = new Set<string>(dirs);
    for (const meta of documents) {
      const dir = parentDirOf(String(meta.path));
      if (dir.length > 0) paths.add(dir);
    }
    return [...paths].sort(compareNatural);
  }, [documents, dirs]);

  return { moveDirs, moveDoc, undoLastMove };
};
