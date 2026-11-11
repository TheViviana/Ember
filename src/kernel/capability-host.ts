import type { CapabilityId } from '#doc-model';
import type { CommandBusHost } from './command-bus.ts';
import type { KernelContext } from './context.ts';
import { EmberError, toErrorText } from './errors.ts';
import type { EventBus } from './events.ts';
import type { CapabilityManifest, CapabilityState, Disposable, Logger } from './types.ts';

export interface CapabilityModule {
  readonly manifest: CapabilityManifest;
  /** 只在这里注册命令/装饰槽/图层；不得把 ctx 存到模块级变量（G3） */
  activate(ctx: KernelContext): void | Promise<void>;
}

export interface CapabilityHost {
  register(module: CapabilityModule): Disposable;
  activate(id: CapabilityId): Promise<void>;
  deactivate(id: CapabilityId): Promise<void>;
  /** 运行期开关：更新 enabled 并立即激活/停用；持久化由调用方写 settings（C7） */
  setEnabled(id: CapabilityId, enabled: boolean): Promise<void>;
  isActive(id: CapabilityId): boolean;
  list(): readonly CapabilityState[];
  watch(listener: (state: CapabilityState) => void): Disposable;
}

/** 内核内部使用；负责装配顺序校验与整体停用 */
export interface CapabilityHostInternal extends CapabilityHost {
  /** 校验 dependsOn 无环且都已注册（C3），失败抛 capability_failed */
  validate(): void;
  /** 拓扑序（依赖在前），供 boot 依次激活 */
  activationOrder(): readonly CapabilityId[];
  deactivateAll(): Promise<void>;
}

export interface CapabilityHostOptions {
  readonly kernelVersion: string;
  readonly events: EventBus;
  readonly log: Logger;
  /** settings.json 的开关由 host 读取，能力自己不解析设置文件（C7） */
  readonly isEnabled?: (id: CapabilityId) => boolean | undefined;
  readonly createContext: (
    module: CapabilityModule,
    track: (disposable: Disposable) => Disposable,
  ) => KernelContext;
  readonly commands: CommandBusHost;
}

interface ModuleEntry {
  readonly module: CapabilityModule;
  enabled: boolean;
  active: boolean;
  error: string | null;
  readonly disposables: Disposable[];
}

const parseVersion = (value: string): readonly (number | null)[] => {
  const parts = value.trim().split('.');
  const parsed: (number | null)[] = [];
  for (const part of parts.slice(0, 3)) {
    if (part === 'x' || part === '*' || part === '') {
      parsed.push(null);
    } else {
      const numeric = Number.parseInt(part, 10);
      parsed.push(Number.isNaN(numeric) ? null : numeric);
    }
  }
  while (parsed.length < 3) parsed.push(null);
  return parsed;
};

const comparePrefix = (
  actual: readonly (number | null)[],
  expected: readonly (number | null)[],
): number => {
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i] ?? null;
    if (want === null) continue;
    const got = actual[i] ?? null;
    if (got === null) return -1;
    if (got !== want) return got < want ? -1 : 1;
  }
  return 0;
};

/** v1 只需判断「是否满足 1.x」；这里实现子集：`*`、`^`、`~`、比较符、空格分隔的 AND */
const satisfiesRange = (version: string, range: string): boolean => {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return true;
  const actual = parseVersion(version);
  for (const part of trimmed.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(part);
    if (match === null) return false;
    const operator = match[1] ?? '=';
    const expected = parseVersion(match[2] ?? '');
    const order = comparePrefix(actual, expected);
    if (operator === '=' && order !== 0) return false;
    if (operator === '>=' && order < 0) return false;
    if (operator === '<=' && order > 0) return false;
    if (operator === '>' && order <= 0) return false;
    if (operator === '<' && order >= 0) return false;
    if (operator === '^' && (order < 0 || actual[0] !== expected[0])) return false;
    if (operator === '~' && (order < 0 || actual[0] !== expected[0] || actual[1] !== expected[1])) {
      return false;
    }
  }
  return true;
};

export const createCapabilityHost = (options: CapabilityHostOptions): CapabilityHostInternal => {
  const { events, log, commands } = options;
  const entries = new Map<string, ModuleEntry>();
  const watchers = new Set<(state: CapabilityState) => void>();

  const stateOf = (entry: ModuleEntry): CapabilityState => ({
    id: entry.module.manifest.id,
    displayName: entry.module.manifest.displayName,
    description: entry.module.manifest.description ?? null,
    enabled: entry.enabled,
    active: entry.active,
    error: entry.error,
  });

  const notify = (entry: ModuleEntry): void => {
    const state = stateOf(entry);
    events.emit('capability:state', { id: state.id, active: state.active, error: state.error });
    for (const watcher of [...watchers]) watcher(state);
  };

  const requireEntry = (id: CapabilityId): ModuleEntry => {
    const entry = entries.get(String(id));
    if (entry === undefined) {
      throw new EmberError('capability_failed', `能力未注册：${String(id)}`);
    }
    return entry;
  };

  const activationOrder = (): readonly CapabilityId[] => {
    const visited = new Set<string>();
    const order: CapabilityId[] = [];
    const visit = (key: string, trail: string[]): void => {
      if (visited.has(key)) return;
      if (trail.includes(key)) {
        throw new EmberError('capability_failed', `能力依赖成环：${[...trail, key].join(' → ')}`);
      }
      const entry = entries.get(key);
      if (entry === undefined) {
        throw new EmberError('capability_failed', `依赖的能力未注册：${key}`);
      }
      for (const dependency of entry.module.manifest.dependsOn ?? []) {
        visit(String(dependency), [...trail, key]);
      }
      visited.add(key);
      order.push(entry.module.manifest.id);
    };
    for (const key of [...entries.keys()].sort()) visit(key, []);
    return order;
  };

  const release = (entry: ModuleEntry): void => {
    while (entry.disposables.length > 0) {
      const disposable = entry.disposables.pop();
      try {
        disposable?.dispose();
      } catch (error) {
        log.error('释放能力资源失败', { id: String(entry.module.manifest.id), error: toErrorText(error) });
      }
    }
  };

  const activateEntry = async (entry: ModuleEntry, trail: Set<string>): Promise<void> => {
    const { manifest } = entry.module;
    if (entry.active) return;
    if (trail.has(String(manifest.id))) {
      throw new EmberError('capability_failed', `能力依赖成环：${[...trail, String(manifest.id)].join(' → ')}`);
    }
    trail.add(String(manifest.id));

    if (!satisfiesRange(options.kernelVersion, manifest.requiresKernel)) {
      entry.error = `capability_failed: 需要内核 ${manifest.requiresKernel}，当前 ${options.kernelVersion}`;
      notify(entry);
      log.warn('能力与内核版本不兼容，已跳过激活', { id: String(manifest.id) });
      return;
    }

    for (const dependency of manifest.dependsOn ?? []) {
      const depEntry = requireEntry(dependency);
      if (!depEntry.active) await activateEntry(depEntry, trail);
      if (!depEntry.active) {
        entry.error = `capability_failed: 依赖 ${String(dependency)} 未激活`;
        notify(entry);
        return;
      }
    }

    const track = (disposable: Disposable): Disposable => {
      entry.disposables.push(disposable);
      return disposable;
    };

    try {
      const scoped = options.createContext(entry.module, track);
      await commands.withOwner(manifest.id, async () => {
        await entry.module.activate(scoped);
      });
      entry.active = true;
      entry.error = null;
      notify(entry);
    } catch (error) {
      release(entry);
      entry.active = false;
      entry.error = toErrorText(error);
      notify(entry);
      log.error('能力激活失败', { id: String(manifest.id), error: entry.error });
    } finally {
      trail.delete(String(manifest.id));
    }
  };

  const deactivateEntry = async (entry: ModuleEntry): Promise<void> => {
    if (!entry.active) return;
    const key = String(entry.module.manifest.id);
    const dependents = [...entries.values()].filter(
      (candidate) =>
        candidate.active &&
        (candidate.module.manifest.dependsOn ?? []).some((dependency) => String(dependency) === key),
    );
    for (const dependent of dependents) await deactivateEntry(dependent);
    release(entry);
    entry.active = false;
    entry.error = null;
    notify(entry);
  };

  return {
    register: (module) => {
      const key = String(module.manifest.id);
      if (entries.has(key)) {
        throw new EmberError('duplicate_capability', `能力 id 重复：${key}`);
      }
      const enabled = options.isEnabled?.(module.manifest.id) ?? module.manifest.defaultEnabled;
      const entry: ModuleEntry = { module, enabled, active: false, error: null, disposables: [] };
      entries.set(key, entry);
      return {
        dispose: (): void => {
          release(entry);
          entries.delete(key);
        },
      };
    },

    activate: async (id) => {
      await activateEntry(requireEntry(id), new Set());
    },

    deactivate: async (id) => {
      await deactivateEntry(requireEntry(id));
    },

    setEnabled: async (id, enabled) => {
      const entry = requireEntry(id);
      entry.enabled = enabled;
      if (enabled) {
        await activateEntry(entry, new Set());
      } else {
        await deactivateEntry(entry);
      }
      notify(entry);
    },

    isActive: (id) => entries.get(String(id))?.active ?? false,

    list: () =>
      [...entries.values()]
        .map(stateOf)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),

    watch: (listener) => {
      watchers.add(listener);
      return {
        dispose: (): void => {
          watchers.delete(listener);
        },
      };
    },

    validate: () => {
      activationOrder();
    },

    activationOrder,

    deactivateAll: () => {
      const order = activationOrder();
      for (const id of [...order].reverse()) {
        const entry = entries.get(String(id));
        if (entry === undefined || !entry.active) continue;
        release(entry);
        entry.active = false;
        entry.error = null;
        notify(entry);
      }
      return Promise.resolve();
    },
  };
};
