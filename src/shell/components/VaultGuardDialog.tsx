import type { ReactElement } from 'react';
import type { VaultGuardState } from '../../kernel/types.ts';
import styles from './VaultGuardDialog.module.css';

export interface VaultGuardDialogProps {
  readonly state: VaultGuardState;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRescan: () => void;
  readonly onExit: () => void;
}

/**
 * 库守护熔断：单次对账中大量文档消失时阻止目录清理并进入只读。
 * 只给两个出口——确认当前目录是目标库就按磁盘重建，否则退出另选库。
 */
export const VaultGuardDialog = ({
  state,
  busy,
  error,
  onRescan,
  onExit,
}: VaultGuardDialogProps): ReactElement => {
  const percent = Math.round(state.ratio * 100);
  return (
    <div className={styles.backdrop} role="alertdialog" aria-modal="true" aria-labelledby="vault-guard-title">
      <div className={styles.dialog}>
        <h2 id="vault-guard-title" className={styles.title}>
          这个库看起来被整体替换或移走了
        </h2>
        <p className={styles.body}>
          本次同步发现 <strong>{state.missing}</strong> / {state.known} 篇文档消失（{percent}%）。
          为避免误清目录记录，清理已暂停，库已进入只读。
        </p>
        <p className={styles.hint}>
          如果当前目录确实是你想用的库，点「重新扫描」按磁盘现状重建；否则请退出后重新选择库。
        </p>
        {error === null ? null : (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onExit} disabled={busy}>
            退出
          </button>
          <button type="button" className={styles.primary} onClick={onRescan} disabled={busy}>
            {busy ? '正在重新扫描…' : '重新扫描'}
          </button>
        </div>
      </div>
    </div>
  );
};
