import { isCommandId, type CapabilityId, type CommandId, type DocId } from '#doc-model';
import type { KernelContext } from './context.ts';
import { EmberError, toErrorText } from './errors.ts';
import type { EventBus } from './events.ts';
import type { CommandDescriptor, Disposable } from './types.ts';

export type CommandScope = 'global' | 'editor' | 'canvas';

export interface CommandContext {
  readonly kernel: KernelContext;
  readonly docId: DocId | null;
  readonly surface: CommandScope;
}

export interface KeyBinding {
  /** CodeMirror keymap 语法，例 "Mod-Shift-k" */
  readonly key: string;
  readonly scope: CommandScope;
}

export interface Command<Args = void> {
  readonly id: CommandId;
  readonly title: string;
  readonly scope: CommandScope;
  readonly keybinding?: KeyBinding;
  /** 仅用于命令面板过滤，不得用于权限控制 */
  readonly when?: (ctx: CommandContext) => boolean;
  run(args: Args, ctx: CommandContext): void | Promise<void>;
}

export interface CommandResult {
  readonly id: CommandId;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface CommandBus {
  register<Args>(command: Command<Args>): Disposable;
  execute(id: CommandId, args?: unknown): Promise<CommandResult>;
  list(): readonly CommandDescriptor[];
  watch(listener: (descriptors: readonly CommandDescriptor[]) => void): Disposable;
}

/** 内核内部使用的命令总线能力；不暴露给能力 */
export interface CommandBusHost extends CommandBus {
  /** 能力激活期间建立 owner 作用域（K4）；激活是串行的，因此作用域不会交叉 */
  withOwner<T>(owner: CapabilityId | null, run: () => T | Promise<T>): Promise<T>;
  bindKernel(resolve: () => KernelContext): void;
  /** 当前活动文档/表面，由 shell 在切换焦点时写入 */
  setSurface(surface: CommandScope, docId: DocId | null): void;
}

interface Registration {
  readonly command: Command<unknown>;
  readonly owner: CapabilityId | null;
  disposed: boolean;
}

export interface CommandBusOptions {
  readonly events?: EventBus;
}

const assertCommandId = (id: CommandId): void => {
  if (!isCommandId(String(id))) {
    throw new EmberError('invalid_command_id', `命令 id 必须形如 <namespace>.<verb>：${String(id)}`);
  }
};

export const createCommandBus = (options: CommandBusOptions = {}): CommandBusHost => {
  const registrations = new Map<string, Registration>();
  const watchers = new Set<(descriptors: readonly CommandDescriptor[]) => void>();
  const inFlight = new Set<string>();

  let resolveKernel: (() => KernelContext) | null = null;
  let ownerScope: CapabilityId | null = null;
  let surface: CommandScope = 'global';
  let surfaceDocId: DocId | null = null;

  const descriptors = (): readonly CommandDescriptor[] => {
    const list: CommandDescriptor[] = [];
    for (const registration of registrations.values()) {
      const { command, owner } = registration;
      list.push({
        id: command.id,
        title: command.title,
        scope: command.scope,
        keybinding: command.keybinding ?? null,
        owner,
      });
    }
    return list.sort((left, right) => {
      const leftOwner = left.owner === null ? '' : String(left.owner);
      const rightOwner = right.owner === null ? '' : String(right.owner);
      return leftOwner.localeCompare(rightOwner) || String(left.id).localeCompare(String(right.id));
    });
  };

  const notify = (): void => {
    const snapshot = descriptors();
    for (const watcher of [...watchers]) watcher(snapshot);
  };

  const execute = async (id: CommandId, args?: unknown): Promise<CommandResult> => {
    const registration = registrations.get(String(id));
    if (registration === undefined) {
      options.events?.emit('command:executed', { id, ok: false });
      return { id, ok: false, error: `command_not_found: 未注册的命令 ${String(id)}` };
    }
    if (inFlight.has(String(id))) {
      options.events?.emit('command:executed', { id, ok: false });
      return { id, ok: false, error: `command_reentrant: 命令 ${String(id)} 正在执行` };
    }
    if (resolveKernel === null) {
      options.events?.emit('command:executed', { id, ok: false });
      return { id, ok: false, error: 'not_implemented: 命令总线尚未绑定内核上下文' };
    }

    const context: CommandContext = { kernel: resolveKernel(), docId: surfaceDocId, surface };
    inFlight.add(String(id));
    try {
      await registration.command.run(args, context);
      options.events?.emit('command:executed', { id, ok: true });
      return { id, ok: true, error: null };
    } catch (error) {
      options.events?.emit('command:executed', { id, ok: false });
      return { id, ok: false, error: toErrorText(error) };
    } finally {
      inFlight.delete(String(id));
    }
  };

  const register = <Args>(command: Command<Args>): Disposable => {
    assertCommandId(command.id);
    const key = String(command.id);
    if (registrations.has(key)) {
      throw new EmberError('duplicate_command', `命令 id 已被占用：${key}`);
    }
    const registration: Registration = {
      command,
      owner: ownerScope,
      disposed: false,
    };
    registrations.set(key, registration);
    notify();

    return {
      dispose: (): void => {
        if (registration.disposed) return;
        registration.disposed = true;
        registrations.delete(key);
        notify();
      },
    };
  };

  return {
    register,
    execute,
    list: descriptors,
    watch: (listener) => {
      watchers.add(listener);
      return {
        dispose: (): void => {
          watchers.delete(listener);
        },
      };
    },
    withOwner: async (owner, run) => {
      const previous = ownerScope;
      ownerScope = owner;
      try {
        return await run();
      } finally {
        ownerScope = previous;
      }
    },
    bindKernel: (resolve) => {
      resolveKernel = resolve;
    },
    setSurface: (nextSurface, docId) => {
      surface = nextSurface;
      surfaceDocId = docId;
    },
  };
};
