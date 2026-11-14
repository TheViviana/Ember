import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { toErrorText } from '../../kernel/errors.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useFocusTrap } from '../use-focus-trap.ts';
import { useKernel } from '../kernel-provider.tsx';
import { readonlyText } from '../components/readonly-text.ts';
import { ReadingView } from './ReadingView.tsx';
import styles from './HistoryPanel.module.css';

export interface HistoryPanelProps {
  readonly docId: DocId;
  readonly onClose: () => void;
  /** 恢复前排空编辑器在途写入，确保磁盘与 base 一致 */
  readonly onBeforeRestore: () => Promise<void>;
}

interface Message {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly text: string;
}

const formatTime = (value: string): string => {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { hour12: false });
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

/**
 * 文档历史浮层：只读列出最近 20 版，点选预览、显式恢复。
 * 列表与预览都不写盘；恢复前先 flush 正文，再由内核按 base.hash 决定提交或落冲突副本。
 */
export const HistoryPanel = ({
  docId,
  onClose,
  onBeforeRestore,
}: HistoryPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const escLayerId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  const history = useQuery({
    queryKey: ['docs', 'history', String(docId)],
    queryFn: () => kernel.docs.listHistory(docId),
  });

  const preview = useQuery({
    queryKey: ['docs', 'history', String(docId), selected ?? ''],
    queryFn: () => {
      if (selected === null) throw new Error('未选择历史版本');
      return kernel.docs.readHistory(docId, selected);
    },
    enabled: selected !== null,
  });

  // Esc：只关面板；更晚挂载的浮层（设置/命令面板）持有栈顶时让位
  const layerId = `float-history${escLayerId}`;
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

  const select = useCallback((versionId: string): void => {
    setSelected(versionId);
    setConfirming(false);
    setMessage(null);
  }, []);

  const restore = useCallback((): void => {
    if (selected === null) return;
    setBusy(true);
    setMessage(null);
    void (async (): Promise<void> => {
      await onBeforeRestore();
      const snapshot = await kernel.docs.read(docId);
      const outcome = await kernel.docs.restoreHistory(docId, selected, {
        base: snapshot.meta.rev,
        intent: 'user',
      });
      await queryClient.invalidateQueries({ queryKey: ['docs', 'history', String(docId)] });
      void queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['index'] });
      setConfirming(false);
      if (outcome.conflict === null) {
        setMessage({ tone: 'ok', text: '已恢复该版本；恢复前的版本已存入历史，可再次恢复。' });
      } else {
        setMessage({
          tone: 'warn',
          text: `当前磁盘内容已变化，已保留磁盘版本并生成冲突副本：${String(outcome.conflict.path)}`,
        });
      }
    })()
      .catch((cause: unknown) => {
        setMessage({ tone: 'error', text: `恢复失败：${toErrorText(cause)}` });
        void queryClient.invalidateQueries({ queryKey: ['docs', 'history', String(docId)] });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [docId, kernel, onBeforeRestore, queryClient, selected]);

  const readonly = kernel.env.readonlyMode;
  const versions = history.data ?? [];
  const previewEntry = preview.data?.entry ?? null;
  const previewError = preview.error;

  return (
    <div ref={dialogRef} className={styles.overlay} role="dialog" aria-modal="true" aria-label="文档历史">
      <div className={styles.panel}>
        <header className={styles.head}>
          <span className={styles.title}>历史版本</span>
          <span className={styles.hint}>最多 20 版 · 64 MiB</span>
          <button
            type="button"
            className={styles.close}
            aria-label="关闭历史"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        {message === null ? null : (
          <p className={`${styles.notice} ${styles[`notice_${message.tone}`] ?? ''}`} role="status">
            {message.text}
          </p>
        )}

        <div className={styles.body}>
          <div className={styles.listPane}>
            {history.isPending ? <p className={styles.empty}>正在读取…</p> : null}
            {history.error === null || history.error === undefined ? null : (
              <p className={styles.empty}>读取历史失败：{toErrorText(history.error)}</p>
            )}
            {!history.isPending && history.error == null && versions.length === 0 ? (
              <p className={styles.empty}>还没有历史版本：内容变更后才生成。</p>
            ) : null}
            <ul className={styles.list}>
              {versions.map((entry, index) => (
                <li key={entry.versionId}>
                  <button
                    type="button"
                    className={`${styles.row} ${selected === entry.versionId ? styles.rowActive : ''}`}
                    onClick={() => {
                      select(entry.versionId);
                    }}
                  >
                    <span className={styles.rowTitle}>
                      {index === 0 ? '最新历史' : `第 ${versions.length - index} 版`}
                    </span>
                    <span className={styles.rowTime}>{formatTime(entry.at)}</span>
                    <span className={styles.rowMeta}>{formatSize(entry.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.previewPane}>
            {selected === null ? (
              <p className={styles.empty}>选择一版查看只读预览。</p>
            ) : preview.isPending ? (
              <p className={styles.empty}>正在读取预览…</p>
            ) : previewError === null || previewError === undefined ? null : (
              <p className={styles.empty}>无法预览：{toErrorText(previewError)}</p>
            )}
            {preview.data === undefined ? null : (
              <>
                <p className={styles.previewMeta}>
                  {formatTime(preview.data.entry.at)} · {formatSize(preview.data.entry.size)} ·{' '}
                  {String(preview.data.entry.path)}
                </p>
                <div className={styles.previewBody}>
                  <ReadingView markdown={preview.data.text} onWikiLink={() => undefined} />
                </div>
              </>
            )}
          </div>
        </div>

        <footer className={styles.foot}>
          {readonly ? <span className={styles.readonly}>{readonlyText(kernel.env.readonlyReason)}</span> : null}
          {confirming ? (
            <>
              <span className={styles.confirmText}>恢复会先把当前版本存入历史，是否继续？</span>
              <button
                type="button"
                className={styles.button}
                disabled={busy || readonly}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || readonly || previewEntry === null}
                onClick={restore}
              >
                {busy ? '恢复中…' : '确认恢复'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.button} disabled={busy} onClick={onClose}>
                关闭
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || readonly || previewEntry === null}
                title={readonly ? readonlyText(kernel.env.readonlyReason) : '当前版本会先存入历史，可再次恢复'}
                onClick={() => {
                  setConfirming(true);
                }}
              >
                恢复此版本
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
};
