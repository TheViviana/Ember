import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { splitFrontmatter, unsafeDocId } from '#doc-model';
import { isEmberError, toErrorText } from '../../kernel/errors.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import { planReplace, type ReplacePlanItem } from './global-replace.ts';
import styles from './GlobalReplacePanel.module.css';

export interface GlobalReplacePanelProps {
  readonly onClose: () => void;
}

interface OutcomeRow {
  readonly path: string;
  readonly count: number;
  readonly status: 'ok' | 'conflict' | 'error';
  readonly text: string;
}

type Notice = { readonly tone: 'ok' | 'warn' | 'error'; readonly text: string } | null;

/**
 * 跨文档查找替换：字面量匹配（可忽略大小写），只替换 frontmatter 之后的正文。
 * 打开中的浮窗会通过 doc:changed 自动重载；他人/浮窗先写入的文档按冲突跳过，绝不覆盖。
 */
export const GlobalReplacePanel = ({ onClose }: GlobalReplacePanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [plan, setPlan] = useState<readonly ReplacePlanItem[]>([]);
  const [scanning, setScanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<readonly OutcomeRow[]>([]);
  const [notice, setNotice] = useState<Notice>(null);

  useEscLayer('global-replace', true);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || running) return;
      if (!isEscTop('global-replace')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, running]);

  // 扫描：查询词去抖 300ms，拉全部文档正文做纯函数计划
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setPlan([]);
      setOutcomes([]);
      setScanning(false);
      return undefined;
    }
    setScanning(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const docs = await kernel.docs.list();
          const sources = await Promise.all(
            docs.map(async (doc) => {
              const snapshot = await kernel.docs.read(doc.id);
              return {
                id: String(doc.id),
                path: String(doc.path),
                title: doc.title,
                body: splitFrontmatter(snapshot.text).body,
              };
            }),
          );
          setPlan(planReplace(sources, trimmed, replacement, ignoreCase).items);
        } catch (error) {
          setNotice({ tone: 'error', text: `扫描失败：${toErrorText(error)}` });
          setPlan([]);
        } finally {
          setScanning(false);
        }
      })();
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [kernel, query, replacement, ignoreCase]);

  const totalOccurrences = useMemo(
    () => plan.reduce((sum, item) => sum + item.occurrences.length, 0),
    [plan],
  );

  const execute = (): void => {
    if (running || plan.length === 0) return;
    setRunning(true);
    setNotice(null);
    setOutcomes([]);
    void (async () => {
      const rows: OutcomeRow[] = [];
      let okCount = 0;
      for (const item of plan) {
        try {
          // 执行时重读：以最新 revision 为 base，正文变了就按最新正文重算，绝不盲写
          const snapshot = await kernel.docs.read(unsafeDocId(item.id));
          const body = splitFrontmatter(snapshot.text).body;
          const replanned = planReplace([{ id: item.id, path: item.path, title: item.title, body }], query, replacement, ignoreCase);
          const occurrences = replanned.items[0]?.occurrences ?? [];
          if (occurrences.length === 0) {
            rows.push({ path: item.path, count: 0, status: 'ok', text: '扫描后已无命中，跳过' });
            continue;
          }
          const nextBody = replanned.items[0]?.newBody ?? body;
          await kernel.docs.update(unsafeDocId(item.id), { body: nextBody }, { base: snapshot.meta.rev, intent: 'user' });
          okCount += 1;
          rows.push({ path: item.path, count: occurrences.length, status: 'ok', text: `替换 ${occurrences.length} 处` });
        } catch (error) {
          if (isEmberError(error) && error.code === 'stale_revision') {
            rows.push({ path: item.path, count: 0, status: 'conflict', text: '文档在扫描后被修改，文档在扫描后被修改，按冲突跳过（未覆盖）' });
          } else {
            rows.push({ path: item.path, count: 0, status: 'error', text: toErrorText(error) });
          }
        }
      }
      setOutcomes(rows);
      setRunning(false);
      setNotice({
        tone: okCount === plan.length ? 'ok' : 'warn',
        text: `完成：${okCount}/${plan.length} 篇替换成功；打开中的浮窗会自动重载`,
      });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
    })();
  };

  const disabled = kernel.env.readonlyMode;
  const queryEmpty = query.trim().length === 0;

  return (
    <div className={styles.scrim} role="presentation" onClick={disabled ? undefined : onClose}>
      <section
        className={styles.panel}
        role="dialog"
        aria-label="全局替换"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>全局替换</h2>
          <button type="button" className={styles.close} aria-label="关闭全局替换" onClick={onClose}>
            ×
          </button>
        </header>

        {disabled ? (
          <p className={styles.note}>{readonlyText(kernel.env.readonlyReason)}</p>
        ) : (
          <>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>查找</span>
                <input
                  className={styles.input}
                  value={query}
                  placeholder="要查找的文字…"
                  autoFocus
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                  }}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>替换为</span>
                <input
                  className={styles.input}
                  value={replacement}
                  placeholder="留空表示删除命中"
                  onChange={(event) => {
                    setReplacement(event.currentTarget.value);
                  }}
                />
              </label>
            </div>
            <label className={styles.caseRow}>
              <input
                type="checkbox"
                checked={ignoreCase}
                onChange={(event) => {
                  setIgnoreCase(event.currentTarget.checked);
                }}
              />
              <span>忽略大小写</span>
            </label>

            <p className={styles.summary} role="status">
              {scanning
                ? '正在扫描全部文档…'
                : queryEmpty
                  ? '输入要查找的文字后自动扫描全部文档。'
                  : `命中 ${plan.length} 篇文档、共 ${totalOccurrences} 处。只替换正文，frontmatter 与打开中的浮窗不受影响（浮窗会自动重载）。`}
            </p>

            {plan.length === 0 ? null : (
              <div className={styles.list}>
                {plan.map((item) => (
                  <div key={item.id} className={styles.item}>
                    <span className={styles.itemTitle} title={item.path}>
                      {item.title.length === 0 ? item.path : item.title}
                    </span>
                    <span className={styles.itemCount}>{item.occurrences.length} 处</span>
                    <span className={styles.itemSnippet}>
                      {item.occurrences[0]?.lineText ?? ''}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {notice === null ? null : (
              <p className={`${styles.notice} ${notice.tone === 'error' ? styles.noticeError : ''}`} role="status">
                {notice.text}
              </p>
            )}
            {outcomes.length === 0 ? null : (
              <div className={styles.list}>
                {outcomes.map((row) => (
                  <div key={row.path} className={styles.item}>
                    <span className={styles.itemTitle} title={row.path}>
                      {row.path}
                    </span>
                    <span
                      className={
                        row.status === 'ok'
                          ? styles.statusOk
                          : row.status === 'conflict'
                            ? styles.statusConflict
                            : styles.statusError
                      }
                    >
                      {row.text}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                disabled={running || scanning || queryEmpty || plan.length === 0}
                onClick={execute}
              >
                {running ? '替换中…' : `全部替换（${totalOccurrences} 处）`}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
};
