import type { CanvasHost } from './canvas-host.ts';
import type { CommandBus } from './command-bus.ts';
import type { DocService } from './doc-service.ts';
import type { EventBus } from './events.ts';
import { EmberError } from './errors.ts';
import type { FolderService } from './folder-service.ts';
import type { HealthService } from './health-service.ts';
import type { IndexService } from './index-service.ts';
import type { PathTools } from './paths.ts';
import type { Disposable, ExtensionSlot, KernelEnv, Logger, SettingsService } from './types.ts';

/**
 * shell 能看到的全部内核面。版本规则见 `KERNEL_VERSION`（kernel-contract 头注）：
 * - 新增字段或服务方法 → minor 位 +1；
 * - 删除字段或改变已有字段语义 → major 位 +1；
 * - 纯 bug 修复、接口不变 → patch 位 +1。
 *
 * 新增字段时，**所有 `KernelContext` 构造点必须同步**（boot.ts 的 createKernelContext、
 * 测试里的 stubContext 桩等）；不补就是类型错误，不得用可选字段或类型断言绕过。
 */
export interface KernelContext {
  readonly env: KernelEnv;
  readonly docs: DocService;
  readonly folders: FolderService;
  readonly health: HealthService;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
  readonly events: EventBus;
  readonly log: Logger;
  readonly paths: PathTools;
  extend<T>(slot: ExtensionSlot<T>, value: T): Disposable;
}

export interface KernelServices {
  readonly env: KernelEnv;
  readonly docs: DocService;
  readonly folders: FolderService;
  readonly health: HealthService;
  readonly index: IndexService;
  readonly commands: CommandBus;
  readonly canvas: CanvasHost;
  readonly settings: SettingsService;
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
