import { asDocId, asVaultId, isUlid, type DocId, type VaultId } from '#doc-model';
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

/** patch 里显式写 null 表示删除该 ui 键（画布被删时清掉主页固定 / 总览指向） */
const NULLABLE_UI_KEYS: readonly string[] = ['defaultCanvasId', 'overviewCanvasId'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defaultGrid = (): CanvasGrid => ({ size: 8, snap: true });

const defaultSettings = (vaultId: VaultId, vaultName: string, createdAt: string): VaultSettings => ({
  schemaVersion: 1,
  vault: { id: vaultId, name: vaultName, createdAt },
  ui: {
    canvasGrid: defaultGrid(),
    theme: 'ember-black',
  },
  linkOverrides: {},
});

/** 读取时只做归一化，不回写：未知键、未知 ui 键原样保留（P2） */
const normalizeSettings = (
  raw: unknown,
  fallback: VaultSettings,
  onDroppedOverride?: (key: string, value: string) => void,
): VaultSettings => {
  if (!isRecord(raw)) return fallback;

  const rawVault = isRecord(raw['vault']) ? raw['vault'] : {};
  const rawUi = isRecord(raw['ui']) ? raw['ui'] : {};
  const rawGrid = isRecord(rawUi['canvasGrid']) ? rawUi['canvasGrid'] : {};
  const size: CanvasGrid['size'] =
    GRID_SIZES.find((candidate) => candidate === rawGrid['size']) ?? 8;
  const snap = typeof rawGrid['snap'] === 'boolean' ? rawGrid['snap'] : true;
  const defaultCanvasId =
    typeof rawUi['defaultCanvasId'] === 'string' && rawUi['defaultCanvasId'].length > 0
      ? rawUi['defaultCanvasId']
      : undefined;
  const overviewCanvasId =
    typeof rawUi['overviewCanvasId'] === 'string' && rawUi['overviewCanvasId'].length > 0
      ? rawUi['overviewCanvasId']
      : undefined;
  const floatLimitRaw = rawUi['floatLimit'];
  const floatLimit =
    typeof floatLimitRaw === 'number' && Number.isFinite(floatLimitRaw)
      ? Math.min(Math.max(Math.trunc(floatLimitRaw), 1), 12)
      : undefined;
  // 老 settings.json 没有该键：缺省开启行号，保持既有观感
  const editorLineNumbers = rawUi['editorLineNumbers'] !== false;
  const recentCanvasIds = Array.isArray(rawUi['recentCanvasIds'])
    ? rawUi['recentCanvasIds']
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 10)
    : undefined;
  const toolFlag = (key: string): boolean | undefined => {
    const value = rawUi[key];
    return typeof value === 'boolean' ? value : undefined;
  };

  const linkOverrides: Record<string, DocId> = {};
  if (isRecord(raw['linkOverrides'])) {
    for (const [key, value] of Object.entries(raw['linkOverrides'])) {
      if (typeof value !== 'string') continue;
      const docId = asDocId(value);
      if (docId !== null) {
        linkOverrides[key] = docId;
        continue;
      }
      // 旧方案（path 之前）里 DocId 是 ULID：迁移与回滚都要看到原值，
      // 这里只做类型放宽，不改写磁盘；映射不到唯一文档的条目由迁移层丢弃（D5）。
      if (isUlid(value)) {
        linkOverrides[key] = value as unknown as DocId;
        continue;
      }
      onDroppedOverride?.(key, value);
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
    ui: {
      ...rawUi,
      canvasGrid: { size, snap },
      theme: 'ember-black',
      ...(defaultCanvasId === undefined ? {} : { defaultCanvasId }),
      ...(overviewCanvasId === undefined ? {} : { overviewCanvasId }),
      ...(floatLimit === undefined ? {} : { floatLimit }),
      editorLineNumbers,
      ...(recentCanvasIds === undefined ? {} : { recentCanvasIds }),
      ...(() => {
        const flags: Record<string, boolean> = {};
        for (const key of ['toolPomodoro', 'toolGallery'] as const) {
          const value = toolFlag(key);
          if (value !== undefined) flags[key] = value;
        }
        return flags;
      })(),
    },
    linkOverrides,
  };
};

/** 迁移写回时需要删除可选键 `docIdScheme`，只读类型得先放宽一次 */
type MutableSettings = { -readonly [K in keyof VaultSettings]: VaultSettings[K] };

/** 原始磁盘对象：迁移写回只动两个键，不做归一化回写（库内可能跟着 iCloud 同步） */
const readRawSettings = async (read: () => Promise<Uint8Array | null>): Promise<Record<string, unknown> | null> => {
  const bytes = await read();
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const mergePatch = (current: VaultSettings, patch: SettingsPatch): VaultSettings => {
  const uiPatch = patch.ui ?? {};
  const grid = uiPatch.canvasGrid;
  const mergedUi: Record<string, unknown> = { ...current.ui, ...uiPatch };
  // 可空键的 null = 删除该键（不是把 null 存进 JSON）
  for (const key of NULLABLE_UI_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(uiPatch, key) &&
      (uiPatch as Record<string, unknown>)[key] === null
    ) {
      delete mergedUi[key];
    }
  }
  return {
    ...current,
    // mergedUi 以 Record 展开会抹掉已知键的字面类型；设置读取方每次都会重读磁盘并
    // 走 normalizeSettings 归一，这里的形态由 normalizeSettings 保证，收口为一次窄断言。
    ui: {
      ...mergedUi,
      canvasGrid: grid === undefined ? current.ui.canvasGrid : { ...current.ui.canvasGrid, ...grid },
    } as VaultSettings['ui'],
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
    return normalizeSettings(parsed, fallback(), (key, value) => {
      options.log.warn('linkOverrides 指向的旧 id 无法解析为文档路径，已丢弃', { key, value });
    });
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
        throw new EmberError('vault_locked', '库为只读，写操作被拒绝（原因见状态栏）', {
          reason: options.port.readonlyReason,
        });
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

    applyDocIdScheme: async ({ linkOverrides, scheme }) => {
      if (options.port.readonlyMode) {
        throw new EmberError('vault_locked', '库为只读，写操作被拒绝（原因见状态栏）', {
          reason: options.port.readonlyReason,
        });
      }
      const chained: Promise<VaultSettings> = writing.then(async () => {
        // 只改 linkOverrides 与 docIdScheme：迁移不应把归一化默认值（ui 等）
        // 顺手写进用户的 settings.json，库可能位于 iCloud 且会被同步。
        const raw = await readRawSettings(() => options.port.read(path));
        const base: Record<string, unknown> = raw ?? fallback();
        const next = {
          ...base,
          // 整表替换：迁移可能丢弃映射不到的旧 ULID，merge 语义做不到删除
          linkOverrides: { ...linkOverrides },
        } as MutableSettings;
        if (scheme === 'path') next.docIdScheme = 'path';
        else delete next.docIdScheme;
        await persistWrite(next);
        // 缓存按 VaultSettings 形态重建；磁盘上的原始键序不受影响
        cached = normalizeSettings(next, fallback());
        publish(cached);
        return cached;
      });
      writing = chained.then(
        () => undefined,
        (error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          lastFailure = new EmberError('io_failed', `身份方案写入失败：${detail}`);
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
