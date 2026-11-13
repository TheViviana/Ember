import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactElement } from 'react';
import type { DocMeta } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import { useFloatStore } from '../editor/float-store.ts';
import { requestCanvasView } from './canvas-view-signal.ts';
import styles from './CanvasToolbar.module.css';

export interface RecentEditsLayerProps {
  readonly canvasId: string;
  readonly onClose: () => void;
}

const RECENT_LIMIT = 8;

/**
 * 最近编辑层（画布开关）：替代「今日回顾」。
 * 列出全库最近更新的文档（updated 倒序，前 8 篇）；
 * 点击打开浮窗；在当前画布上的条目可直接飞到节点。
 */
export const RecentEditsLayer = ({
  canvasId,
  onClose,
}: RecentEditsLayerProps): ReactElement => {
  const kernel = useKernel();
  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const canvas = useQuery({
    queryKey: ['canvas', 'locate-many', canvasId, documents.data?.length ?? 0],
    queryFn: async () => {
      // 最近编辑层的画布内定位：一次读当前画布的场景即可
      const session = await kernel.canvas.open(canvasId as never);
      const nodes = session.scene.nodes
        .filter((node) => node.kind === 'doc' && node.docId !== null)
        .map((node) => ({ docId: String(node.docId), nodeId: node.id }));
      session.close();
      return nodes;
    },
    staleTime: 5_000,
  });

  const recent = useMemo<readonly DocMeta[]>(() => {
    const all = [...(documents.data ?? [])];
    all.sort((left, right) => (right.updated || '').localeCompare(left.updated || ''));
    return all.slice(0, RECENT_LIMIT);
  }, [documents.data]);

  const nodeIdByDoc = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of canvas.data ?? []) map.set(entry.docId, entry.nodeId);
    return map;
  }, [canvas.data]);

  const openDoc = (docId: string, nodeId: string | undefined): void => {
    useFloatStore.getState().open(docId as never, null);
    if (nodeId !== undefined) {
      requestCanvasView({ highlightNodeId: nodeId });
    }
    onClose();
  };

  return (
    <div className={styles.filterPopover} data-canvas-overlay="recent-edits" role="menu" aria-label="最近编辑">
      <p className={styles.fieldLabel}>最近编辑</p>
      {recent.length === 0 ? (
        <p className={styles.fieldEmpty}>库里还没有文档</p>
      ) : (
        <ul className={styles.recentList}>
          {recent.map((meta) => {
            const nodeId = nodeIdByDoc.get(String(meta.id));
            return (
              <li key={String(meta.id)}>
                <button
                  type="button"
                  className={styles.recentRow}
                  onClick={() => {
                    openDoc(String(meta.id), nodeId);
                  }}
                  title={nodeId === undefined ? '打开浮窗' : '打开浮窗 · 在本画布上时飞到节点'}
                >
                  <span className={styles.recentTitle}>{meta.title}</span>
                  <span className={styles.recentMeta}>
                    {nodeId === undefined ? '' : '本画布 · '}
                    {(meta.updated || '').slice(0, 16).replace('T', ' ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
