import { invoke } from '@tauri-apps/api/core';
import type { VaultStatePort } from '../../kernel/ports.ts';
import { fromBase64, toBase64 } from './vault-port.ts';

/**
 * 库外状态端口的 Tauri 适配层（D4）。
 * 具体目录与键（settings.json 的 vault.id 优先，否则 sha256(规范化根路径)）
 * 由 Rust 侧解析，renderer 只传状态根下的相对路径。
 */
export const createTauriVaultStatePort = (): VaultStatePort => ({
  read: async (path) => {
    const payload = await invoke<string | null>('vault_state_read', { path });
    return payload === null ? null : fromBase64(payload);
  },

  write: async (path, bytes) => {
    await invoke('vault_state_write', { path, data: toBase64(bytes) });
  },

  list: async (path) => invoke<readonly string[]>('vault_state_list', { path }),

  purge: async (path) => {
    await invoke('vault_state_purge', { path });
  },
});
