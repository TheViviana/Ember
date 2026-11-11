import { invoke } from '@tauri-apps/api/core';
import type { MachineUiPort } from '../../kernel/ports.ts';

/**
 * 机器本地 ui.json 的 Tauri 适配器。
 * 读写失败（例如在纯浏览器里跑 Vite）只降级为内存态，不影响文档与画布功能。
 */
export const createTauriMachineUiPort = (): MachineUiPort => ({
  read: async () => {
    try {
      return await invoke<string | null>('machine_ui_read');
    } catch (error) {
      console.warn(
        'machine_ui_read 失败，浮窗尺寸使用默认值：',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  },
  write: async (json) => {
    try {
      await invoke('machine_ui_write', { data: json });
    } catch (error) {
      console.warn(
        'machine_ui_write 失败，浮窗尺寸暂存内存：',
        error instanceof Error ? error.message : String(error),
      );
    }
  },
});
