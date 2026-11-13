import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  defaultBackupDestination,
  describeBackupError,
  exportVaultBackup,
  inspectVaultBackup,
  type BackupInspectReport,
  type BackupIssue,
} from '../../data/tauri/backup.ts';
import { toErrorText } from '../../kernel/errors.ts';
import { flushFloatEditors } from '../editor/float-flush.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './SettingsPanel.module.css';

/** 单条 issue 文案上限：预检可能一次报出上百条，界面只展示摘要 */
const MAX_VISIBLE_ISSUES = 40;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const SEVERITY_LABEL: Record<BackupIssue['severity'], string> = {
  error: '错误',
  conflict: '冲突',
  warn: '提示',
};

/** 分类顺序：能阻止恢复的排前面 */
const SEVERITY_ORDER: Record<BackupIssue['severity'], number> = {
  error: 0,
  conflict: 1,
  warn: 2,
};

/**
 * 备份分区：整库导出 + 导出包只读预检。
 * 导出前必须先 flush 全部挂起写入，否则磁盘上的备份会漏掉最后一次输入。
 */
export const BackupSection = (): ReactElement => {
  const kernel = useKernel();
  const [destination, setDestination] = useState('');
  const [includeWorkbench, setIncludeWorkbench] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [packagePath, setPackagePath] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<BackupInspectReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void defaultBackupDestination()
      .then((value) => {
        if (!active) return;
        // 用户已手填目标时不覆盖
        setDestination((current) => (current === '' ? value : current));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const runExport = useCallback(async (): Promise<void> => {
    setExporting(true);
    setError(null);
    setExportNote(null);
    try {
      // 浮窗编辑器、正文队列、画布视口防抖、库设置：全部落盘后才开始遍历
      await flushFloatEditors();
      await kernel.docs.flush();
      await kernel.canvas.flush();
      await kernel.settings.flush();
      const report = await exportVaultBackup({
        destination: destination.trim(),
        includeWorkbench,
      });
      setExportNote(
        `已导出到 ${report.directory}：文档 ${report.documents} 篇、资产 ${report.assets} 个、` +
          `工作台 ${report.workbenchFiles} 个文件，共 ${formatBytes(report.bytes)}。`,
      );
      // 顺手把包路径填进预检框，省一次手输
      setPackagePath(report.directory);
    } catch (cause) {
      // 浮窗落盘失败时给出具体文档数量与原因，而不是笼统的「导出失败」
      setError(cause instanceof Error ? toErrorText(cause) : describeBackupError(cause));
    } finally {
      setExporting(false);
    }
  }, [destination, includeWorkbench, kernel]);

  const runInspect = useCallback(async (): Promise<void> => {
    setInspecting(true);
    setError(null);
    setInspection(null);
    try {
      setInspection(await inspectVaultBackup(packagePath.trim()));
    } catch (cause) {
      setError(describeBackupError(cause));
    } finally {
      setInspecting(false);
    }
  }, [packagePath]);

  const issues =
    inspection === null
      ? []
      : [...inspection.issues].sort(
          (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
        );
  const visibleIssues = issues.slice(0, MAX_VISIBLE_ISSUES);

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>备份</h3>
      <p className={styles.note}>
        把整库导出成一个普通目录：Markdown 进 <code>docs/</code>，附件进 <code>assets/</code>，
        <code>.workbench/</code> 可选（设置、画布、画布历史）。锁文件、临时文件与旧回收目录不进包；
        机器本地的 UI 状态、AI 会话与钥匙串密钥永远不导出。
      </p>
      <p className={styles.note}>
        导出前会先落盘所有挂起写入。目标目录必须不存在且位于库外，导出过程不会覆盖任何已有目录。
      </p>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>导出到（绝对路径，目录必须不存在）</span>
        <input
          className={styles.input}
          value={destination}
          spellCheck={false}
          placeholder="例如 /Users/me/Documents/Ember Export 我的库 2026-11-13"
          onChange={(event) => {
            setDestination(event.currentTarget.value);
          }}
        />
      </label>
      <label className={styles.switchRow}>
        <input
          type="checkbox"
          checked={includeWorkbench}
          disabled={exporting}
          onChange={(event) => {
            setIncludeWorkbench(event.currentTarget.checked);
          }}
        />
        <span>包含工作台（设置、画布与画布历史）</span>
      </label>
      <div className={styles.options}>
        <button
          type="button"
          className={`${styles.option} ${styles.action}`}
          disabled={exporting || destination.trim() === ''}
          onClick={() => {
            void runExport();
          }}
        >
          <span className={styles.optionTitle}>{exporting ? '导出中…' : '导出备份'}</span>
        </button>
      </div>
      {exportNote === null ? null : <p className={styles.note}>{exportNote}</p>}

      <label className={styles.field}>
        <span className={styles.fieldLabel}>备份包目录（只读预检，不写盘）</span>
        <input
          className={styles.input}
          value={packagePath}
          spellCheck={false}
          placeholder="粘贴或填写导出包的绝对路径"
          onChange={(event) => {
            setPackagePath(event.currentTarget.value);
          }}
        />
      </label>
      <div className={styles.options}>
        <button
          type="button"
          className={`${styles.option} ${styles.action}`}
          disabled={inspecting || packagePath.trim() === ''}
          onClick={() => {
            void runInspect();
          }}
        >
          <span className={styles.optionTitle}>{inspecting ? '预检中…' : '预检备份包'}</span>
        </button>
      </div>

      {error === null ? null : <p className={styles.error}>{error}</p>}

      {inspection === null ? null : (
        <div className={styles.inspection}>
          <dl className={styles.about}>
            <div>
              <dt>结论</dt>
              <dd>{inspection.restorable ? '可恢复（无阻断错误）' : '不可恢复（存在错误）'}</dd>
            </div>
            <div>
              <dt>库</dt>
              <dd>{inspection.vaultName === '' ? '—' : inspection.vaultName}</dd>
            </div>
            <div>
              <dt>格式</dt>
              <dd>
                {inspection.format} v{inspection.formatVersion}
              </dd>
            </div>
            <div>
              <dt>导出时间</dt>
              <dd>{inspection.exportedAt === '' ? '—' : inspection.exportedAt}</dd>
            </div>
            <div>
              <dt>内容</dt>
              <dd>
                文档 {inspection.documents} / 资产 {inspection.assets} / 工作台{' '}
                {inspection.workbenchFiles}
                {inspection.includeWorkbench ? '' : '（未包含）'}
              </dd>
            </div>
            <div>
              <dt>字节</dt>
              <dd>{formatBytes(inspection.totalBytes)}</dd>
            </div>
          </dl>
          {issues.length === 0 ? (
            <p className={styles.note}>没有发现问题。</p>
          ) : (
            <ul className={styles.issues}>
              {visibleIssues.map((item, index) => (
                <li
                  key={`${item.code}-${item.path ?? index}`}
                  className={`${styles.issue} ${
                    item.severity === 'error'
                      ? styles.issueError
                      : item.severity === 'conflict'
                        ? styles.issueConflict
                        : styles.issueWarn
                  }`}
                >
                  <span className={styles.issueTag}>{SEVERITY_LABEL[item.severity]}</span>
                  <span className={styles.issueBody}>
                    {item.path === null ? null : <code className={styles.issuePath}>{item.path}</code>}
                    {item.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {issues.length > MAX_VISIBLE_ISSUES ? (
            <p className={styles.note}>
              另有 {issues.length - MAX_VISIBLE_ISSUES} 条未展示；完整清单见包内 manifest.json。
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
};
