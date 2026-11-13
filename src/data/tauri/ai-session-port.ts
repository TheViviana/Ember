import { invoke } from '@tauri-apps/api/core';

/**
 * 机器本地 AI 会话（machines/<machineId>/ai/<vaultId>.json）的 Tauri 适配器。
 * 读写失败只降级为内存态，不阻塞对话与提案应用流程——AI 功能优先级远低于文档功能。
 */
export const createTauriAiSessionPort = () => ({
  read: async (vaultId: string): Promise<string | null> => {
    try {
      return await invoke<string | null>('machine_ai_read', { vaultId });
    } catch (error) {
      console.warn(
        'machine_ai_read 失败，AI 会话从空态开始：',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  },
  write: async (vaultId: string, json: string): Promise<void> => {
    try {
      await invoke('machine_ai_write', { vaultId, data: json });
    } catch (error) {
      console.warn(
        'machine_ai_write 失败，AI 会话暂存内存：',
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});

export type AiSessionPort = ReturnType<typeof createTauriAiSessionPort>;
