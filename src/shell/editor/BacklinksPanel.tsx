import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { toErrorText } from '../../kernel/errors.ts';
import type { LinkRecord, UnlinkedMention } from '../../kernel/types.ts';
import { useKernel } from '../kernel-provider.tsx';
import { useFloatStore } from './float-store.ts';
import { acceptUnlinkedMention } from './use-unlinked-apply.ts';
import styles from './BacklinksPanel.module.css';

export interface BacklinksPanelProps {
  readonly docId: DocId;
}

type PanelTab = 'backlinks' | 'unlinked';

interface GroupedHits<T> {
  readonly docId: DocId;
  readonly title: string;
  readonly hits: readonly T[];
}

/**
 * 反链面板：两个 tab
 * - 反向链接：内核索引直接拿到的 [[双链]] / embed（按来源分组）
 * - 未链接提及：按需扫描（IndexService.unlinkedMentions），逐条可接受为 [[title]]
 */
export const BacklinksPanel = ({ docId }: BacklinksPanelProps): ReactElement => {
  const kernel = useKernel();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('backlinks');
  const ignoringRef = useRef(new Set<string>());
  const [ignoreTick, setIgnoreTick] = useState(0);

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const meta of documents.data ?? []) map.set(String(meta.id), meta.title);
    return map;
  }, [documents.data]);

  const backlinkRecords = useQuery({
    queryKey: ['index', 'backlinks', String(docId), documents.data?.length ?? 0],
    queryFn: () => kernel.index.backlinks(docId),
    enabled: open && tab === 'backlinks',
  });
  const unlinkedRecords = useQuery({
    queryKey: ['index', 'unlinked', String(docId), documents.data?.length ?? 0, ignoreTick],
    queryFn: () => kernel.index.unlinkedMentions(docId),
    enabled: open && tab === 'unlinked',
    staleTime: 0,
  });

  // ---- 反向链接分组 ----
  const backlinkGroups = useMemo<readonly GroupedHits<LinkRecord>[]>(() => {
    const bySource = new Map<string, LinkRecord[]>();
    for (const record of backlinkRecords.data ?? []) {
      const key = String(record.srcId);
      const list = bySource.get(key);
      if (list === undefined) bySource.set(key, [record]);
      else list.push(record);
    }
    const grouped: GroupedHits<LinkRecord>[] = [];
    for (const [key, hits] of bySource) {
      grouped.push({
        docId: key as DocId,
        title: titleById.get(key) ?? '未命名',
        hits: [...hits].sort((left, right) => left.line - right.line),
      });
    }
    return grouped.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));
  }, [backlinkRecords.data, titleById]);

  // ---- 未链接提及分组（过滤掉会话内忽略项） ----
  const unlinkedGroups = useMemo<readonly GroupedHits<UnlinkedMention>[]>(() => {
    void ignoreTick; // 依赖 ignoreTick 让忽略后触发重算
    const bySource = new Map<string, UnlinkedMention[]>();
    for (const m of unlinkedRecords.data ?? []) {
      const key = String(m.srcId);
      const list = bySource.get(key);
      if (list === undefined) bySource.set(key, [m]);
      else list.push(m);
    }
    const grouped: GroupedHits<UnlinkedMention>[] = [];
    for (const [key, hits] of bySource) {
      const filtered = hits.filter((m) => !ignoringRef.current.has(`${m.srcId}:${m.from}:${m.match}`));
      grouped.push({
        docId: key as DocId,
        title: titleById.get(key) ?? '未命名',
        hits: filtered,
      });
    }
    return grouped
      .filter((g) => g.hits.length > 0)
      .sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));
  }, [unlinkedRecords.data, titleById, ignoreTick]);

  const [notice, setNotice] = useState<string | null>(null);

  const acceptOne = useCallback(
    async (mention: UnlinkedMention) => {
      setNotice(null);
      const result = await acceptUnlinkedMention({ docs: kernel.docs, mention });
      if (result.ok) {
        void unlinkedRecords.refetch();
        void backlinkRecords.refetch();
      } else {
        setNotice(
          result.reason === 'stale'
            ? '该位置内容已变更，请重新扫描。'
            : result.detail,
        );
        if (result.reason === 'stale') void unlinkedRecords.refetch();
      }
    },
    [kernel, unlinkedRecords, backlinkRecords],
  );

  const ignoreOne = useCallback((mention: UnlinkedMention) => {
    ignoringRef.current.add(`${mention.srcId}:${mention.from}:${mention.match}`);
    setIgnoreTick((n) => n + 1);
  }, []);

  const total =
    tab === 'backlinks'
      ? backlinkGroups.reduce((sum, group) => sum + group.hits.length, 0)
      : unlinkedGroups.reduce((sum, group) => sum + group.hits.length, 0);

  const loading = tab === 'backlinks' ? backlinkRecords.isPending : unlinkedRecords.isPending;
  const error = (tab === 'backlinks' ? backlinkRecords.isError : unlinkedRecords.isError)
    ? toErrorText(tab === 'backlinks' ? backlinkRecords.error : unlinkedRecords.error)
    : null;

  return (
    <div className={styles.dock}>
      {open ? (
        <section className={styles.panel} aria-label="引用与提及">
          <header className={styles.head}>
            <div className={styles.tabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'backlinks'}
                className={styles.tab}
                onClick={() => setTab('backlinks')}
              >
                反链
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'unlinked'}
                className={styles.tab}
                onClick={() => setTab('unlinked')}
              >
                未链接
                {unlinkedRecords.data && unlinkedRecords.data.length > 0 ? (
                  <span className={styles.badge}>{unlinkedRecords.data.length}</span>
                ) : null}
              </button>
            </div>
            <button
              type="button"
              className={styles.close}
              aria-label="关闭"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <p className={styles.hint}>
            {tab === 'backlinks'
              ? '索引内 [[双链]] / embed 引用。'
              : '扫描其它文档正文对本标题/别名的纯文本提及。'}
          </p>

          {notice !== null ? <p className={styles.notice}>{notice}</p> : null}

          <div className={styles.body}>
            {loading ? <p className={styles.empty}>正在读取…</p> : null}
            {error !== null ? <p className={styles.empty}>{error}</p> : null}

            {tab === 'backlinks' && !loading && error === null && backlinkGroups.length === 0 ? (
              <p className={styles.empty}>还没有文档用 [[双链]] 引用这篇。</p>
            ) : null}
            {tab === 'backlinks' && backlinkGroups.length > 0 ? (
              <ul className={styles.list}>
                {backlinkGroups.map((group) => (
                  <li className={styles.group} key={String(group.docId)}>
                    <button
                      type="button"
                      className={styles.groupTitle}
                      onClick={() => useFloatStore.getState().open(group.docId, null)}
                    >
                      {group.title}
                    </button>
                    <ul className={styles.hits}>
                      {group.hits.map((hit) => (
                        <li key={`${String(hit.srcId)}-${String(hit.line)}-${hit.raw}`}>
                          <button
                            type="button"
                            className={styles.hit}
                            title={`第 ${String(hit.line)} 行`}
                            onClick={() => useFloatStore.getState().open(hit.srcId, null)}
                          >
                            <span className={styles.line}>{hit.line}</span>
                            <span className={styles.raw}>{hit.raw}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : null}

            {tab === 'unlinked' && !loading && error === null && unlinkedGroups.length === 0 ? (
              <p className={styles.empty}>
                {unlinkedRecords.data && unlinkedRecords.data.length === 0
                  ? '未发现未链接提及。'
                  : '所有提及都已忽略。关闭再打开面板可重扫。'}
              </p>
            ) : null}
            {tab === 'unlinked' && unlinkedGroups.length > 0 ? (
              <ul className={styles.list}>
                {unlinkedGroups.map((group) => (
                  <li className={styles.group} key={String(group.docId)}>
                    <button
                      type="button"
                      className={styles.groupTitle}
                      onClick={() => useFloatStore.getState().open(group.docId, null)}
                    >
                      {group.title}
                    </button>
                    <ul className={styles.hits}>
                      {group.hits.map((m) => (
                        <li
                          key={`${String(m.srcId)}-${String(m.from)}-${m.match}`}
                          className={styles.unlinkedItem}
                        >
                          <button
                            type="button"
                            className={styles.hit}
                            title={`第 ${String(m.line)} 行`}
                            onClick={() => useFloatStore.getState().open(m.srcId, null)}
                          >
                            <span className={styles.line}>{m.line}</span>
                            <span className={styles.snippet}>{m.snippet}</span>
                          </button>
                          <div className={styles.actions}>
                            <button
                              type="button"
                              className={styles.acceptBtn}
                              onClick={() => void acceptOne(m)}
                              title={`把 "${m.match}" 替换为 [[${m.title}]]`}
                            >
                              接受
                            </button>
                            <button
                              type="button"
                              className={styles.ignoreBtn}
                              onClick={() => ignoreOne(m)}
                            >
                              忽略
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        title="查看引用 / 提及"
        onClick={() => setOpen((current) => !current)}
      >
        反链{open && !loading && error === null ? ` ${String(total)}` : ''}
      </button>
    </div>
  );
};
