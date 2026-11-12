import type { CapabilityId, VaultId } from '#doc-model';
import { createCanvasHost } from './canvas-host.ts';
import {
  createCapabilityHost,
  type CapabilityHostInternal,
  type CapabilityModule,
} from './capability-host.ts';
import { createCommandBus } from './command-bus.ts';
import { createKernelContext, scopeContext, type KernelContext } from './context.ts';
import { createDocService } from './doc-service.ts';
import { createEditorHost } from './editor-host.ts';
import { createEventBus } from './events.ts';
import { toErrorText } from './errors.ts';
import { createIndexService } from './index-service.ts';
import { createPathTools } from './paths.ts';
import type { AiPort, IndexPort, VaultPort } from './ports.ts';
import { createSettingsService } from './settings-service.ts';
import type { Disposable, KernelEnv, Logger } from './types.ts';

export const KERNEL_VERSION = '1.0.0';

export interface BootPorts {
  readonly vault: VaultPort;
  readonly index: IndexPort;
  readonly ai?: AiPort;
}

export interface BootOptions {
  readonly vaultId: VaultId;
  readonly ports: BootPorts;
  /** 编译期静态装配的能力清单（C1） */
  readonly capabilities: readonly CapabilityModule[];
  /** settings.json 的开关（C7），缺省用 manifest.defaultEnabled */
  readonly isCapabilityEnabled?: (id: CapabilityId) => boolean;
  readonly log?: Logger;
  readonly kernelVersion?: string;
  readonly now?: () => Date;
}

export interface Kernel {
  readonly context: KernelContext;
  /** 停用全部能力、释放监听、等待写入落盘 */
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
 * 启动顺序（kernel-contract §11）：events → commands → settings → docs → index → editor → canvas
 * → capabilities → 注册/校验/拓扑激活 → 初次对账 → 启动 watcher → emit vault:mode。
 * 3–6 步失败即抛出，不允许半初始化进入可写状态。
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
    // 运行期锁被接管后端口会翻只读，env 必须跟随而不是固化启动值
    get readonlyMode() {
      return options.ports.vault.readonlyMode;
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
  /** 开关优先级：显式注入 > settings.json > manifest.defaultEnabled */
  const initialSettings = await settings.read();

  const docs = createDocService({
    port: options.ports.vault,
    paths,
    events,
    log,
    ...(options.now ? { now: options.now } : {}),
  });
  const index = createIndexService({ port: options.ports.index, events, log });
  const editor = createEditorHost({ docs });
  const canvas = createCanvasHost({
    port: options.ports.vault,
    paths,
    events,
    settings,
    log,
    ...(options.now ? { now: options.now } : {}),
  });

  let contextRef: KernelContext | null = null;

  const capabilities: CapabilityHostInternal = createCapabilityHost({
    kernelVersion,
    events,
    log,
    commands,
    isEnabled: (id) =>
      options.isCapabilityEnabled?.(id) ?? initialSettings.capabilities[String(id)]?.enabled,
    createContext: (_module, track) => {
      if (contextRef === null) throw new Error('内核上下文尚未构造完成');
      return scopeContext(contextRef, track);
    },
  });

  const context = createKernelContext({
    env,
    docs,
    index,
    commands,
    editor,
    canvas,
    settings,
    capabilities,
    events,
    log,
    paths,
  });
  contextRef = context;
  commands.bindKernel(() => context);

  const registrations: Disposable[] = [];
  for (const module of options.capabilities) {
    registrations.push(capabilities.register(module));
  }
  capabilities.validate();

  for (const id of capabilities.activationOrder()) {
    const state = capabilities.list().find((item) => String(item.id) === String(id));
    if (state !== undefined && state.enabled) await capabilities.activate(id);
  }

  await docs.flush();

  /**
   * 第 9 步：watcher → 目录对账。
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

  // 运行期降级：端口翻只读后广播给 UI，状态栏/工具栏随之切换
  const modeWatch = options.ports.vault.watchMode?.((state) => {
    log.warn('库已降级为只读', { reason: state.reason });
    events.emit('vault:mode', state);
  });

  events.emit('vault:mode', {
    readonly: env.readonlyMode,
    reason: env.readonlyMode ? 'library lock unavailable' : null,
  });

  return {
    context,
    shutdown: async () => {
      watcher.dispose();
      modeWatch?.dispose();
      await capabilities.deactivateAll();
      for (const registration of [...registrations].reverse()) registration.dispose();
      await drainRefresh();
      await docs.flush();
      await canvas.flush();
      await settings.flush();
      log.info('内核已关闭');
    },
  };
};
