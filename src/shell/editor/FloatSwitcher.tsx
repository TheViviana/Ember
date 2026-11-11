import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { FLOAT_LIMIT, deriveStackOrder, useFloatStore } from './float-store.ts';
import { subscribeFloatSwitcher } from './float-switcher-signal.ts';
import styles from './FloatLayer.module.css';

/**
 * 浮窗胶囊：已打开浮窗的数量与切换列表。
 * 它是左下角横排的最后一格，由 ToolRail 的 flex 顺序定位 —— 这样前排放几个
 * 工具入口都不会把它顶到窗口右缘，也不会再需要按侧栏开合做横向让位。
 */
export const FloatSwitcher = (): ReactElement | null => {
  const kernel = useKernel();
  const windows = useFloatStore((state) => state.windows);
  const activeId = useFloatStore((state) => state.activeId);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => subscribeFloatSwitcher(() => setListOpen(true)), []);

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const doc of documents.data ?? []) {
      map.set(String(doc.id), doc.title);
    }
    return map;
  }, [documents.data]);

  if (windows.length === 0) return null;

  const titleOf = (docId: DocId): string => {
    const title = titleById.get(String(docId));
    return title === undefined || title.trim().length === 0 ? '未命名文档' : title;
  };

  const stack = deriveStackOrder(windows);

  return (
    <div className={styles.switcher}>
      <button
        type="button"
        className={styles.chip}
        aria-expanded={listOpen}
        aria-label={`浮窗 ${windows.length}/${FLOAT_LIMIT}，查看已打开`}
        onClick={() => {
          setListOpen((open) => !open);
        }}
      >
        浮窗 {windows.length}/{FLOAT_LIMIT}
      </button>
      {listOpen ? (
        <div className={styles.list} role="menu" aria-label="已打开的浮窗">
          {[...stack].reverse().map(({ docId }) => {
            const current = activeId !== null && String(activeId) === String(docId);
            return (
              <div key={String(docId)} className={styles.row} data-current={current}>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.rowTitle}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => {
                    useFloatStore.getState().activate(docId);
                    setListOpen(false);
                  }}
                >
                  {titleOf(docId)}
                </button>
                <button
                  type="button"
                  className={styles.rowClose}
                  aria-label={`关闭 ${titleOf(docId)}`}
                  onClick={() => {
                    useFloatStore.getState().close(docId);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
