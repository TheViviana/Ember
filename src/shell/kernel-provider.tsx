import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { toErrorText } from '../kernel/errors.ts';
import type { KernelContext } from '../kernel/context.ts';
import styles from './kernel-provider.module.css';

export interface KernelProviderProps {
  /** 启动函数；必须是稳定引用，否则会重复引导 */
  readonly start: () => Promise<{ readonly context: KernelContext; shutdown(): Promise<void> }>;
  readonly children: ReactNode;
}

export interface KernelReady {
  readonly status: 'ready';
  readonly kernel: KernelContext;
}

export interface KernelLoading {
  readonly status: 'loading';
}

export interface KernelFailed {
  readonly status: 'failed';
  readonly error: string;
}

export type KernelView = KernelReady | KernelLoading | KernelFailed;

const KernelReactContext = createContext<KernelContext | null>(null);

/** 只有这里能拿到 KernelContext；能力不经过 React 树，直接拿内核注入的 ctx */
export const useKernel = (): KernelContext => {
  const value = useContext(KernelReactContext);
  if (value === null) throw new Error('useKernel 必须在 KernelProvider 内使用');
  return value;
};

export const KernelProvider = ({ start, children }: KernelProviderProps): ReactElement => {
  const [view, setView] = useState<KernelView>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let running: { shutdown(): Promise<void> } | null = null;

    void start()
      .then((kernel) => {
        if (cancelled) {
          void kernel.shutdown();
          return;
        }
        running = kernel;
        setView({ status: 'ready', kernel: kernel.context });
      })
      .catch((error: unknown) => {
        if (!cancelled) setView({ status: 'failed', error: toErrorText(error) });
      });

    return () => {
      cancelled = true;
      if (running !== null) void running.shutdown();
    };
  }, [start]);

  if (view.status === 'loading') {
    return <main className={styles.bootScreen}>正在打开库…</main>;
  }
  if (view.status === 'failed') {
    return (
      <main className={`${styles.bootScreen} ${styles.failed}`}>
        <h1 className={styles.title}>启动失败</h1>
        <pre className={styles.detail}>{view.error}</pre>
      </main>
    );
  }
  return <KernelReactContext.Provider value={view.kernel}>{children}</KernelReactContext.Provider>;
};
