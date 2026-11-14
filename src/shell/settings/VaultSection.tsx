import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, type ReactElement } from 'react';
import { describeIpcError } from '../../data/tauri/ipc-error.ts';
import {
  chooseVaultDirectory,
  openVault,
  readVaultInfo,
  type VaultOpenMode,
} from '../../data/tauri/vault-session.ts';
import { useKernel } from '../kernel-provider.tsx';
import styles from './SettingsPanel.module.css';

/**
 * 设置里的「库」：展示当前库根与最近列表，支持切换。
 * 切换先 flush 当前库，再在 Rust 侧事务式打开目标库；成功后重载窗口重新引导内核。
 * 旧库只保留在最近列表，不删除、不搬动，切回旧路径即回滚。
 */
export const VaultSection = (): ReactElement => {
  const kernel = useKernel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = useQuery({ queryKey: ['vault', 'info'], queryFn: readVaultInfo });

  const switchTo = useCallback(
    async (root: string, mode: VaultOpenMode): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        // 切换会重载窗口：先落盘，避免未保存内容被一起丢掉
        await kernel.docs.flush();
        await kernel.canvas.flush();
        await kernel.settings.flush();
        const view = await openVault(root, mode);
        if (view.status !== 'ready') {
          setError('目标库没有就绪，当前库保持不变。');
          return;
        }
        window.location.reload();
      } catch (cause: unknown) {
        setError(`未切换：${describeIpcError(cause)}`);
      } finally {
        setBusy(false);
      }
    },
    [kernel],
  );

  const pick = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // 显式选择即授权初始化：选中的空文件夹会被写成新库
      const path = await chooseVaultDirectory('existing');
      if (path !== null) await switchTo(path, 'create');
    } catch (cause: unknown) {
      setError(describeIpcError(cause));
    }
  }, [switchTo]);

  const currentRoot = info.data?.root ?? null;
  const recents = info.data?.recents ?? [];

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>库</h3>
      <p className={styles.note}>库是磁盘上的文件夹，Ember 直接指向它；切换只改指向，不移动文件。</p>
      {info.isError ? <p className={styles.error}>{describeIpcError(info.error)}</p> : null}
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
          选择其他文件夹…
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
                disabled={busy || recent.path === currentRoot}
                onClick={() => {
                  void switchTo(recent.path, 'existing');
                }}
              >
                {recent.path === currentRoot ? `${recent.path}（当前）` : recent.path}
              </button>
            ))}
          </div>
        </>
      ) : null}
      {busy ? <p className={styles.note}>正在切换库…</p> : null}
      {error === null ? null : <p className={styles.error}>{error}</p>}
    </section>
  );
};
