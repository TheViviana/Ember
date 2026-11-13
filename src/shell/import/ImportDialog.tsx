import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import { useKernel } from '../kernel-provider.tsx';
import {
  buildImportPlan,
  IMPORT_ACCEPT,
  IMPORT_ROOT,
  MAX_IMPORT_FILES,
  MAX_IMPORT_MB,
  type ImportCandidate,
  type ImportPlan,
  type ImportRejection,
} from './markdown-import.ts';
import { useImportStore } from './import-store.ts';
import { readonlyText } from '../components/readonly-text.ts';
import styles from './ImportDialog.module.css';

type Stage = 'pick' | 'reading' | 'preview' | 'writing' | 'done';

interface ImportResult {
  readonly saved: number;
  readonly failures: readonly { readonly path: string; readonly reason: string }[];
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 目录选择的两个属性不在 React 的 input 类型里，用展开而不是 setAttribute：
 * 必须在元素创建时就带上，WKWebView 才按目录选择器呈现，否则只会弹普通文件选择器。
 */
const DIRECTORY_ATTRS = { webkitdirectory: '', directory: '' };

/**
 * 导入 Markdown 对话框：选择 → 预览清单（目标路径 + 未知键 + 拒绝项）→ 人工确认 → 逐篇写入。
 * 写盘前必须经过 preview 阶段，确认按钮是唯一的写入入口。
 */
export const ImportDialog = (): ReactElement | null => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const mode = useImportStore((state) => state.mode);
  const closeStore = useImportStore((state) => state.close);

  const [stage, setStage] = useState<Stage>('pick');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** 在途读取/写入的代际号：关闭对话框即作废，迟到回调不得覆盖重置后的界面 */
  const runRef = useRef(0);
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const documents = useQuery({
    queryKey: ['docs', 'list'],
    queryFn: () => kernel.docs.list(),
    enabled: mode !== null,
  });

  // webkitdirectory 必须作为创建时的属性出现：WKWebView 不会读取运行时补上的属性，
  // 那样只会弹出普通文件选择器，选不了目录、也拿不到 webkitRelativePath。
  // 因此两个属性写在下面的 JSX 里，这里不再用 setAttribute 补。

  useEffect(() => {
    if (mode !== null) return;
    // 关闭即作废在途的读取与写入循环，否则残留的 async 回调会把
    // 上一次的「已完成」页写回刚重置的状态
    runRef.current += 1;
    setStage('pick');
    setPlan(null);
    setResult(null);
    setProgress({ done: 0, total: 0 });
  }, [mode]);

  if (mode === null) return null;

  const readonlyMode = kernel.env.readonlyMode;

  const readFiles = async (files: readonly File[], stripRoot: boolean): Promise<void> => {
    if (files.length === 0) return;
    const runId = runRef.current;
    const stale = (): boolean => runRef.current !== runId;
    setStage('reading');
    const candidates: ImportCandidate[] = [];
    const readErrors: ImportRejection[] = [];
    for (const file of files) {
      try {
        const text = await file.text();
        if (stale()) return;
        candidates.push({
          relativePath: stripRoot ? file.webkitRelativePath || file.name : file.name,
          text,
          bytes: file.size,
        });
      } catch (error) {
        readErrors.push({ sourcePath: file.name, reason: `读取失败：${errorText(error)}` });
      }
    }
    if (stale()) return;
    const existing = (documents.data ?? []).map((doc) => String(doc.path));
    const next = buildImportPlan(candidates, existing, stripRoot);
    setPlan({ entries: next.entries, rejected: [...readErrors, ...next.rejected] });
    setStage('preview');
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>, stripRoot: boolean): void => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    void readFiles(files, stripRoot);
  };

  const runImport = async (): Promise<void> => {
    if (plan === null || plan.entries.length === 0) return;
    const runId = ++runRef.current;
    const stale = (): boolean => runRef.current !== runId;
    setStage('writing');
    setProgress({ done: 0, total: plan.entries.length });
    const failures: { path: string; reason: string }[] = [];
    let saved = 0;
    for (const entry of plan.entries) {
      try {
        await kernel.docs.create({
          path: kernel.paths.normalize(entry.targetPath),
          title: entry.title,
          text: entry.text,
          intent: 'user',
          tags: entry.tags,
          aliases: entry.aliases,
          ...(entry.summary === null ? {} : { summary: entry.summary }),
        });
        saved += 1;
      } catch (error) {
        failures.push({ path: entry.targetPath, reason: errorText(error) });
      }
      // 中途关闭对话框：停止后续写入（正在写的一篇会完成），保持重置后的 pick 状态
      if (stale()) return;
      setProgress((current) => ({ ...current, done: current.done + 1 }));
    }
    if (stale()) return;
    await queryClient.invalidateQueries({ queryKey: ['docs', 'list'] });
    if (stale()) return;
    if (stale()) return;
    setResult({ saved, failures });
    setStage('done');
  };

  const close = (): void => {
    closeStore();
  };

  const discarded = (plan?.entries ?? []).filter((entry) => entry.discardedKeys.length > 0);

  return (
    <div className={styles.scrim} role="presentation">
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="导入 Markdown">
        <header className={styles.head}>
          <h2 className={styles.title}>{mode === 'folder' ? '导入 Markdown 文件夹' : '导入 Markdown 文件'}</h2>
          <button type="button" className={styles.close} aria-label="关闭导入" onClick={close}>
            ×
          </button>
        </header>

        <p className={styles.note}>
          只导入 .md / .markdown；落点 {IMPORT_ROOT}/，保留所选目录内的相对层级；单篇 ≤ {MAX_IMPORT_MB} MB，单次 ≤{' '}
          {MAX_IMPORT_FILES} 篇；跳过 media/ 与 .workbench/；同名不覆盖，自动加后缀。
        </p>

        {readonlyMode ? (
          <p className={styles.warn}>{readonlyText(kernel.env.readonlyReason)}，不能导入。</p>
        ) : null}

        {stage === 'pick' ? (
          <div className={styles.pick}>
            <p className={styles.note}>先选来源，下一步会列出要写入的路径清单，确认后才写盘。</p>
            <div className={styles.pickActions}>
              <button
                type="button"
                className={styles.primary}
                disabled={readonlyMode}
                onClick={() => {
                  (mode === 'folder' ? folderRef : filesRef).current?.click();
                }}
              >
                {mode === 'folder' ? '选择文件夹…' : '选择文件…'}
              </button>
              <button type="button" className={styles.secondary} onClick={close}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        {stage === 'reading' ? <p className={styles.note}>正在读取所选文件…</p> : null}

        {stage === 'preview' && plan !== null ? (
          <>
            <div className={styles.summaryRow}>
              <span className={styles.count}>将写入 {plan.entries.length} 篇</span>
              <span className={styles.note}>拒绝 {plan.rejected.length} 项</span>
            </div>

            <div className={styles.body}>
              {plan.entries.length === 0 ? <p className={styles.note}>没有可导入的文件。</p> : null}
              {plan.entries.length > 0 ? (
                <ul className={styles.list}>
                  {plan.entries.map((entry) => (
                    <li className={styles.entry} key={entry.sourcePath}>
                      <span className={styles.paths}>
                        <span className={styles.source}>{entry.sourcePath}</span>
                        <span className={styles.arrow}>→</span>
                        <span className={styles.target}>{entry.targetPath}</span>
                      </span>
                      {entry.discardedKeys.length > 0 ? (
                        <span className={styles.discarded}>丢弃未知键：{entry.discardedKeys.join('、')}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {plan.rejected.length > 0 ? (
                <div className={styles.rejected}>
                  <h3 className={styles.subTitle}>以下文件不会导入</h3>
                  <ul className={styles.list}>
                    {plan.rejected.map((item) => (
                      <li className={styles.entry} key={`${item.sourcePath}-${item.reason}`}>
                        <span className={styles.source}>{item.sourcePath}</span>
                        <span className={styles.reason}>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <footer className={styles.foot}>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  setStage('pick');
                  setPlan(null);
                }}
              >
                重新选择
              </button>
              <button type="button" className={styles.secondary} onClick={close}>
                取消
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={plan.entries.length === 0 || readonlyMode}
                onClick={() => {
                  void runImport();
                }}
              >
                确认导入 {plan.entries.length} 篇
              </button>
            </footer>
          </>
        ) : null}

        {stage === 'writing' ? (
          <p className={styles.note}>
            正在写入 {progress.done}/{progress.total}…
          </p>
        ) : null}

        {stage === 'done' && result !== null ? (
          <>
            <p className={styles.count}>
              已导入 {result.saved} 篇
              {result.failures.length > 0 ? `；失败 ${result.failures.length} 篇` : ''}
            </p>
            <div className={styles.body}>
              {result.failures.length > 0 ? (
                <div className={styles.rejected}>
                  <h3 className={styles.subTitle}>失败明细</h3>
                  <ul className={styles.list}>
                    {result.failures.map((failure) => (
                      <li className={styles.entry} key={`${failure.path}-${failure.reason}`}>
                        <span className={styles.target}>{failure.path}</span>
                        <span className={styles.reason}>{failure.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {discarded.length > 0 ? (
                <div className={styles.rejected}>
                  <h3 className={styles.subTitle}>已丢弃的未知 frontmatter 键</h3>
                  <ul className={styles.list}>
                    {discarded.map((entry) => (
                      <li className={styles.entry} key={`discard-${entry.targetPath}`}>
                        <span className={styles.target}>{entry.targetPath}</span>
                        <span className={styles.reason}>{entry.discardedKeys.join('、')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <footer className={styles.foot}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => {
                  close();
                }}
              >
                完成
              </button>
            </footer>
          </>
        ) : null}

        <input ref={filesRef} type="file" accept={IMPORT_ACCEPT} multiple hidden onChange={(event) => { onPick(event, false); }} />
        <input ref={folderRef} type="file" multiple hidden {...DIRECTORY_ATTRS} onChange={(event) => { onPick(event, true); }} />
      </section>
    </div>
  );
};
