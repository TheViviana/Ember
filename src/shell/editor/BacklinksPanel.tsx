import { useMemo, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { useDocTexts } from '../docs/use-doc-texts.ts';
import { useFloatStore } from './float-store.ts';
import { collectBacklinks, countBacklinks } from './backlinks.ts';
import styles from './BacklinksPanel.module.css';

export interface BacklinksPanelProps {
  readonly docId: DocId;
}

/**
 * 反向链接面板（临时方案）。
 * 索引服务目前是 createPendingIndexPort 的占位实现，index-service 在
 * available=false 时直接拒绝，所以这里打开面板时扫描全库正文，用 doc-model
 * 的统一解析链（路径→文件名→标题→别名）现场算反向链接。
 * 索引接入后这里应换成 kernel.index.backlinks(docId)，并去掉「临时」标注。
 */
export const BacklinksPanel = ({ docId }: BacklinksPanelProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const texts = useDocTexts(open);
  const groups = useMemo(
    () => collectBacklinks(texts.data ?? [], docId),
    [texts.data, docId],
  );
  const total = countBacklinks(groups);

  return (
    <div className={styles.dock}>
      {open ? (
        <section className={styles.panel} aria-label="反向链接">
          <header className={styles.head}>
            <span className={styles.title}>反向链接</span>
            <span className={styles.temporary}>临时</span>
            <button
              type="button"
              className={styles.close}
              aria-label="关闭反向链接"
              onClick={() => {
                setOpen(false);
              }}
            >
              ×
            </button>
          </header>
          <p className={styles.hint}>
            临时方案：打开时扫描全库正文；索引服务尚未接入，接入后改为索引查询。
          </p>

          <div className={styles.body}>
            {texts.isPending ? <p className={styles.empty}>正在扫描全库…</p> : null}
            {texts.error !== null ? <p className={styles.empty}>扫描失败，请稍后重试。</p> : null}
            {!texts.isPending && texts.error === null && groups.length === 0 ? (
              <p className={styles.empty}>还没有文档引用这篇。</p>
            ) : null}
            {groups.length > 0 ? (
              <ul className={styles.list}>
                {groups.map((group) => (
                  <li className={styles.group} key={String(group.docId)}>
                    <button
                      type="button"
                      className={styles.groupTitle}
                      title={String(group.path)}
                      onClick={() => {
                        useFloatStore.getState().open(group.docId, null);
                      }}
                    >
                      {group.title}
                    </button>
                    <ul className={styles.hits}>
                      {group.hits.map((hit) => (
                        <li key={`${String(hit.docId)}-${String(hit.line)}-${hit.raw}`}>
                          <button
                            type="button"
                            className={styles.hit}
                            title={`第 ${String(hit.line)} 行`}
                            onClick={() => {
                              useFloatStore.getState().open(group.docId, null);
                            }}
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
          </div>
        </section>
      ) : null}

      <button
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        title="查看引用这篇文档的其他文档"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        反链{open && !texts.isPending && texts.error === null ? ` ${String(total)}` : ''}
      </button>
    </div>
  );
};
