import {
  DEFAULT_GRID,
  applyMutations,
  parseCanvasDocument,
  toCanvasFile,
  validateScene,
  type CanvasDocument,
  type CanvasGrid,
  type CanvasLayer,
  type CanvasMutation,
  type CanvasNode,
  type CanvasRect,
  type CanvasScene,
  type Viewport,
} from '#canvas-engine';
import { asCanvasId, createUlid, type CanvasId } from '#doc-model';
import { EmberError } from './errors.ts';
import type { EventBus } from './events.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
import type {
  CanvasSummary,
  CreateCanvasInput,
  Disposable,
  Logger,
  SettingsService,
} from './types.ts';

export interface CanvasSession {
  readonly id: CanvasId;
  readonly scene: CanvasScene;
  on(listener: (scene: CanvasScene) => void): Disposable;
  close(): void;
}

export interface CanvasNodeKindSpec {
  readonly kind: string;
  readonly minSize: { readonly w: number; readonly h: number };
  readonly createDefault: (rect: CanvasRect) => Omit<CanvasNode, 'id' | 'z' | 'groupId'>;
}

export interface CanvasHost {
  list(): Promise<readonly CanvasSummary[]>;
  create(input: CreateCanvasInput): Promise<CanvasSummary>;
  open(id: CanvasId): Promise<CanvasSession>;
  /** 解析主页画布：settings.ui.defaultCanvasId → 已有画布 → 新建「主页」并写回 settings */
  ensureDefault(): Promise<CanvasSummary>;
  /** 一批 mutation 一次原子写；整批校验失败抛 canvas_invalid 且内存与磁盘都不动 */
  apply(id: CanvasId, ops: readonly CanvasMutation[]): Promise<CanvasScene>;
  registerLayer(layer: CanvasLayer): Disposable;
  registerNodeKind(spec: CanvasNodeKindSpec): Disposable;
  /** 强制落盘挂起的视口防抖（关闭流程与 visibilitychange 用） */
  flush(): Promise<void>;
}

export interface CanvasHostOptions {
  readonly port: VaultPort;
  readonly paths: PathTools;
  readonly events: EventBus;
  readonly settings: SettingsService;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** 画布目录：`.workbench/canvas/<id>.json`，与文档共用同一个原子写端口（V2） */
const CANVAS_DIR = '.workbench/canvas';

/** 视口防抖窗口（V6）；窗口隐藏或会话关闭时强制 flush */
const VIEWPORT_DEBOUNCE_MS = 400;

interface SessionEntry {
  document: CanvasDocument;
  readonly listeners: Set<(scene: CanvasScene) => void>;
  refs: number;
  rev: number;
  timer: ReturnType<typeof setTimeout> | null;
  pendingViewport: Viewport | null;
  writing: Promise<void>;
  /** 同一画布的多次 open 返回同一个会话对象（V3） */
  session: CanvasSession | null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const createCanvasHost = (options: CanvasHostOptions): CanvasHost => {
  const { port, paths, events, settings, log } = options;
  const now = options.now ?? ((): Date => new Date());

  const layers: CanvasLayer[] = [];
  const nodeKinds = new Map<string, CanvasNodeKindSpec>();
  const sessions = new Map<string, SessionEntry>();
  /** 同一画布的并发 open 共享同一次读盘（否则 refs 分裂、close 互删注册，违反 V3） */
  const loading = new Map<string, Promise<SessionEntry>>();

  const canvasPath = (id: string): string => `${CANVAS_DIR}/${id}.json`;

  const notify = (entry: SessionEntry): void => {
    for (const listener of [...entry.listeners]) listener(entry.document.scene);
  };

  /** 读盘并转运行时文档；文件不存在返回 null，文件损坏抛 canvas_invalid */
  const readDocument = async (id: CanvasId): Promise<CanvasDocument | null> => {
    const bytes = await port.read(paths.normalize(canvasPath(String(id))));
    if (bytes === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      throw new EmberError('canvas_invalid', `画布 JSON 解析失败：${String(id)}`, {
        reason: String(error),
      });
    }
    const parsed = parseCanvasDocument(raw);
    if (parsed.document === null) {
      throw new EmberError('canvas_invalid', `画布文件不合法：${String(id)}`, {
        issues: parsed.issues,
      });
    }
    if (!parsed.ok) {
      log.warn('画布文件存在校验问题，按原样载入', {
        id: String(id),
        issues: parsed.issues.map((item) => item.code),
      });
    }
    return parsed.document;
  };

  const loadEntry = (id: CanvasId): Promise<SessionEntry> => {
    const key = String(id);
    const existing = sessions.get(key);
    if (existing !== undefined) return Promise.resolve(existing);
    const inFlight = loading.get(key);
    if (inFlight !== undefined) return inFlight;
    const pending = (async (): Promise<SessionEntry> => {
      const document = await readDocument(id);
      if (document === null) throw new EmberError('doc_not_found', `画布不存在：${key}`);
      // 双检：读盘期间可能已有并发 open 建好会话（例如本会话被关闭重建）
      const raced = sessions.get(key);
      if (raced !== undefined) return raced;
      const entry: SessionEntry = {
        document,
        listeners: new Set(),
        refs: 0,
        rev: 0,
        timer: null,
        pendingViewport: null,
        writing: Promise.resolve(),
        session: null,
      };
      sessions.set(key, entry);
      return entry;
    })();
    loading.set(key, pending);
    void pending
      .catch(() => undefined)
      .finally(() => {
        loading.delete(key);
      });
    return pending;
  };

  const makeSession = (entry: SessionEntry): CanvasSession => {
    const id = entry.document.scene.id;
    return {
      id,
      get scene() {
        return entry.document.scene;
      },
      on: (listener) => {
        entry.listeners.add(listener);
        return { dispose: (): void => void entry.listeners.delete(listener) };
      },
      close: () => {
        entry.refs -= 1;
        if (entry.refs > 0) return;
        void flushEntry(entry).catch((error: unknown) => {
          log.error('关闭画布会话时落盘失败', { id: String(id), error: String(error) });
        });
        sessions.delete(String(id));
      },
    };
  };

  const persist = async (entry: SessionEntry): Promise<void> => {
    const document: CanvasDocument = { ...entry.document, updatedAt: now().toISOString() };
    const path = paths.normalize(canvasPath(String(document.scene.id)));
    const text = `${JSON.stringify(toCanvasFile(document), null, 2)}\n`;
    await port.write(path, encoder.encode(text), 'user');
    entry.document = document;
    entry.rev += 1;
    events.emit('canvas:changed', { canvasId: document.scene.id, rev: entry.rev });
  };

  /** 同一画布的写入串行排队，避免两次 apply 交错落出半成品 */
  const enqueueWrite = <T>(entry: SessionEntry, task: () => Promise<T>): Promise<T> => {
    const next = entry.writing.then(task, task);
    // 归一为 Promise<void>：entry.writing 只代表「队列是否排空」，不携带任务结果
    entry.writing = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const flushEntry = async (entry: SessionEntry): Promise<void> => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pendingViewport === null) return;
    entry.pendingViewport = null;
    await enqueueWrite(entry, () => persist(entry));
  };

  const summaryOf = (entry: SessionEntry): CanvasSummary => ({
    id: entry.document.scene.id,
    title: entry.document.scene.title,
    updatedAt: entry.document.updatedAt,
  });

  const list = async (): Promise<readonly CanvasSummary[]> => {
    const all = await port.list();
    const summaries: CanvasSummary[] = [];
    for (const path of all) {
      const value = String(path);
      if (!value.startsWith(`${CANVAS_DIR}/`) || !value.endsWith('.json')) continue;
      const id = asCanvasId(value.slice(CANVAS_DIR.length + 1, -'.json'.length));
      if (id === null) continue;
      try {
        const document = await readDocument(id);
        if (document === null) continue;
        const stat = await port.stat(path);
        summaries.push({
          id: document.scene.id,
          title: document.scene.title,
          updatedAt: document.updatedAt || stat?.mtime || '',
        });
      } catch (error) {
        log.error('跳过无法读取的画布', { id: String(id), error: String(error) });
      }
    }
    return summaries.sort((left, right) => left.title.localeCompare(right.title));
  };

  const rememberDefault = async (id: CanvasId): Promise<void> => {
    if (port.readonlyMode) return;
    await settings.patch({ ui: { defaultCanvasId: String(id) } });
  };

  const guardWritable = (): void => {
    if (port.readonlyMode) {
      throw new EmberError('vault_locked', '当前库为只读模式，无法修改画布');
    }
  };

  const createCanvas = async (input: CreateCanvasInput): Promise<CanvasSummary> => {
    guardWritable();
    const generated = asCanvasId(createUlid(now().getTime()));
    if (generated === null) throw new EmberError('io_failed', '生成画布 id 失败');
    const grid: CanvasGrid = (await settings.read()).ui.canvasGrid ?? DEFAULT_GRID;
    const at = now().toISOString();
    const scene: CanvasScene = {
      id: generated,
      title: input.title,
      viewport: input.viewport ?? { x: 0, y: 0, zoom: 1 },
      grid,
      nodes: [],
      edges: [],
    };
    const issues = validateScene(scene);
    if (issues.length > 0) {
      throw new EmberError('canvas_invalid', issues[0]?.message ?? '画布初始场景非法', { issues });
    }
    const document: CanvasDocument = {
      schemaVersion: 1,
      createdAt: at,
      updatedAt: at,
      scene,
      capabilityData: {},
    };
    const path = paths.normalize(canvasPath(String(generated)));
    await port.write(path, encoder.encode(`${JSON.stringify(toCanvasFile(document), null, 2)}\n`), 'user');
    return { id: generated, title: scene.title, updatedAt: at };
  };

  return {
    list,

    create: createCanvas,

    ensureDefault: async () => {
      const current = await settings.read();
      const preferred = current.ui.defaultCanvasId;
      if (typeof preferred === 'string' && preferred.length > 0) {
        const id = asCanvasId(preferred);
        if (id !== null) {
          try {
            return summaryOf(await loadEntry(id));
          } catch (error) {
            log.warn('默认画布不可用，回退到已存在的画布', {
              id: preferred,
              error: String(error),
            });
          }
        }
      }
      const existing = await list();
      const first = existing[0];
      if (first !== undefined) {
        await rememberDefault(first.id);
        return first;
      }
      const created = await createCanvas({ title: '主页' });
      await rememberDefault(created.id);
      return created;
    },

    apply: async (id, ops) => {
      guardWritable();
      // 变更（校验+内存修改）与落盘整体进写队列串行执行：并发 apply 不再交错——
      // 否则先排队者的落盘失败回滚会拿自己调用点捕获的快照，误伤后排队者已写入内存的变更，
      // 使其静默丢失却返回成功。串行化后 previous 恒为「此刻全部已生效变更」的基准。
      const entry = await loadEntry(id);
      return enqueueWrite(entry, async () => {
          const result = applyMutations(entry.document.scene, ops);
          if (!result.ok) {
            throw new EmberError('canvas_invalid', result.issues[0]?.message ?? '画布变更非法', {
              issues: result.issues,
            });
          }

          const previous = entry.document;
          entry.document = { ...previous, scene: result.scene };

          if (result.viewportOnly) {
            // 视口变更不广播：UI 直接持有视口状态渲染（CanvasSurface 的 setViewport 每帧跟手），
            // 平移/缩放每帧一次 apply，若在此 notify 会让所有订阅者以帧率重建整棵场景树。
            // entry.document.scene 已是最新值，session.scene getter 与下一次内容通知都会带上它。
            entry.pendingViewport = result.scene.viewport;
            if (entry.timer !== null) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
              entry.timer = null;
              void flushEntry(entry).catch((error: unknown) => {
                log.error('视口落盘失败', { id: String(id), error: String(error) });
              });
            }, VIEWPORT_DEBOUNCE_MS);
            return result.scene;
          }

          notify(entry);

          if (entry.timer !== null) {
            clearTimeout(entry.timer);
            entry.timer = null;
          }
          entry.pendingViewport = null;
          try {
            await persist(entry);
          } catch (error) {
            // 落盘失败：内存场景一并回滚，否则界面会留下「磁盘上并不存在」的节点
            entry.document = previous;
            notify(entry);
            throw error;
          }
          return entry.document.scene;
      });
    },

    open: async (id) => {
      const entry = await loadEntry(id);
      entry.refs += 1;
      entry.session ??= makeSession(entry);
      return entry.session;
    },

    registerLayer: (layer) => {
      layers.push(layer);
      layers.sort((left, right) => left.zIndex - right.zIndex);
      return {
        dispose: (): void => {
          const index = layers.indexOf(layer);
          if (index >= 0) layers.splice(index, 1);
        },
      };
    },

    registerNodeKind: (spec) => {
      if (nodeKinds.has(spec.kind)) {
        throw new EmberError('duplicate_extension', `画布节点类型重复：${spec.kind}`);
      }
      nodeKinds.set(spec.kind, spec);
      return {
        dispose: (): void => {
          nodeKinds.delete(spec.kind);
        },
      };
    },

    flush: async () => {
      for (const entry of [...sessions.values()]) await flushEntry(entry);
    },
  };
};
