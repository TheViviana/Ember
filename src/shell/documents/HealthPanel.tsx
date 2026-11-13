import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import { toErrorText } from '../../kernel/errors.ts';
import type { HealthIssue, HealthIssueKind, HealthReport } from '../../kernel/types.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './HealthPanel.module.css';

const KIND_ORDER: readonly HealthIssueKind[] = [
  'broken_frontmatter',
  'missing_id',
  'invalid_id',
  'duplicate_id',
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
  missing_id: '缺少 id',
  invalid_id: '非法 id',
  duplicate_id: '重复 id',
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

const confirmText = (kind: HealthIssue['fix']): string => {
  if (kind === 'adopt') return '将为该文件补写 id 与 created/updated，正文保持不变。';
  return '将把 .markdown 改名为 .md，文件内容保持不变；目标已存在时不覆盖。';
};

const buttonLabel = (kind: HealthIssue['fix']): string => {
  if (kind === 'adopt') return '确认纳入';
  return '确认改名';
};

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

  const readonly = kernel.env.readonlyMode;
  const layerId = `library-health${escLayerId}`;
  useEscLayer(layerId, true);

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
        if (issue.fix === 'adopt') {
          await kernel.health.adopt(issue.path, hash);
          setMessage({ tone: 'ok', text: `${String(issue.path)} 已纳入库管理。` });
        } else {
          const target = await kernel.health.renameMarkdown(issue.path, hash);
          setMessage({ tone: 'ok', text: `${String(issue.path)} 已改名为 ${String(target)}。` });
        }
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
    <div className={styles.root} role="dialog" aria-modal="true" aria-label="库健康检查">
      <header className={styles.header}>
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
                          {issue.fix === 'adopt' ? '纳入库管理' : '改名为 .md'}
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
