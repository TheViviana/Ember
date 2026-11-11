import type { CanvasHost } from './canvas-host.ts';
import type { CapabilityHost } from './capability-host.ts';
import type { CommandBus } from './command-bus.ts';
import type { DocService } from './doc-service.ts';
import type { EditorHost } from './editor-host.ts';
import type { EventBus } from './events.ts';
import { EmberError } from './errors.ts';
import type { IndexService } from './index-service.ts';
import type { PathTools } from './paths.ts';
import type { Disposable, ExtensionSlot, KernelEnv, Logger, SettingsService } from './types.ts';

/** 能力能看到的全部内核面（G1）。新增字段即破坏性变更，需升 KERNEL_VERSION */
export interface KernelContext {
  readonly env: KernelEnv;
  readonly docs: DocService;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly editor: EditorHost;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
  readonly capabilities: CapabilityHost;
  readonly events: EventBus;
  readonly log: Logger;
  readonly paths: PathTools;
  extend<T>(slot: ExtensionSlot<T>, value: T): Disposable;
}

export interface KernelServices {
  readonly env: KernelEnv;
  readonly docs: DocService;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly editor: EditorHost;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
  readonly capabilities: CapabilityHost;
  readonly events: EventBus;
  readonly log: Logger;
  readonly paths: PathTools;
}

export const createKernelContext = (services: KernelServices): KernelContext => {
  const slots = new Map<string, unknown>();
  return {
    ...services,
    extend: <T>(slot: ExtensionSlot<T>, value: T): Disposable => {
      if (slots.has(slot.id)) {
        throw new EmberError('duplicate_extension', `扩展槽已被占用：${slot.id}`);
      }
      slots.set(slot.id, value);
      return {
        dispose: (): void => {
          slots.delete(slot.id);
        },
      };
    },
  };
};

/**
 * 能力激活期的上下文代理：把所有返回 Disposable 的注册动作记到能力的清理栈里（C5），
 * 能力不需要自己维护清理列表（I7）。
 */
export const scopeContext = (
  base: KernelContext,
  track: (disposable: Disposable) => Disposable,
): KernelContext => ({
  ...base,
  commands: {
    register: (command) => track(base.commands.register(command)),
    execute: (id, args) => base.commands.execute(id, args),
    list: () => base.commands.list(),
    watch: (listener) => track(base.commands.watch(listener)),
  },
  editor: {
    open: (docId) => base.editor.open(docId),
    active: () => base.editor.active(),
    extend: (extension) => track(base.editor.extend(extension)),
    registerDecorationSlot: (slot) => track(base.editor.registerDecorationSlot(slot)),
  },
  canvas: {
    list: () => base.canvas.list(),
    create: (input) => base.canvas.create(input),
    open: (id) => base.canvas.open(id),
    ensureDefault: () => base.canvas.ensureDefault(),
    apply: (id, ops) => base.canvas.apply(id, ops),
    registerLayer: (layer) => track(base.canvas.registerLayer(layer)),
    registerNodeKind: (spec) => track(base.canvas.registerNodeKind(spec)),
    flush: () => base.canvas.flush(),
  },
  settings: {
    read: () => base.settings.read(),
    patch: (patch) => base.settings.patch(patch),
    watch: (listener) => track(base.settings.watch(listener)),
  },
  events: {
    emit: (type, payload) => base.events.emit(type, payload),
    on: (type, handler) => track(base.events.on(type, handler)),
  },
  extend: <T>(slot: ExtensionSlot<T>, value: T): Disposable => track(base.extend(slot, value)),
});
