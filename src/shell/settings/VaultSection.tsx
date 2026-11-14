import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
import { describeIpcError } from '../../data/tauri/ipc-error.ts';
import {
  chooseVaultDirectory,
  openVault,
  readVaultInfo,
  type VaultOpenMode,
} from '../../data/tauri/vault-session.ts';
import { flushFloatEditors } from '../editor/float-flush.ts';
import { useKernel } from '../kernel-provider.tsx';
import { isSameDirectory, runVaultSwitch } from './vault-switch.ts';
import styles from './SettingsPanel.module.css';

/**
 * 设置里的「库」：展示当前库根与最近列表，支持切换。
 * 只打开既有库（缺 `.workbench/settings.json` 直接报错），不会把任意目录变成库。
 * 切换先 flush 当前库（含浮窗编辑器的防抖写入），再在 Rust 侧事务式打开目标库；
 * 成功后重载窗口重新引导内核。旧库只保留在最近列表，不删除、不搬动，切回旧路径即回滚。
 */
export const VaultSection = (): ReactElement => {
  const kernel = useKernel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const info = useQuery({ queryKey: ['vault', 'info'], queryFn: readVaultInfo });

  const switchTo = useCallback(
    async (root: string, mode: VaultOpenMode): Promise<void> => {
      setError(null);
      setNote(null);
      // 同一实际目录不重建会话：Rust 侧也就不会把可写会话降成只读
      const current = info.data?.root;
      if (current !== undefined && isSameDirectory(current, root)) {
        setNote('这已经是当前库，无需切换。');
        return;
      }
      setBusy(true);
      try {
        const outcome = await runVaultSwitch(
          {
            flushFloatEditors,
            flushDocs: () => kernel.docs.flush(),
            flushCanvas: () => kernel.canvas.flush(),
            flushSettings: () => kernel.settings.flush(),
            open: openVault,
            reload: () => {
              window.location.reload();
            },
          },
          root,
          mode,
        );
        if (outcome.kind === 'aborted') setError(outcome.reason);
      } finally {
        setBusy(false);
      }
    },
    [info.data?.root, kernel],
  );

  const pick = useCallback(async (): Promise<void> => {
    setError(null);
    setNote(null);
    try {
      // 只接受既有库：选中的目录缺库身份时由 Rust 报「还不是 Ember 库」，不在此初始化
      const path = await chooseVaultDirectory('existing');
      if (path !== null) await switchTo(path, 'existing');
    } catch (cause: unknown) {
      setError(describeIpcError(cause));
    }
  }, [switchTo]);

  const currentRoot = info.data?.root ?? null;
  const recents = info.data?.recents ?? [];
  const warning = info.data?.warning ?? null;

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>库</h3>
      <p className={styles.note}>库是磁盘上的文件夹，Ember 直接指向它；切换只改指向，不移动文件。</p>
      {info.isError ? <p className={styles.error}>{describeIpcError(info.error)}</p> : null}
      {warning === null ? null : <p className={styles.warning}>{warning}</p>}
      <dl className={styles.about}>
        <div>
          <dt>当前位置</dt>
          <dd>{currentRoot ?? '—'}</dd>
        </div>
      </dl>
      <div className={styles.options}>
        <button
          type="button"
          className={styles.option}
          disabled={busy}
          onClick={() => {
            void pick();
          }}
        >
          打开其他已有的库…
        </button>
      </div>
      {recents.length > 0 ? (
        <>
          <p className={styles.note}>最近打开（点击切回；原库文件保留在原处）</p>
          <div className={styles.options}>
            {recents.map((recent) => (
              <button
                key={recent.path}
                type="button"
                className={styles.option}
                title={recent.path}
                disabled={busy || (currentRoot !== null && isSameDirectory(recent.path, currentRoot))}
                onClick={() => {
                  void switchTo(recent.path, 'existing');
                }}
              >
                {currentRoot !== null && isSameDirectory(recent.path, currentRoot)
                  ? `${recent.path}（当前）`
                  : recent.path}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {busy ? <p className={styles.note}>正在切换库…</p> : null}
      {note === null ? null : <p className={styles.note}>{note}</p>}
      {error === null ? null : <p className={styles.error}>{error}</p>}
    </section>
  );
};
