import { invoke } from '@tauri-apps/api/core';

/** 最近打开过的库（`vaults.json` 的 recents 项）。 */
export interface VaultRecent {
  readonly path: string;
  readonly vaultId?: string;
  readonly openedAt: string;
}

export interface VaultStartupIdentity {
  readonly vaultId: string;
  readonly readonly: boolean;
  /** 只读原因；可写时 Rust 侧省略该字段 */
  readonly readonlyReason?: string;
}

/**
 * 启动闸门三态。`ready` 之后才能引导内核；`choose` / `failed` 都停在
 * 可恢复页面，不进入启动失败死页。
 */
export type VaultStartupView =
  | {
      readonly status: 'ready';
      readonly identity: VaultStartupIdentity;
      readonly root: string;
    }
  | {
      readonly status: 'choose';
      readonly legacyRoot: string | null;
      readonly recents: readonly VaultRecent[];
      readonly warning: string | null;
    }
  | {
      readonly status: 'failed';
      readonly root: string | null;
      readonly code: string;
      readonly message: string;
    };

/** `create` 允许初始化库目录（用户显式选择/新建）；`existing` 只接受既有库。 */
export type VaultOpenMode = 'existing' | 'create';

export interface VaultInfo {
  readonly root: string;
  readonly recents: readonly VaultRecent[];
}

export const readVaultStartup = (): Promise<VaultStartupView> =>
  invoke<VaultStartupView>('vault_startup_state');

export const openVault = (root: string, mode: VaultOpenMode): Promise<VaultStartupView> =>
  invoke<VaultStartupView>('vault_open', { root, mode });

export const retryVault = (): Promise<VaultStartupView> => invoke<VaultStartupView>('vault_retry');

/** 原生目录面板；用户取消返回 null。 */
export const chooseVaultDirectory = (mode: VaultOpenMode): Promise<string | null> =>
  invoke<string | null>('vault_choose_directory', { mode });

export const readVaultInfo = (): Promise<VaultInfo> => invoke<VaultInfo>('vault_current_info');
