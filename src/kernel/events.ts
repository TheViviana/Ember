import type { CanvasId, CommandId, DocId, VaultPath } from '#doc-model';
import type { Disposable, DocChange, DocRevision, VaultGuardState, VaultSettings } from './types.ts';

/** 内核事件总线的事件表（kernel-contract §7） */
export interface KernelEventMap {
  'doc:changed': { id: DocId; path: VaultPath; kind: DocChange['kind']; revision: DocRevision };
  'doc:conflict': { id: DocId; copyId: DocId; copyPath: VaultPath };
  'index:updated': { changedDocIds: readonly DocId[] };
  'command:executed': { id: CommandId; ok: boolean };
  'settings:changed': { settings: VaultSettings };
  'canvas:changed': { canvasId: CanvasId; rev: number };
  /** 库守护熔断：目录停止清理并进入只读，等待用户重新扫描或退出 */
  'vault:guarded': VaultGuardState;
  /** 全量对账进度：active 为 true 时 total 是本次要同步的文件数 */
  'vault:sync': { readonly total: number; readonly active: boolean };
}

export interface EventBus {
  emit<K extends keyof KernelEventMap>(type: K, payload: KernelEventMap[K]): void;
  on<K extends keyof KernelEventMap>(
    type: K,
    handler: (payload: KernelEventMap[K]) => void,
  ): Disposable;
}

export interface EventBusOptions {
  /** 监听器抛错不打断其它监听器（G4）；默认静默，由 boot 注入 logger */
  readonly onListenerError?: (error: unknown) => void;
}

type Handler = (payload: never) => void;

/**
 * emit 期间迭代监听器快照，允许监听器在回调里注销自己（G4）。
 */
export const createEventBus = (options: EventBusOptions = {}): EventBus => {
  const handlers = new Map<string, Handler[]>();
  const report = options.onListenerError ?? ((): void => {});

  const emit = <K extends keyof KernelEventMap>(type: K, payload: KernelEventMap[K]): void => {
    const list = handlers.get(type);
    if (list === undefined) return;
    for (const handler of [...list]) {
      try {
        (handler as (value: KernelEventMap[K]) => void)(payload);
      } catch (error) {
        report(error);
      }
    }
  };

  const on = <K extends keyof KernelEventMap>(
    type: K,
    handler: (payload: KernelEventMap[K]) => void,
  ): Disposable => {
    const list = handlers.get(type) ?? [];
    const entry = handler as Handler;
    list.push(entry);
    handlers.set(type, list);
    return {
      dispose: (): void => {
        const current = handlers.get(type);
        if (current === undefined) return;
        const index = current.indexOf(entry);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) handlers.delete(type);
      },
    };
  };

  return { emit, on };
};
