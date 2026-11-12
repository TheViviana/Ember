import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { unsafeVaultPath } from '#doc-model';
import type { VaultFileEvent, VaultPort } from '../../kernel/ports.ts';
import type { Disposable, WriteIntent } from '../../kernel/types.ts';

interface RawStat {
  readonly mtime: string;
  readonly size: number;
}

/** 分块转换：逐字符拼接大文件（图库上限 20MB）会在主线程上明显卡顿 */
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

/**
 * Rust vault 的 IPC 适配层：journal 两阶段、库锁、watcher 全在 Rust 侧，
 * 这里只做字节编码与命令名映射。
 */
export const createTauriVaultPort = (options: TauriVaultPortOptions): VaultPort => {
  // 运行期锁被接管后由 vault://mode 翻转；各内核服务每次写入时读这个值
  let readonly = options.readonlyMode;
  let readonlyReason = options.readonlyReason ?? null;

  return {
    get readonlyMode() {
      return readonly;
    },

    get readonlyReason() {
      return readonlyReason;
    },

    read: async (path) => {
      const payload = await invoke<string | null>('vault_read', { path: String(path) });
      return payload === null ? null : fromBase64(payload);
    },

    write: async (path, bytes, intent: WriteIntent) => {
      await invoke('vault_write', { path: String(path), data: toBase64(bytes), intent });
    },

    remove: async (path) => {
      await invoke('vault_remove', { path: String(path) });
    },

    // 回滚内部使用：不注册为命令（core.doc.purge 仍为 v1 未实现）
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

    stat: async (path) => {
      const stat = await invoke<RawStat | null>('vault_stat', { path: String(path) });
      return stat === null ? null : { mtime: stat.mtime, size: stat.size };
    },

    watch: (listener) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<{ kind: VaultFileEvent['kind']; path: string; from?: string }>(
        'vault://changed',
        (event) => {
          listener({
            kind: event.payload.kind,
            path: unsafeVaultPath(event.payload.path),
            ...(event.payload.from === undefined
              ? {}
              : { from: unsafeVaultPath(event.payload.from) }),
          });
        },
      )
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

    watchMode: (listener) => {
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen<{ readonly: boolean; reason: string | null }>('vault://mode', (event) => {
        readonly = event.payload.readonly;
        readonlyReason = event.payload.reason;
        listener(event.payload);
      })
        .then((fn) => {
          if (disposed) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch((error: unknown) => {
          console.error('订阅 vault://mode 失败', error);
        });

      return {
        dispose: (): void => {
          disposed = true;
          unlisten?.();
          unlisten = null;
        },
      } satisfies Disposable;
    },
  };
};
