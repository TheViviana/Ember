import { invoke } from '@tauri-apps/api/core';
import { asVaultId } from '#doc-model';
import type { Kernel } from '../kernel/boot.ts';
import { bootKernel } from '../kernel/boot.ts';
import type { WindowPort } from '../kernel/ports.ts';
import { attachMachineUiPort, hydrateMachineUi } from './stores/machine-store.ts';
import { createTauriMachineUiPort } from './tauri/machine-ui-port.ts';
import { createTauriVaultPort } from './tauri/vault-port.ts';
import { createTauriWindowPort } from './tauri/window-port.ts';

interface VaultIdentity {
  readonly vaultId: string;
  readonly readonly: boolean;
  /** 只读原因；可写时 Rust 侧省略该字段 */
  readonly readonlyReason?: string;
}

/**
 * 启动产物：内核 + 宿主窗口能力。
 * 窗口端口不进入内核上下文（内核不感知宿主 UI），由外壳的 Provider 单独注入。
 */
export interface BootedKernel extends Kernel {
  readonly window: WindowPort;
}

/**
 * 应用启动：库身份与只读标志来自 Rust（库锁在 Rust 侧获取），
 * 内核本身不感知二者来源。
 */
export const createKernel = async (): Promise<BootedKernel> => {
  // 机器本地 UI 状态（浮窗尺寸等）与库身份无关：注入端口后异步水合，失败只降级内存态。
  // 放在 vault_identity 之后，确保 Rust 侧已写好共享的 machine-id。
  attachMachineUiPort(createTauriMachineUiPort());

  const identity = await invoke<VaultIdentity>('vault_identity');
  const vaultId = asVaultId(identity.vaultId);
  if (vaultId === null) {
    throw new Error(`vault 身份非法：${identity.vaultId}`);
  }
  void hydrateMachineUi();

  const kernel = await bootKernel({
    vaultId,
    ports: {
      vault: createTauriVaultPort({
        readonlyMode: identity.readonly,
        readonlyReason: identity.readonlyReason ?? null,
      }),
    },
  });
  return { ...kernel, window: createTauriWindowPort() };
};
