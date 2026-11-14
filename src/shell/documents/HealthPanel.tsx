import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { useMachineStore, type FloatPosition } from '../../data/stores/machine-store.ts';
import { toErrorText } from '../../kernel/errors.ts';
import type { HealthIssue, HealthIssueKind, HealthReport } from '../../kernel/types.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { moveFloatFrame, type FloatFrame } from '../editor/float-layout.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './HealthPanel.module.css';

/** 复用机器本地 ui.json 的 floatPositions 记录，键不与文档 id（ULID）冲突 */
const HEALTH_FLOAT_KEY = 'library-health';
const PANEL_WIDTH = 600;
const PANEL_HEIGHT = 560;
const PANEL_MARGIN = 24;
const MOVE_THRESHOLD_PX = 3;

interface MoveDrag {
  readonly start: FloatFrame;
  readonly container: { readonly width: number; readonly height: number };
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  engaged: boolean;
}

const KIND_ORDER: readonly HealthIssueKind[] = [
  'broken_frontmatter',
  'non_utf8',
  'oversize',
  'markdown_extension',
  'broken_asset',
  'broken_canvas',
  'broken_history',
  'symlink',
];

const KIND_LABEL: Readonly<Record<HealthIssueKind, string>> = {
  broken_frontmatter: '坏 frontmatter',
  non_utf8: '非 UTF-8',
  oversize: '超限文件',
  markdown_extension: '.markdown 漏收录',
  broken_asset: '失效资产引用',
  broken_canvas: '坏画布',
  broken_history: '坏历史',
  symlink: '符号链接',
};

interface Message {
  readonly tone: 'ok' | 'warn' | 'error';
  readonly text: string;
}

interface ConfirmState {
  readonly issue: HealthIssue;
}

const confirmText = (_kind: HealthIssue['fix']): string =>
  '将把 .markdown 改名为 .md，文件内容保持不变；目标已存在时不覆盖。';

const buttonLabel = (_kind: HealthIssue['fix']): string => '确认改名';

export interface HealthPanelProps {
  readonly onClose: () => void;
}

/** 库健康检查：只读扫描；只开放缺失 id adoption 与 .markdown 改名两类安全修复。 */
export const HealthPanel = ({ onClose }: HealthPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const escLayerId = useId();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [scanning, setScanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<FloatFrame | null>(null);
  const [frame, setFrame] = useState<FloatFrame | null>(null);
  const dragRef = useRef<MoveDrag | null>(null);
  const movedRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const savedPosition = useMachineStore((state) => state.floatPositions[HEALTH_FLOAT_KEY]);
  const initializedPositionRef = useRef<FloatPosition | undefined>(undefined);

  const readonly = kernel.env.readonlyMode;
  const layerId = `library-health${escLayerId}`;
  useEscLayer(layerId, true);

  // 与设置窗同一套浮窗几何：首次居中，之后按 ui.json 里 floatPositions 的位置恢复
  useLayoutEffect(() => {
    const container = rootRef.current?.parentElement;
    if (container === null || container === undefined) return;
    if (frameRef.current !== null && (movedRef.current || savedPosition === initializedPositionRef.current)) {
      return;
    }
    const area = { width: container.clientWidth, height: container.clientHeight };
    if (area.width <= 0 || area.height <= 0) return;
    const width = Math.min(PANEL_WIDTH, Math.max(280, area.width - PANEL_MARGIN * 2));
    const height = Math.min(PANEL_HEIGHT, Math.max(320, area.height - PANEL_MARGIN * 2));
    const base: FloatFrame = {
      left: Math.round((area.width - width) / 2),
      top: Math.round((area.height - height) / 2),
      width,
      height,
    };
    initializedPositionRef.current = savedPosition;
    const next =
      savedPosition === undefined
        ? base
        : moveFloatFrame({ ...base, left: savedPosition.left, top: savedPosition.top }, 0, 0, area);
    frameRef.current = next;
    setFrame(next);
  }, [savedPosition]);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button') !== null) return;
    const start = frameRef.current;
    const container = rootRef.current?.parentElement;
    if (start === null || container === null || container === undefined) return;
    dragRef.current = {
      start,
      container: { width: container.clientWidth, height: container.clientHeight },
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      engaged: false,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    if (!drag.engaged) {
      if (Math.abs(deltaX) < MOVE_THRESHOLD_PX && Math.abs(deltaY) < MOVE_THRESHOLD_PX) return;
      drag.engaged = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setMoving(true);
    }
    event.preventDefault();
    const next = moveFloatFrame(drag.start, deltaX, deltaY, drag.container);
    frameRef.current = next;
    setFrame(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.engaged) return;
    setMoving(false);
    movedRef.current = true;
    const current = frameRef.current;
    if (current !== null) {
      // 只在松手时记忆位置，拖动期间不写机器状态
      useMachineStore
        .getState()
        .rememberFloatPosition(HEALTH_FLOAT_KEY, { left: current.left, top: current.top });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop(layerId)) return;
      event.preventDefault();
      if (busy || scanning) return;
      if (confirm !== null) {
        setConfirm(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, confirm, layerId, onClose, scanning]);

  const runScan = useCallback(async (): Promise<HealthReport | null> => {
    setScanning(true);
    setError(null);
    try {
      const next = await kernel.health.scan();
      setReport(next);
      return next;
    } catch (cause) {
      setError(toErrorText(cause));
      return null;
    } finally {
      setScanning(false);
    }
  }, [kernel]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const groups = useMemo(() => {
    const issues = report?.issues ?? [];
    return KIND_ORDER.map((kind) => ({
      kind,
      issues: issues.filter((issue) => issue.kind === kind),
    })).filter((group) => group.issues.length > 0);
  }, [report]);

  const execute = useCallback(
    (issue: HealthIssue): void => {
      setConfirm(null);
      const hash = issue.hash;
      if (hash === null || issue.fix === null) return;
      setBusy(true);
      setMessage(null);
      void (async (): Promise<void> => {
        const target = await kernel.health.renameMarkdown(issue.path, hash);
        setMessage({ tone: 'ok', text: `${String(issue.path)} 已改名为 ${String(target)}。` });
        await runScan();
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
    [kernel, queryClient, runScan],
  );

  const total = report?.issues.length ?? 0;

  return (
    <div
      className={`${styles.root} ${moving ? styles.moving : ''}`}
      ref={rootRef}
      style={
        frame === null
          ? undefined
          : { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
      }
      data-ready={frame === null ? 'false' : 'true'}
      data-canvas-overlay="health"
      role="dialog"
      aria-label="库健康检查"
    >
      <header
        className={styles.header}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        title="拖动移动面板"
      >
        <span className={styles.headerIcon}>◎</span>
        <span className={styles.headerTitle}>库健康检查</span>
        <span className={styles.headerCount}>{total}</span>
        <button
          type="button"
          className={styles.close}
          aria-label="关闭库健康检查"
          disabled={busy || scanning}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className={styles.toolbar}>
        <span className={styles.summary}>
          {scanning
            ? '正在扫描…'
            : report === null
              ? '尚未扫描'
              : `扫描 ${report.documents} 个文档，发现 ${report.issues.length} 个问题`}
        </span>
        <button
          type="button"
          className={styles.button}
          disabled={busy || scanning}
          onClick={() => {
            void runScan();
          }}
        >
          {scanning ? '扫描中…' : '重新检查'}
        </button>
      </div>

      {error === null ? null : (
        <p className={`${styles.notice} ${styles.notice_error}`} role="alert">
          扫描失败：{error}
        </p>
      )}
      {message === null ? null : (
        <p className={`${styles.notice} ${styles[`notice_${message.tone}`] ?? ''}`} role="status">
          {message.text}
        </p>
      )}

      <div className={styles.body}>
        {!scanning && report !== null && total === 0 ? (
          <p className={styles.empty}>库状态良好，没有发现问题。</p>
        ) : null}

        {groups.map((group) => (
          <section key={group.kind} className={styles.group}>
            <header className={styles.groupHead}>
              <span className={styles.groupTitle}>{KIND_LABEL[group.kind]}</span>
              <span className={styles.groupCount}>{group.issues.length}</span>
            </header>
            <ul className={styles.issues}>
              {group.issues.map((issue) => {
                const confirming =
                  confirm !== null &&
                  confirm.issue.path === issue.path &&
                  confirm.issue.kind === issue.kind;
                const canFix = issue.fix !== null && issue.hash !== null;
                return (
                  <li key={`${issue.kind}:${String(issue.path)}:${String(issue.target)}`} className={styles.issue}>
                    <div className={styles.issueInfo}>
                      <span className={styles.issuePath}>{String(issue.path)}</span>
                      <span className={styles.issueDetail}>{issue.detail}</span>
                      {issue.target === null ? null : (
                        <span className={styles.issueTarget}>{String(issue.target)}</span>
                      )}
                    </div>

                    {confirming ? (
                      <div className={styles.confirmRow}>
                        <span className={styles.confirmText}>{confirmText(issue.fix)}</span>
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
                            execute(issue);
                          }}
                        >
                          {busy ? '处理中…' : buttonLabel(issue.fix)}
                        </button>
                      </div>
                    ) : canFix ? (
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={busy || scanning || readonly}
                          title={readonly ? readonlyText(kernel.env.readonlyReason) : issue.detail}
                          onClick={() => {
                            setConfirm({ issue });
                          }}
                        >
                          {'改名为 .md'}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <footer className={styles.footer}>
        {readonly ? (
          <span className={styles.readonly}>{readonlyText(kernel.env.readonlyReason)}</span>
        ) : null}
        <button type="button" className={styles.button} disabled={busy || scanning} onClick={onClose}>
          关闭
        </button>
      </footer>
    </div>
  );
};
