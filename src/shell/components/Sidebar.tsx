import { useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import type { CapabilityState, CommandDescriptor, DocMeta } from '../../kernel/types.ts';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  readonly capabilities: readonly CapabilityState[];
  readonly commands: readonly CommandDescriptor[];
  readonly documents: readonly DocMeta[];
  readonly documentsLoading: boolean;
  readonly documentsError: string | null;
  readonly activeDocId: DocId | null;
  readonly onSelectDoc: (id: DocId) => void;
}

type SectionKey = 'capabilities' | 'commands' | 'documents';

const capabilityLabel = (state: CapabilityState): ReactElement => {
  if (state.error !== null) return <span className={styles.itemNote}>{state.error}</span>;
  if (state.active) return <span className={`${styles.badge} ${styles.badgeOn}`}>运行中</span>;
  return <span className={`${styles.badge} ${styles.badgeOff}`}>已停用</span>;
};

const Chevron = ({ collapsed }: { readonly collapsed: boolean }): ReactElement => (
  <span className={styles.chevron} data-collapsed={collapsed ? 'true' : 'false'} aria-hidden="true">
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path
        d="M3 2.5 6 5 3 7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);

/**
 * 资源管理器内容：三个分组都可竖向折叠，默认全部展开。
 * 高度由内容决定，超高时只让分组列表内部滚动，底部统计行始终可见。
 */
export const Sidebar = ({
  capabilities,
  commands,
  documents,
  documentsLoading,
  documentsError,
  activeDocId,
  onSelectDoc,
}: SidebarProps): ReactElement => {
  const activeCount = capabilities.filter((state) => state.active).length;
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(() => new Set());

  const toggle = (key: SectionKey): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>☰</span>
        <span className={styles.headerLabel}>资源管理器</span>
      </div>

      <nav className={styles.nav}>
        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsed.has('capabilities')}
            onClick={() => {
              toggle('capabilities');
            }}
          >
            <span className={styles.sectionIcon}>◎</span>
            <span className={styles.sectionTitle}>能力</span>
            <span className={styles.badge}>
              {activeCount}/{capabilities.length}
            </span>
            <Chevron collapsed={collapsed.has('capabilities')} />
          </button>
          {collapsed.has('capabilities') ? null : (
            <ul className={styles.items}>
              {capabilities.map((state) => (
                <li key={String(state.id)} className={styles.staticItemRow}>
                  <span className={styles.itemLabel} title={String(state.id)}>
                    {state.displayName}
                  </span>
                  {capabilityLabel(state)}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsed.has('commands')}
            onClick={() => {
              toggle('commands');
            }}
          >
            <span className={styles.sectionIcon}>⌘</span>
            <span className={styles.sectionTitle}>命令</span>
            <span className={styles.badge}>{commands.length}</span>
            <Chevron collapsed={collapsed.has('commands')} />
          </button>
          {collapsed.has('commands') ? null : (
            <ul className={styles.items}>
              {commands.map((descriptor) => (
                <li key={String(descriptor.id)} className={styles.staticItem}>
                  <span className={styles.itemLabel}>{descriptor.title}</span>
                  <span className={styles.itemNote}>{String(descriptor.id)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsed.has('documents')}
            onClick={() => {
              toggle('documents');
            }}
          >
            <span className={styles.sectionIcon}>◇</span>
            <span className={styles.sectionTitle}>文档</span>
            <span className={styles.badge}>{documents.length}</span>
            <Chevron collapsed={collapsed.has('documents')} />
          </button>
          {collapsed.has('documents') ? null : (
            <>
              {documentsLoading ? <p className={styles.sectionNote}>加载中…</p> : null}
              {documentsError === null ? null : <p className={styles.sectionError}>{documentsError}</p>}
              {!documentsLoading && documentsError === null && documents.length === 0 ? (
                <p className={styles.sectionNote}>库内还没有带合法 id 的文档</p>
              ) : null}
              <ul className={styles.items}>
                {documents.map((meta) => (
                  <li key={String(meta.id)}>
                    <button
                      type="button"
                      className={`${styles.item} ${activeDocId === meta.id ? styles.itemActive : ''}`}
                      onClick={() => {
                        onSelectDoc(meta.id);
                      }}
                    >
                      <span className={styles.itemLabel}>{meta.title}</span>
                      <span className={styles.itemNote}>{String(meta.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </nav>

      <div className={styles.footer}>
        <span className={styles.footerIcon}>◆</span>
        <span className={styles.footerText}>
          {documents.length} 篇文档 · {activeCount} 个能力在运行
        </span>
      </div>
    </aside>
  );
};
