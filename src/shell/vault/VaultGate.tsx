import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createKernel } from '../../data/bootstrap.ts';
import { describeIpcError } from '../../data/tauri/ipc-error.ts';
import {
  chooseVaultDirectory,
  openVault,
  readVaultStartup,
  retryVault,
  type VaultOpenMode,
  type VaultStartupView,
} from '../../data/tauri/vault-session.ts';
import { KernelProvider } from '../kernel-provider.tsx';
import styles from './VaultGate.module.css';

const startKernel = (): ReturnType<typeof createKernel> => createKernel();

interface VaultGateProps {
  readonly children: ReactNode;
}

/**
 * 启动闸门：库未就绪时先停在选择页/错误页，就绪后才引导内核。
 * 启动失败不再是死页——错误页始终提供「重试」与「选择其他文件夹」。
 */
export const VaultGate = ({ children }: VaultGateProps): ReactElement => {
  const [view, setView] = useState<VaultStartupView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): void => {
    void readVaultStartup()
      .then((next) => {
        setView(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setView({
          status: 'failed',
          root: null,
          code: 'ipc_failed',
          message: describeIpcError(cause),
        });
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openAt = useCallback(async (root: string, mode: VaultOpenMode): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await openVault(root, mode));
    } catch (cause: unknown) {
      setError(describeIpcError(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 用户显式选目录：面板是否允许新建文件夹与打开方式取同一个值。
   * `existing` 只接受已有库（缺库身份会报「还不是 Ember 库」），
   * `create` 才允许在所选/新建的文件夹里初始化库元数据。
   */
  const pickAndOpen = useCallback(
    async (picker: VaultOpenMode): Promise<void> => {
      setError(null);
      try {
        const path = await chooseVaultDirectory(picker);
        if (path !== null) await openAt(path, picker);
      } catch (cause: unknown) {
        setError(describeIpcError(cause));
      }
    },
    [openAt],
  );

  const retry = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setView(await retryVault());
    } catch (cause: unknown) {
      setError(describeIpcError(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (view === null) {
    return <main className={styles.screen}>正在打开库…</main>;
  }

  if (view.status === 'ready') {
    return <KernelProvider start={startKernel}>{children}</KernelProvider>;
  }

  return (
    <main className={styles.screen}>
      <section className={styles.card}>
        {view.status === 'failed' ? (
          <>
            <h1 className={styles.title}>无法打开这个库</h1>
            <p className={styles.subtitle}>
              库文件没有被改动。可以重试，或选择另一个文件夹。
            </p>
            {view.root !== null ? <code className={styles.path}>{view.root}</code> : null}
            <p className={styles.reason}>{view.message}</p>
          </>
        ) : (
          <>
            <h1 className={styles.title}>
              {view.legacyRoot !== null ? '发现已有的库' : '选择你的知识库文件夹'}
            </h1>
            <p className={styles.subtitle}>
              库就是磁盘上的一个文件夹，Ember 直接指向它。切换不会移动或删除原有文件。
            </p>
            {view.legacyRoot !== null ? (
              <>
                <code className={styles.path}>{view.legacyRoot}</code>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => {
                      void openAt(view.legacyRoot ?? '', 'existing');
                    }}
                  >
                    继续使用当前库
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => {
                      void pickAndOpen('existing');
                    }}
                  >
                    打开其他库
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => {
                    void pickAndOpen('existing');
                  }}
                >
                  打开已有库
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={busy}
                  onClick={() => {
                    void pickAndOpen('create');
                  }}
                >
                  新建库…
                </button>
              </div>
            )}
            {view.warning !== null ? <p className={styles.warning}>{view.warning}</p> : null}
            {view.recents.length > 0 ? (
              <div className={styles.recents}>
                <h2 className={styles.recentsTitle}>最近打开</h2>
                <ul className={styles.recentList}>
                  {view.recents.map((recent) => (
                    <li key={recent.path} className={styles.recentItem}>
                      <span className={styles.recentPath} title={recent.path}>
                        {recent.path}
                      </span>
                      <button
                        type="button"
                        className={styles.link}
                        disabled={busy}
                        onClick={() => {
                          void openAt(recent.path, 'existing');
                        }}
                      >
                        打开
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        {view.status === 'failed' ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => {
                void retry();
              }}
            >
              重试
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => {
                void pickAndOpen('existing');
              }}
            >
              打开其他库
            </button>
          </div>
        ) : null}
        {error !== null ? <p className={styles.error}>{error}</p> : null}
        {busy ? <p className={styles.busy}>正在打开…</p> : null}
      </section>
    </main>
  );
};
