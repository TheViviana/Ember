import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { unsafeVaultPath } from '#doc-model';
import type { VaultPort } from '../../kernel/ports.ts';
import type { Disposable, WriteIntent } from '../../kernel/types.ts';

interface RawStat {
  readonly mtime: string;
  readonly size: number;
}

interface RawScanEntry {
  readonly path: string;
  readonly kind: string;
  readonly size: number;
}

/** 分块转换：逐字符拼接大文件（图库上限见 `src-tauri/src/vault/media.rs::MAX_ASSET_BYTES`）会在主线程上明显卡顿 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export interface TauriVaultPortOptions {
  readonly readonlyMode: boolean;
  /** Rust vault_identity 给出的只读原因 */
  readonly readonlyReason?: string | null;
}

interface RawVaultEvent {
  readonly kind: 'created' | 'changed' | 'removed' | 'renamed' | 'overflow';
  readonly path?: string;
  readonly from?: string;
  readonly mtime?: number;
  readonly size?: number;
  readonly count?: number;
}

/**
 * Rust vault 的 IPC 适配层：原子写、库锁、watcher 全在 Rust 侧，
 * 这里只做字节编码与命令名映射。
 */
export const createTauriVaultPort = (options: TauriVaultPortOptions): VaultPort => {
  // 启动只读（被另一实例占用）与运行期熔断只读分开记录：
  // 解除熔断时不能误清启动只读。
  const startupReadonly = options.readonlyMode;
  const startupReason = options.readonlyReason ?? null;
  let runtimeReason: string | null = null;

  return {
    get readonlyMode() {
      return startupReadonly || runtimeReason !== null;
    },
    get readonlyReason() {
      return runtimeReason ?? startupReason;
    },
    setRuntimeReadonly(reason: string | null) {
      runtimeReason = reason;
    },

    read: async (path) => {
      const payload = await invoke<string | null>('vault_read', { path: String(path) });
      return payload === null ? null : fromBase64(payload);
    },

    write: async (path, bytes, intent: WriteIntent) => {
      await invoke('vault_write', { path: String(path), data: toBase64(bytes), intent });
    },

    remove: async (path) => {
      const destination = await invoke<'system' | 'internal' | null>('vault_remove', {
        path: String(path),
      });
      return destination;
    },

    // 仅供文章回滚与画布历史轮转；不注册为内核用户命令
    purge: async (path) => {
      await invoke('vault_purge', { path: String(path) });
    },

    rename: async (from, to) => {
      await invoke('vault_rename', { from: String(from), to: String(to) });
    },

    list: async () => {
      const paths = await invoke<readonly string[]>('vault_list');
      return paths.map((path) => unsafeVaultPath(path));
    },

    scan: async () => {
      const entries = await invoke<readonly RawScanEntry[]>('vault_scan');
      return entries.map((entry) => ({
        path: unsafeVaultPath(entry.path),
        kind: entry.kind === 'symlink' ? 'symlink' : 'file',
        size: entry.size,
      }));
    },

    listCanvases: async () => {
      const paths = await invoke<readonly string[]>('vault_list_canvases');
      return paths.map((path) => unsafeVaultPath(path));
    },

    stat: async (path) => {
      const stat = await invoke<RawStat | null>('vault_stat', { path: String(path) });
      return stat === null ? null : { mtime: stat.mtime, size: stat.size };
    },

    watch: (listener) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<RawVaultEvent>('vault://changed', (event) => {
        const payload = event.payload;
        if (payload.kind === 'overflow') {
          listener({ kind: 'overflow', count: payload.count ?? 0 });
          return;
        }
        if (payload.path === undefined) return;
        listener({
          kind: payload.kind,
          path: unsafeVaultPath(payload.path),
          ...(payload.from === undefined ? {} : { from: unsafeVaultPath(payload.from) }),
          ...(payload.mtime === undefined ? {} : { mtimeMs: payload.mtime }),
          ...(payload.size === undefined ? {} : { size: payload.size }),
        });
      })
        .then((fn) => {
          if (disposed) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch((error: unknown) => {
          console.error('订阅 vault://changed 失败', error);
        });

      const disposable: Disposable = {
        dispose: (): void => {
          disposed = true;
          unlisten?.();
          unlisten = null;
        },
      };
      return disposable;
    },
  };
};
