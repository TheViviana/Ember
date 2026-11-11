import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import { useKernel } from '../kernel-provider.tsx';
import { useFloatStore } from '../editor/float-store.ts';
import { recallDayKey, resolveRecall, type RecallCandidate } from './daily-recall.ts';
import styles from './ToolEntry.module.css';

const RecallIcon = (): ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <path d="M2.2 2.6v3h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 5.2V8l1.9 1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export interface RecallEntryProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
}

/**
 * 今日回顾入口：每天固定三条，抽中的 id 落机器本地 ui.json。
 * 只提供按钮与浮层锚点；排在左下角哪一格由 ToolRail 的 flex 顺序决定。
 */
export const RecallEntry = ({ open, onToggle, onClose }: RecallEntryProps): ReactElement => {
  const kernel = useKernel();
  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const recall = useMachineStore((state) => state.recall);

  const day = recallDayKey(new Date());
  const pool = useMemo<readonly RecallCandidate[]>(
    () =>
      (documents.data ?? []).map((doc) => ({
        id: String(doc.id),
        title: doc.title,
        summary: doc.summary,
        path: String(doc.path),
      })),
    [documents.data],
  );
  const resolution = useMemo(() => resolveRecall(pool, day, recall), [pool, day, recall]);

  // 首次进入 / 跨天时把当天抽中的 id 落到机器本地；同一天内不再改写
  useEffect(() => {
    const cache = resolution.cache;
    if (
      recall !== null &&
      recall.day === cache.day &&
      recall.ids.join('\u0000') === cache.ids.join('\u0000')
    ) {
      return;
    }
    useMachineStore.getState().rememberRecall(cache);
  }, [resolution.cache, recall]);

  const picks = resolution.picks;

  return (
    <div className={styles.slot}>
      <button
        type="button"
        className={styles.entry}
        aria-expanded={open}
        aria-label={`今日回顾 ${picks.length} 篇`}
        title="每天固定回顾几篇库内文档"
        onClick={onToggle}
      >
        <RecallIcon />
        <span>今日回顾</span>
        <span className={styles.badge}>{picks.length}</span>
      </button>

      {open ? (
        <section className={styles.panel} role="dialog" aria-label="今日回顾">
          <header className={styles.head}>
            <h2 className={styles.title}>今日回顾</h2>
            <button type="button" className={styles.close} aria-label="关闭今日回顾" onClick={onClose}>
              ×
            </button>
          </header>
          <p className={styles.note}>每天固定三条，同一天内不变；点条目打开原文。</p>
          {picks.length === 0 ? (
            <p className={styles.empty}>库内还没有文档，先在画布上新建或导入一篇。</p>
          ) : (
            <ul className={styles.list}>
              {picks.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.item}
                    onClick={() => {
                      onClose();
                      useFloatStore.getState().open(item.id as DocId, null);
                    }}
                  >
                    <span className={styles.itemTitle}>
                      {item.title.trim().length === 0 ? '未命名' : item.title}
                    </span>
                    <span className={styles.itemSummary}>
                      {item.summary.trim().length === 0 ? '（暂无摘要）' : item.summary}
                    </span>
                    <span className={styles.itemPath}>{item.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
};
