import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactElement } from 'react';
import type { DocId } from '#doc-model';
import { cssVars } from '../canvas/css-vars.ts';
import { useKernel } from '../kernel-provider.tsx';
import { openFloatSwitcher } from './float-switcher-signal.ts';
import type { CursorPosition } from './cursor.ts';
import { FloatEditor } from './FloatEditor.tsx';
import { deriveStackOrder, useFloatStore } from './float-store.ts';
import { useFocusStore } from './focus-store.ts';
import styles from './FloatLayer.module.css';

export interface FloatLayerProps {
  /** 上报当前浮窗光标；由外壳在接线时传入稳定的 setCursor */
  readonly onCursor: (position: CursorPosition | null) => void;
}

/**
 * 多浮窗层：只订阅窗口元数据，不持有正文/光标/保存状态。
 * z 序由激活顺序派生；点击任意一扇通过捕获阶段置顶。
 * 满额时浮窗 store 拒绝新开并出提示条，挤掉哪一扇由用户显式决定。
 */
export const FloatLayer = ({ onCursor }: FloatLayerProps): ReactElement => {
  const kernel = useKernel();
  const windows = useFloatStore((state) => state.windows);
  const activeId = useFloatStore((state) => state.activeId);
  const limit = useFloatStore((state) => state.limit);
  const notice = useFloatStore((state) => state.notice);
  const focusActive = useFocusStore((state) => state.active);
  const focusDocId = useFocusStore((state) => state.docId);

  // 专注目标被关闭或激活窗切走时自动退出，避免回到「遮罩还在但没有浮窗」的半态
  useEffect(() => {
    if (!focusActive || focusDocId === null) return;
    const stillOpen = windows.some((window) => String(window.docId) === String(focusDocId));
    const stillActive = activeId !== null && String(activeId) === String(focusDocId);
    if (!stillOpen || !stillActive) useFocusStore.getState().exit();
  }, [activeId, focusActive, focusDocId, windows]);

  // 无位置记忆时的层叠槽位：按打开顺序编号，关掉一扇后后面的自然补位
  const slotByDoc = useMemo(() => {
    const map = new Map<string, number>();
    windows.forEach((window, index) => {
      map.set(String(window.docId), index);
    });
    return map;
  }, [windows]);

  const stack = useMemo(() => deriveStackOrder(windows), [windows]);
  // DOM 顺序保持打开顺序（不因置顶重排，避免聚焦元素被搬走），层级只由 z-index 决定
  const zByDoc = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of stack) map.set(String(entry.docId), entry.z);
    return map;
  }, [stack]);

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const doc of documents.data ?? []) {
      map.set(String(doc.id), doc.title);
    }
    return map;
  }, [documents.data]);

  const titleOf = (docId: DocId): string => {
    const title = titleById.get(String(docId));
    return title === undefined || title.trim().length === 0 ? '未命名文档' : title;
  };
  const requestedTitle = notice === null ? '' : titleOf(notice.requestedDocId);
  const evictedTitle =
    notice === null || notice.evictedDocId === null ? '' : titleOf(notice.evictedDocId);

  return (
    <>
      {focusActive ? <div className={styles.focusBackdrop} aria-hidden="true" /> : null}

      {windows.map((window) => {
        const docId = window.docId;
        const isActive = activeId !== null && String(activeId) === String(docId);
        // 专注时其余浮窗只隐藏不卸载：EditorView 与未保存状态必须原样保住
        const focusHidden =
          focusActive && (focusDocId === null || String(focusDocId) !== String(docId));
        return (
          <div
            key={String(docId)}
            className={styles.stack}
            data-active={isActive}
            data-focus-hidden={focusHidden ? 'true' : undefined}
            style={cssVars({ '--stack-index': (zByDoc.get(String(docId)) ?? 1) - 1 })}
            onPointerDownCapture={() => {
              useFloatStore.getState().activate(docId);
            }}
          >
            <FloatEditor
              docId={docId}
              focus={window.focus}
              focusNonce={window.nonce}
              defaultSlot={slotByDoc.get(String(docId)) ?? 0}
              active={isActive}
              onClose={() => {
                useFloatStore.getState().close(docId);
              }}
              onCursor={onCursor}
            />
          </div>
        );
      })}
      {notice === null || focusActive ? null : (
        <div className={styles.notice} data-canvas-overlay role="status">
          <p className={styles.noticeText}>
            浮窗已达上限 {limit} 篇，未打开《{requestedTitle}》。
          </p>
          <div className={styles.noticeActions}>
            {notice.evictedDocId === null ? null : (
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  useFloatStore
                    .getState()
                    .evictLeastRecentAndOpen(notice.requestedDocId, notice.requestedFocus);
                }}
              >
                关闭最久未激活的《{evictedTitle}》并打开
              </button>
            )}
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                openFloatSwitcher();
              }}
            >
              查看已打开
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                useFloatStore.getState().dismissNotice();
              }}
            >
              知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
};
