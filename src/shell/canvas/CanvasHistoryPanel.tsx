import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { CanvasScene } from '#canvas-engine';
import type { CanvasId } from '#doc-model';
import type { CanvasHistoryEntry } from '../../kernel/canvas-host.ts';
import { isEscTop } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './CanvasToolbar.module.css';

export interface CanvasHistoryPanelProps {
  readonly canvasId: CanvasId;
  readonly onClose: () => void;
  /** 恢复成功：外壳把视口同步到恢复后的场景 */
  readonly onRestored: (scene: CanvasScene) => void;
  readonly onError: (message: string) => void;
}

const formatTime = (value: string): string => {
  if (value.length === 0) return '时间未知';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { hour12: false });
};

/**
 * 画布历史浮层：只读列出最多 5 版，点选预览、显式恢复。
 * 预览与列表都不写盘；恢复带 hash 预检，版本过期由内核抛 stale_revision。
 */
export const CanvasHistoryPanel = ({
  canvasId,
  onClose,
  onRestored,
  onError,
}: CanvasHistoryPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<{ entry: CanvasHistoryEntry; scene: CanvasScene } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const history = useQuery({
    queryKey: ['canvas', 'history', String(canvasId)],
    queryFn: () => kernel.canvas.listHistory(canvasId),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop('canvas-toolbar')) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const openPreview = useCallback(
    (entry: CanvasHistoryEntry): void => {
      void kernel.canvas
        .readHistory(canvasId, entry.slot)
        .then((result) => {
          setPreview({ entry: result.entry, scene: result.scene });
        })
        .catch((cause: unknown) => {
          onError(`读取历史版本失败：${String(cause)}`);
        });
    },
    [canvasId, kernel, onError],
  );

  const restore = useCallback(
    (entry: CanvasHistoryEntry): void => {
      setBusy(true);
      void kernel.canvas
        .restoreHistory(canvasId, entry.slot, entry.hash)
        .then((scene) => {
          void queryClient.invalidateQueries({ queryKey: ['canvas', 'history', String(canvasId)] });
          void queryClient.invalidateQueries({ queryKey: ['canvases', 'list'] });
          setPreview(null);
          onRestored(scene);
        })
        .catch((cause: unknown) => {
          onError(`恢复历史版本失败：${String(cause)}`);
          void queryClient.invalidateQueries({ queryKey: ['canvas', 'history', String(canvasId)] });
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [canvasId, kernel, onError, onRestored, queryClient],
  );

  return (
    <div className={styles.filterPopover} data-canvas-overlay="history">
      <p className={styles.fieldLabel}>历史版本（最多 5 版，1 为上一版）</p>

      {history.isPending ? <p className={styles.fieldEmpty}>正在读取…</p> : null}
      {history.error === null || history.error === undefined ? null : (
        <p className={styles.fieldEmpty}>读取历史失败</p>
      )}

      {(history.data ?? []).length === 0 && !history.isPending ? (
        <p className={styles.fieldEmpty}>还没有历史版本：内容变更后才生成</p>
      ) : (
        <ul className={styles.recentList}>
          {(history.data ?? []).map((entry) => (
            <li key={entry.slot}>
              <button
                type="button"
                className={`${styles.recentRow} ${preview?.entry.slot === entry.slot ? styles.recentRowActive : ''}`}
                disabled={!entry.readable}
                title={entry.readable ? '只读预览这一版' : '快照损坏，无法恢复'}
                onClick={() => {
                  openPreview(entry);
                }}
              >
                <span className={styles.recentTitle}>
                  第 {entry.slot} 版 · {formatTime(entry.updatedAt)}
                </span>
                <span className={styles.recentMeta}>
                  {entry.readable ? `${entry.nodeCount} 节点` : '损坏'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview === null ? (
        <p className={styles.historyHint}>选择一版查看只读预览</p>
      ) : (
        <div className={styles.historyPreview}>
          <p className={styles.historyTitle}>{preview.scene.title}</p>
          <p className={styles.historyMeta}>
            {preview.scene.nodes.length} 节点 · {preview.scene.edges.length} 连线 ·{' '}
            {formatTime(preview.entry.updatedAt)}
          </p>
          <div className={styles.historyActions}>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy}
              onClick={() => {
                setPreview(null);
              }}
            >
              取消预览
            </button>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy || !preview.entry.readable}
              onClick={() => {
                restore(preview.entry);
              }}
              title="当前版本会先存入历史，可再次恢复撤销"
            >
              {busy ? '恢复中…' : '恢复此版本'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
