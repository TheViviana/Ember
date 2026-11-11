import { useQuery } from '@tanstack/react-query';
import type { DocId, VaultPath } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';

/** 全库文档正文快照：图库引用关系与反向链接临时扫描共用同一份查询 */
export interface DocText {
  readonly id: DocId;
  readonly title: string;
  readonly path: VaultPath;
  readonly aliases: readonly string[];
  readonly text: string;
}

export const DOC_TEXTS_KEY = ['docs', 'texts'] as const;

/** 全库扫描的缓存期：面板反复开合、Backlinks 展开都命中缓存，不重复逐篇 IPC */
const DOC_TEXTS_STALE_TIME_MS = 30_000;
/** 并发分批：全量 Promise.all 会一次性发起几十个 IPC，按小批推进 */
const READ_BATCH_SIZE = 8;

/** 逐批读完全库正文，单篇失败跳过 */
const readAllBodies = async (
  read: (id: DocId) => Promise<{ text: string }>,
  metas: readonly { id: DocId; title: string; path: VaultPath; aliases: readonly string[] }[],
): Promise<readonly DocText[]> => {
  const out: DocText[] = [];
  for (let start = 0; start < metas.length; start += READ_BATCH_SIZE) {
    const batch = metas.slice(start, start + READ_BATCH_SIZE);
    const scanned = await Promise.all(
      batch.map(async (meta): Promise<DocText | null> => {
        try {
          const snapshot = await read(meta.id);
          return {
            id: meta.id,
            title: meta.title,
            path: meta.path,
            aliases: meta.aliases,
            text: snapshot.text,
          };
        } catch {
          return null;
        }
      }),
    );
    for (const doc of scanned) {
      if (doc !== null) out.push(doc);
    }
  }
  return out;
};

/**
 * 读取全库正文：先 list 元数据，再逐篇 read。
 * 单篇读取失败（对账后被外部删除等）直接跳过，不影响其余文档。
 */
export const useDocTexts = (enabled: boolean) => {
  const kernel = useKernel();
  return useQuery({
    queryKey: DOC_TEXTS_KEY,
    enabled,
    staleTime: DOC_TEXTS_STALE_TIME_MS,
    queryFn: async (): Promise<readonly DocText[]> => {
      const metas = await kernel.docs.list();
      return readAllBodies(async (id) => await kernel.docs.read(id), metas);
    },
  });
};
