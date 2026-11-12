import { asDocId, asVaultId, type DocId, type VaultId } from '#doc-model';
import { EmberError } from './errors.ts';
import type { EventBus } from './events.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
import type {
  CanvasGrid,
  Disposable,
  Logger,
  SettingsPatch,
  SettingsService,
  VaultSettings,
} from './types.ts';

export interface SettingsServiceOptions {
  readonly port: VaultPort;
  readonly paths: PathTools;
  readonly events: EventBus;
  readonly log: Logger;
  readonly vaultId: VaultId;
  readonly vaultName?: string;
  readonly now?: () => Date;
}

const SETTINGS_PATH = '.workbench/settings.json';
const GRID_SIZES: readonly CanvasGrid['size'][] = [8, 16, 32];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultGrid = (): CanvasGrid => ({ size: 8, snap: true });

const defaultSettings = (vaultId: VaultId, vaultName: string, createdAt: string): VaultSettings => ({
  schemaVersion: 1,
  vault: { id: vaultId, name: vaultName, createdAt },
  capabilities: {},
  ui: {
    defaultView: 'canvas',
    sidebar: 'auto',
    canvasGrid: defaultGrid(),
    theme: 'ember-black',
  },
  linkOverrides: {},
});

const normalizeCapabilities = (
  raw: unknown,
): Readonly<Record<string, { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> }>> => {
  if (!isRecord(raw)) return {};
  const out: Record<string, { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> }> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value['enabled'] !== 'boolean') continue;
    out[key] = {
      enabled: value['enabled'],
      config: isRecord(value['config']) ? value['config'] : {},
    };
  }
  return out;
};

/** 读取时只做归一化，不回写：未知键、未知 ui 键原样保留（P2） */
const normalizeSettings = (raw: unknown, fallback: VaultSettings): VaultSettings => {
  if (!isRecord(raw)) return fallback;

  const rawVault = isRecord(raw['vault']) ? raw['vault'] : {};
  const rawUi = isRecord(raw['ui']) ? raw['ui'] : {};
  const sidebar = rawUi['sidebar'] === 'off' ? 'off' : 'auto';
  const rawGrid = isRecord(rawUi['canvasGrid']) ? rawUi['canvasGrid'] : {};
  const size: CanvasGrid['size'] =
    GRID_SIZES.find((candidate) => candidate === rawGrid['size']) ?? 8;
  const snap = typeof rawGrid['snap'] === 'boolean' ? rawGrid['snap'] : true;
  const defaultCanvasId =
    typeof rawUi['defaultCanvasId'] === 'string' ? rawUi['defaultCanvasId'] : undefined;

  const linkOverrides: Record<string, DocId> = {};
  if (isRecord(raw['linkOverrides'])) {
    for (const [key, value] of Object.entries(raw['linkOverrides'])) {
      const docId = typeof value === 'string' ? asDocId(value) : null;
      if (docId !== null) linkOverrides[key] = docId;
    }
  }

  return {
    ...raw,
    schemaVersion: 1,
    vault: {
      id: typeof rawVault['id'] === 'string' ? (asVaultId(rawVault['id']) ?? fallback.vault.id) : fallback.vault.id,
      name: typeof rawVault['name'] === 'string' ? rawVault['name'] : fallback.vault.name,
      createdAt:
        typeof rawVault['createdAt'] === 'string' ? rawVault['createdAt'] : fallback.vault.createdAt,
    },
    capabilities: normalizeCapabilities(raw['capabilities']),
    ui: {
      ...rawUi,
      defaultView: rawUi['defaultView'] === 'editor' ? 'editor' : 'canvas',
      sidebar,
      canvasGrid: { size, snap },
      theme: 'ember-black',
      ...(defaultCanvasId === undefined ? {} : { defaultCanvasId }),
    },
    linkOverrides,
  };
};

const mergeCapabilities = (
  current: VaultSettings['capabilities'],
  patch: SettingsPatch['capabilities'],
): VaultSettings['capabilities'] => {
  const out: Record<string, { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> }> = {
    ...current,
  };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const base = current[key] ?? { enabled: false, config: {} };
    out[key] = {
      enabled: value.enabled ?? base.enabled,
      config: value.config ?? base.config,
    };
  }
  return out;
};

const mergePatch = (current: VaultSettings, patch: SettingsPatch): VaultSettings => {
  const uiPatch = patch.ui ?? {};
  const grid = uiPatch.canvasGrid;
  return {
    ...current,
    capabilities: mergeCapabilities(current.capabilities, patch.capabilities),
    ui: {
      ...current.ui,
      ...uiPatch,
      canvasGrid: grid === undefined ? current.ui.canvasGrid : { ...current.ui.canvasGrid, ...grid },
    },
    linkOverrides: {
      ...current.linkOverrides,
      ...(patch.linkOverrides ?? {}),
    },
  };
};

/**
 * `.workbench/settings.json` 的唯一读写方（vault-format §8.1）。
 * 一次 patch = 一次原子写；写入串行排队，读缓存，只读模式拒绝写入。
 */
export const createSettingsService = (options: SettingsServiceOptions): SettingsService => {
  const path = options.paths.normalize(SETTINGS_PATH);
  const listeners = new Set<(next: VaultSettings) => void>();
  const now = options.now ?? ((): Date => new Date());
  let cached: VaultSettings | null = null;
  let writing: Promise<void> = Promise.resolve();
  /** 自上次 flush 以来最近一次写入失败；flush 抛出一次后清空，不毒化队列 */
  let lastFailure: EmberError | null = null;

  const fallback = (): VaultSettings =>
    defaultSettings(options.vaultId, options.vaultName ?? 'Ember Vault', now().toISOString());

  /** 从磁盘读取并归一化：patch 每次都要重读，避免外部改动被缓存覆盖 */
  const readFromDisk = async (): Promise<VaultSettings> => {
    const bytes = await options.port.read(path);
    if (bytes === null) return fallback();
    const text = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      options.log.warn('settings.json 解析失败，使用默认设置（不覆盖磁盘）', { path: String(path) });
      return fallback();
    }
    return normalizeSettings(parsed, fallback());
  };

  const load = async (): Promise<VaultSettings> => {
    if (cached !== null) return cached;
    cached = await readFromDisk();
    return cached;
  };

  /** 队列内的裸写：串行化由 patch 的整体排队保证，此处不得再自行链队（会死锁） */
  const persistWrite = (next: VaultSettings): Promise<void> =>
    options.port.write(
      path,
      new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
      'system',
    );

  const publish = (next: VaultSettings): void => {
    options.events.emit('settings:changed', { settings: next });
    for (const listener of [...listeners]) listener(next);
  };

  return {
    read: load,

    patch: async (patch) => {
      if (options.port.readonlyMode) {
        throw new EmberError('vault_locked', '只读模式下不能修改库设置');
      }
      // 读-改-写必须整体入队：两个并发 patch 若都从旧缓存 merge，后落盘者会覆盖先落盘者
      // （丢更新）。入队后 load/merge/persist 严格串行，cached 也只在队列内推进。
      const chained: Promise<VaultSettings> = writing.then(async () => {
        // 队列内强制重读磁盘：用户/外部工具刚改过 settings.json 时，
        // 基于旧缓存 merge 会把外部修改整段覆盖掉。
        const current = await readFromDisk();
        const next = mergePatch(current, patch);
        await persistWrite(next);
        cached = next;
        publish(next);
        return next;
      });
      // 失败不阻断队列：本次 patch 向调用方抛错，后续 patch 照常推进；
      // 同时记下失败，让 flush 能把「队列已排空但没落盘」报给关窗流程。
      const fields = Object.keys(patch).join(', ') || '空补丁';
      writing = chained.then(
        () => undefined,
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          lastFailure = new EmberError('io_failed', `设置写入失败（${fields}）：${detail}`);
        },
      );
      return chained;
    },

    watch: (listener) => {
      listeners.add(listener);
      return {
        dispose: (): void => {
          listeners.delete(listener);
        },
      } satisfies Disposable;
    },

    flush: async () => {
      await writing;
      const failure = lastFailure;
      lastFailure = null;
      if (failure !== null) throw failure;
    },
  };
};
