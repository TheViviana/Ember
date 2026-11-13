import { invoke } from '@tauri-apps/api/core';

/**
 * 备份数据层客户端：整库导出与导出包只读预检。
 * 目录遍历、哈希、staging 与原子改名全在 Rust 侧；这里只做命令映射与结果类型。
 */

export interface BackupExportOptions {
  /** 最终导出目录的绝对路径；必须不存在且不在库内 */
  readonly destination: string;
  readonly includeWorkbench: boolean;
}

export interface BackupExportReport {
  readonly directory: string;
  readonly manifest: string;
  readonly documents: number;
  readonly assets: number;
  readonly workbenchFiles: number;
  readonly bytes: number;
  readonly includeWorkbench: boolean;
}

export type BackupIssueSeverity = 'error' | 'conflict' | 'warn';

export interface BackupIssue {
  readonly severity: BackupIssueSeverity;
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

export interface BackupInspectReport {
  readonly directory: string;
  readonly format: string;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly vaultName: string;
  readonly includeWorkbench: boolean;
  readonly documents: number;
  readonly assets: number;
  readonly workbenchFiles: number;
  readonly totalBytes: number;
  readonly restorable: boolean;
  readonly issues: readonly BackupIssue[];
}

/** 库外默认导出目录（`~/Documents/Ember Export <库名> <日期>`）。 */
export const defaultBackupDestination = async (): Promise<string> =>
  invoke<string>('vault_backup_default_destination');

export const exportVaultBackup = async (
  options: BackupExportOptions,
): Promise<BackupExportReport> =>
  invoke<BackupExportReport>('vault_backup_export', { options });

export const inspectVaultBackup = async (directory: string): Promise<BackupInspectReport> =>
  invoke<BackupInspectReport>('vault_backup_inspect', { directory });

/** IPC 拒绝时可能是 `{ code, message }` 而不是 Error；统一取安全文案。 */
export const describeBackupError = (cause: unknown): string => {
  if (typeof cause === 'object' && cause !== null) {
    const message = (cause as Readonly<Record<string, unknown>>)['message'];
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return cause instanceof Error ? cause.message : String(cause);
};
