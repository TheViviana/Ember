import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { toErrorText } from '../../kernel/errors.ts';
import type { DocMeta } from '../../kernel/types.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { flushFloatEditors } from '../editor/float-flush.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useFocusTrap } from '../use-focus-trap.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './ConflictPanel.module.css';

export interface ConflictPanelProps {
  readonly documents: readonly DocMeta[];
  /** 打开原文 + 副本两扇浮窗；面板随即关闭 */
  readonly onOpenSideBySide: (originalId: DocId, copyId: DocId) => void;
  readonly onClose: () => void;
}

interface ConflictGroup {
  readonly original: DocMeta | null;
  readonly copies: readonly DocMeta[];
}

interface Message {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly text: string;
}

type ActionKind = 'adopt' | 'remove' | 'detach';

interface ConfirmState {
  readonly kind: ActionKind;
  readonly copyId: DocId;
}

const byPath = (left: DocMeta, right: DocMeta): number =>
  String(left.path).localeCompare(String(right.path));

/**
 * 按 ember.conflictOf 分组：原文缺失时 original 为 null（孤儿冲突）。
 * 不自动合并、不自动清理，所有解决动作都由用户显式触发。
 */
export const groupConflicts = (documents: readonly DocMeta[]): readonly ConflictGroup[] => {
  const byId = new Map<string, DocMeta>(documents.map((meta) => [String(meta.id), meta]));
  const copies = new Map<string, DocMeta[]>();
  for (const meta of documents) {
    if (meta.conflictOf === null) continue;
    const key = String(meta.conflictOf);
    const list = copies.get(key) ?? [];
    list.push(meta);
    copies.set(key, list);
  }
  return [...copies.entries()]
    .map(([key, list]) => ({
      original: byId.get(key) ?? null,
      copies: [...list].sort(byPath),
    }))
    .sort((left, right) => {
      if (left.original === null || right.original === null) {
        return left.original === null ? 1 : -1;
      }
      return byPath(left.original, right.original);
    });
};

const confirmText = (kind: ActionKind): string => {
  if (kind === 'adopt') return '采用后副本正文与标题/简介/标签/别名写回原文，副本将移入回收站。';
  if (kind === 'remove') return '副本将移入系统回收站，此操作不会改动原文。';
  return '清除冲突标记后，该副本会作为普通文档保留在原路径。';
};

const buttonLabel = (kind: ActionKind): string => {
  if (kind === 'adopt') return '确认采用';
  if (kind === 'remove') return '确认删除';
  return '确认另存';
};

/**
 * 冲突处理中心：按原文分组展示冲突副本，支持并排查看、采用、另存与删除。
 * 写操作前先 flush 编辑器，再重新读取最新修订，避免用旧 base 解决。
 */
export const ConflictPanel = ({
  documents,
  onOpenSideBySide,
  onClose,
}: ConflictPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const escLayerId = useId();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const groups = useMemo(() => groupConflicts(documents), [documents]);
  const readonly = kernel.env.readonlyMode;

  const layerId = `conflict-center${escLayerId}`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEscLayer(layerId, true);
  useFocusTrap(dialogRef);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop(layerId)) return;
      event.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, layerId, onClose]);

  const execute = useCallback(
    (kind: ActionKind, copyId: DocId): void => {
      setConfirm(null);
      setBusy(true);
      setMessage(null);
      void (async (): Promise<void> => {
        await flushFloatEditors();
        const copy = await kernel.docs.read(copyId);
        if (kind === 'adopt') {
          const originalId = copy.meta.conflictOf;
          if (originalId === null) throw new Error('原文已不存在，只能另存或删除副本');
          const original = await kernel.docs.read(originalId);
          const outcome = await kernel.docs.adoptCopy(copyId, {
            base: original.meta.rev,
            copyBase: copy.meta.rev,
            intent: 'user',
          });
          setMessage(
            outcome.copyRemoved
              ? { tone: 'ok', text: '已采用副本内容；原文 id 与历史保留，副本已移入回收站。' }
              : {
                  tone: 'warn',
                  text: '原文已更新，但副本删除失败，请手动删除该副本。',
                },
          );
          return;
        }
        if (kind === 'remove') {
          await kernel.docs.remove(copyId, { base: copy.meta.rev, intent: 'user' });
          setMessage({ tone: 'ok', text: '副本已移入系统回收站。' });
          return;
        }
        await kernel.docs.detachCopy(copyId, { base: copy.meta.rev, intent: 'user' });
        setMessage({ tone: 'ok', text: '副本已另存为普通文档，冲突标记已清除。' });
      })()
        .catch((cause: unknown) => {
          setMessage({ tone: 'error', text: `操作失败：${toErrorText(cause)}` });
        })
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
          void queryClient.invalidateQueries({ queryKey: ['index'] });
          setBusy(false);
        });
    },
    [kernel, queryClient],
  );

  return (
    <div ref={dialogRef} className={styles.root} role="dialog" aria-modal="true" aria-label="冲突处理中心">
      <header className={styles.header}>
        <span className={styles.headerIcon}>⚠</span>
        <span className={styles.headerTitle}>冲突处理</span>
        <span className={styles.headerCount}>{groups.length}</span>
        <button type="button" className={styles.close} aria-label="关闭冲突处理" disabled={busy} onClick={onClose}>
          ✕
        </button>
      </header>

      {message === null ? null : (
        <p className={`${styles.notice} ${styles[`notice_${message.tone}`] ?? ''}`} role="status">
          {message.text}
        </p>
      )}

      <div className={styles.body}>
        {groups.length === 0 ? <p className={styles.empty}>当前没有待处理的冲突。</p> : null}
        {groups.map((group) => {
          const orphan = group.original === null;
          const originalId = orphan ? null : group.original?.id ?? null;
          const key = String(group.copies[0]?.conflictOf ?? 'orphan');
          return (
            <section key={key} className={styles.group}>
              <header className={styles.groupHead}>
                <span className={styles.groupTitle}>
                  {orphan ? '原文已删除' : `${group.original?.title ?? '未命名'}（原文）`}
                </span>
                {orphan ? (
                  <span className={styles.orphanTag}>孤儿冲突</span>
                ) : (
                  <span className={styles.groupPath}>{String(group.original?.path)}</span>
                )}
              </header>

              <ul className={styles.copies}>
                {group.copies.map((copy) => {
                  const copyId = copy.id;
                  const confirming = confirm !== null && String(confirm.copyId) === String(copyId);
                  return (
                    <li key={String(copyId)} className={styles.copy}>
                      <div className={styles.copyInfo}>
                        <span className={styles.copyTitle}>{copy.title}</span>
                        <span className={styles.copyPath}>{String(copy.path)}</span>
                        <span className={styles.copyMeta}>更新于 {copy.updated || '未知时间'}</span>
                      </div>

                      {confirming ? (
                        <div className={styles.confirmRow}>
                          <span className={styles.confirmText}>{confirmText(confirm.kind)}</span>
                          <button
                            type="button"
                            className={styles.button}
                            disabled={busy}
                            onClick={() => {
                              setConfirm(null);
                            }}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className={styles.primary}
                            disabled={busy}
                            onClick={() => {
                              execute(confirm.kind, copyId);
                            }}
                          >
                            {busy ? '处理中…' : buttonLabel(confirm.kind)}
                          </button>
                        </div>
                      ) : (
                        <div className={styles.actions}>
                          {originalId === null ? null : (
                            <button
                              type="button"
                              className={styles.button}
                              disabled={busy}
                              title="打开原文与副本两扇浮窗，手动合并"
                              onClick={() => {
                                onOpenSideBySide(originalId, copyId);
                              }}
                            >
                              并排查看
                            </button>
                          )}
                          {orphan ? null : (
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={busy || readonly}
                              title={readonly ? readonlyText(kernel.env.readonlyReason) : '正文写回原文后删除副本'}
                              onClick={() => {
                                setConfirm({ kind: 'adopt', copyId });
                              }}
                            >
                              采用此副本
                            </button>
                          )}
                          {orphan ? (
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={busy || readonly}
                              title={readonly ? readonlyText(kernel.env.readonlyReason) : '清除冲突标记，保留为普通文档'}
                              onClick={() => {
                                setConfirm({ kind: 'detach', copyId });
                              }}
                            >
                              另存为普通文档
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className={styles.danger}
                            disabled={busy || readonly}
                            title={readonly ? readonlyText(kernel.env.readonlyReason) : '移入系统回收站'}
                            onClick={() => {
                              setConfirm({ kind: 'remove', copyId });
                            }}
                          >
                            删除副本
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <footer className={styles.footer}>
        {readonly ? <span className={styles.readonly}>{readonlyText(kernel.env.readonlyReason)}</span> : null}
        <button type="button" className={styles.button} disabled={busy} onClick={onClose}>
          关闭
        </button>
      </footer>
    </div>
  );
};
