import type { ArticlesFacade } from './article-service.ts';
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

/**
 * 能力能看到的全部内核面（G1）。版本规则见 `KERNEL_VERSION`（kernel-contract §12）：
 * - 新增字段或服务方法 → minor 位 +1；
 * - 删除字段或改变已有字段语义 → major 位 +1；
 * - 纯 bug 修复、接口不变 → patch 位 +1。
 *
 * 新增字段时，**所有 `KernelContext` 构造点必须同步**（boot.ts 的 createKernelContext、
 * 测试里的 stubContext/scopeContext 桩等）；不补就是类型错误，不得用可选字段或类型断言绕过。
 */
export interface KernelContext {
  readonly env: KernelEnv;
  readonly docs: DocService;
  /** 文章门面：内部持有带 purge 的文档服务，调用方只看到用户语义 */
  readonly articles: ArticlesFacade;
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
  readonly articles: ArticlesFacade;
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
    flush: () => base.settings.flush(),
  },
  events: {
    emit: (type, payload) => base.events.emit(type, payload),
    on: (type, handler) => track(base.events.on(type, handler)),
  },
  extend: <T>(slot: ExtensionSlot<T>, value: T): Disposable => track(base.extend(slot, value)),
});
