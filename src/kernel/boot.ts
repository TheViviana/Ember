import type { VaultId } from '#doc-model';
import { createCanvasHost } from './canvas-host.ts';
import { createCommandBus } from './command-bus.ts';
import { createKernelContext, type KernelContext } from './context.ts';
import { createDocService } from './doc-service.ts';
import { createEventBus } from './events.ts';
import { toErrorText } from './errors.ts';
import { createHealthService } from './health-service.ts';
import { createIndexService } from './index-service.ts';
import { createPathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
import { createSettingsService } from './settings-service.ts';
import type { KernelEnv, Logger } from './types.ts';

export const KERNEL_VERSION = '2.3.0';

export interface BootPorts {
  readonly vault: VaultPort;
}

export interface BootOptions {
  readonly vaultId: VaultId;
  readonly ports: BootPorts;
  readonly log?: Logger;
  readonly kernelVersion?: string;
  readonly now?: () => Date;
}

export interface Kernel {
  readonly context: KernelContext;
  /** 释放监听、等待写入落盘 */
  shutdown(): Promise<void>;
}

const createConsoleLogger = (): Logger => {
  const write =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, fields?: Readonly<Record<string, unknown>>): void => {
      const line = fields === undefined ? message : `${message} ${JSON.stringify(fields)}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else if (level === 'info') console.info(line);
      else console.debug(line);
    };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
};

/**
 * 启动顺序：events → commands → settings → docs → index → canvas → 绑定上下文
 * → 初次对账 → 启动 watcher。
 * 中途失败即抛出，不允许半初始化进入可写状态。
 */
export const bootKernel = async (options: BootOptions): Promise<Kernel> => {
  const log = options.log ?? createConsoleLogger();
  const kernelVersion = options.kernelVersion ?? KERNEL_VERSION;
  const paths = createPathTools();

  const events = createEventBus({
    onListenerError: (error) => log.error('事件监听器抛错', { error: toErrorText(error) }),
  });
  const commands = createCommandBus({ events });

  const env: KernelEnv = {
    kernelVersion,
    vaultId: options.vaultId,
    // 只读状态在启动时确定，env 统一从端口读取同一份状态与原因
    get readonlyMode() {
      return options.ports.vault.readonlyMode;
    },
    get readonlyReason() {
      return options.ports.vault.readonlyReason;
    },
  };

  const settings = createSettingsService({
    port: options.ports.vault,
    paths,
    events,
    log,
    vaultId: options.vaultId,
    ...(options.now ? { now: options.now } : {}),
  });
  await settings.read();

  const docs = createDocService({
    port: options.ports.vault,
    paths,
    events,
    log,
    ...(options.now ? { now: options.now } : {}),
  });
  const index = createIndexService({ docs, settings, events, log });
  const health = createHealthService({
    port: options.ports.vault,
    paths,
    docs,
    ...(options.now ? { now: options.now } : {}),
  });
  const canvas = createCanvasHost({
    port: options.ports.vault,
    paths,
    events,
    settings,
    docs,
    log,
    ...(options.now ? { now: options.now } : {}),
  });

  const context = createKernelContext({
    env,
    docs,
    health,
    index,
    commands,
    canvas,
    settings,
    events,
    log,
    paths,
  });
  commands.bindKernel(() => context);

  await docs.flush();

  /**
   * 第 8 步：watcher → 目录对账。
   * 一次扫描期间产生的后续事件只记一个「待补扫」标记：结束时再跑一次就够，
   * 否则批量导入时每个文件事件都排队一次全库重读。
   */
  let refreshRunning: Promise<void> | null = null;
  let refreshQueued = false;
  const runRefresh = (): void => {
    if (refreshRunning !== null) {
      refreshQueued = true;
      return;
    }
    refreshRunning = (async () => {
      try {
        await docs.refresh();
      } catch (error: unknown) {
        log.error('目录对账失败', { error: toErrorText(error) });
      } finally {
        refreshRunning = null;
        if (refreshQueued) {
          refreshQueued = false;
          runRefresh();
        }
      }
    })();
  };
  const drainRefresh = async (): Promise<void> => {
    let current = refreshRunning;
    while (current !== null) {
      await current;
      current = refreshRunning;
    }
  };
  const watcher = options.ports.vault.watch(runRefresh);

  // 单飞：关窗收尾与 KernelProvider 卸载可能同时触发，拆解只能执行一次。
  // 失败时清空缓存以允许重试（调用方据此判断是否还能继续使用内核）。
  let closing: Promise<void> | null = null;

  return {
    context,
    shutdown: () => {
      closing ??= (async () => {
        watcher.dispose();
        await drainRefresh();
        await docs.flush();
        await canvas.flush();
        await settings.flush();
        log.info('内核已关闭');
      })().catch((error: unknown) => {
        closing = null;
        throw error;
      });
      return closing;
    },
  };
};
