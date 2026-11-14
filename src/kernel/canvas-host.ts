import {
  DEFAULT_GRID,
  applyMutations,
  parseCanvasDocument,
  toCanvasFile,
  validateScene,
  type CanvasBookmark,
  type CanvasDocument,
  type CanvasGrid,
  type CanvasLayer,
  type CanvasMutation,
  type CanvasNode,
  type CanvasPoint,
  type CanvasRect,
  type CanvasScene,
  type Viewport,
} from '#canvas-engine';
import {
  asCanvasId,
  createUlid,
  safeFileName,
  unsafeVaultPath,
  type CanvasId,
  type DocId,
  type VaultPath,
} from '#doc-model';
import { EmberError, isEmberError } from './errors.ts';
import type { EventBus } from './events.ts';
import type { DocServiceInternal } from './doc-service.ts';
import type { PathTools } from './paths.ts';
import type { VaultPort } from './ports.ts';
import type {
  CanvasSummary,
  CreateCanvasInput,
  Disposable,
  DocSnapshot,
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

/** 画布上的文档节点位置（在画布中定位用） */
export interface CanvasDocLocation {
  readonly canvasId: CanvasId;
  readonly canvasTitle: string;
  readonly nodeId: string;
}

/** 画布上的图片节点位置（附件面板「按画布」与被引用定位用） */
export interface CanvasAssetLocation {
  readonly canvasId: CanvasId;
  readonly canvasTitle: string;
  readonly nodeId: string;
}

/** 全库书签条目：统一搜索能按书签直达观察角度 */
export interface CanvasBookmarkEntry {
  readonly canvasId: CanvasId;
  readonly canvasTitle: string;
  readonly bookmark: CanvasBookmark;
}

/** 画布历史槽位摘要（slot=1 是上一版；只读列出，不打开会话） */
export interface CanvasHistoryEntry {
  readonly slot: number;
  /** 快照写入时的画布 updatedAt；损坏快照为空字符串 */
  readonly updatedAt: string;
  readonly nodeCount: number;
  /** 快照字节的 sha256，恢复时用于过期校验 */
  readonly hash: string;
  /** 能否解析为合法画布；false 时仍列出但不可恢复 */
  readonly readable: boolean;
}

export interface CanvasHistoryPreview {
  readonly entry: CanvasHistoryEntry;
  readonly scene: CanvasScene;
}

export interface CreateArticleInput {
  readonly canvasId: CanvasId;
  readonly title: string;
  /** 节点左上角（世界坐标，调用方已吸附网格） */
  readonly point: CanvasPoint;
  readonly nodeId: string;
  readonly size: { readonly w: number; readonly h: number };
  readonly z: number;
}

export interface CreateArticleResult {
  readonly snapshot: DocSnapshot;
  readonly scene: CanvasScene;
}

export interface CanvasHost {
  list(): Promise<readonly CanvasSummary[]>;
  create(input: CreateCanvasInput): Promise<CanvasSummary>;
  /** 打开画布会话（引用计数；同画布并发 open 共享同一会话，V3） */
  open(id: CanvasId): Promise<CanvasSession>;
  /** 重命名画布（setTitle 变更走同一原子写与校验） */
  rename(id: CanvasId, title: string): Promise<CanvasScene>;
  /** 复制画布：场景（节点/连线/视口/书签）整体拷贝为新画布 */
  duplicate(id: CanvasId, title?: string): Promise<CanvasSummary>;
  /** 删除画布：移入系统回收站；总览画布不可删 */
  remove(id: CanvasId): Promise<void>;
  /** 解析主页画布：settings.ui.defaultCanvasId → 已有画布 → 新建「主页」并写回 settings */
  ensureDefault(): Promise<CanvasSummary>;
  /** 解析总览画布：固定一张特殊画布，卡片即 Portal，自动与画布清单对账 */
  ensureOverview(): Promise<CanvasSummary>;
  /** 一批 mutation 一次原子写；整批校验失败抛 canvas_invalid 且内存与磁盘都不动 */
  apply(id: CanvasId, ops: readonly CanvasMutation[]): Promise<CanvasScene>;
  /** 一步新建文章：落盘 .md → 建文档节点（画布写失败回滚为永久删除） */
  createArticle(input: CreateArticleInput): Promise<CreateArticleResult>;
  /** 在画布中定位：文档 → 承载它的画布节点 */
  locateDoc(docId: DocId): Promise<readonly CanvasDocLocation[]>;
  /** 在画布中定位：资产 → 引用它的图片节点 */
  locateAsset(assetPath: string): Promise<readonly CanvasAssetLocation[]>;
  /** 全库书签清单：统一搜索直达观察角度 */
  bookmarks(): Promise<readonly CanvasBookmarkEntry[]>;
  /** 是否存在可恢复的画布历史版本 */
  hasHistory(id: CanvasId): Promise<boolean>;
  /** 列出可用历史槽位（最多 5 版，slot=1 是上一版；不打开会话、不写盘） */
  listHistory(id: CanvasId): Promise<readonly CanvasHistoryEntry[]>;
  /** 只读预览指定槽位；损坏快照抛 canvas_invalid，不写盘 */
  readHistory(id: CanvasId, slot: number): Promise<CanvasHistoryPreview>;
  /** 恢复指定槽位：hash 与快照不符抛 stale_revision；当前版本先入历史，恢复可逆 */
  restoreHistory(id: CanvasId, slot: number, hash: string): Promise<CanvasScene>;
  /** 恢复上一版（restoreHistory(id, 1) 的包装，不做 hash 预检） */
  restorePrevious(id: CanvasId): Promise<CanvasScene>;
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
  /** 一步新建文章需要文档服务（含回滚用的 purge）；由 boot 注入 */
  readonly docs: DocServiceInternal;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** 画布目录：`.workbench/canvas/<id>.json`，与文档共用同一个原子写端口（V2） */
const CANVAS_DIR = '.workbench/canvas';

/** 总览画布的 settings 键：库内唯一真相，总览被外部删除后重建会得到新 id */
const OVERVIEW_SETTINGS_KEY = 'overviewCanvasId';

/** 视口防抖窗口（V6）；窗口隐藏或会话关闭时强制 flush */
const VIEWPORT_DEBOUNCE_MS = 400;

/** 画布历史目录：`.workbench/history/<canvasId>.<n>.json`，n=1 是上一版（轮转） */
const HISTORY_DIR = '.workbench/history';
/** 每张画布保留的历史版本数 */
const HISTORY_KEEP = 5;

/** 总览画布卡片（Portal 节点）的网格摆放参数 */
const PORTAL_SIZE = { w: 320, h: 220 };
const PORTAL_ORIGIN_X = 80;
const PORTAL_ORIGIN_Y = 80;
const PORTAL_STEP_X = 380;
const PORTAL_STEP_Y = 300;

/** 新文章统一落在 notes/ 下（vault-format 的用户文档目录） */
const ARTICLE_DIR = 'notes';
const UNTITLED = '未命名文章';
const MAX_NAME_ATTEMPTS = 50;
const NAME_MAX = 80;

interface SessionEntry {
  document: CanvasDocument;
  readonly listeners: Set<(scene: CanvasScene) => void>;
  refs: number;
  rev: number;
  timer: ReturnType<typeof setTimeout> | null;
  pendingViewport: Viewport | null;
  writing: Promise<void>;
  /** 画布已被 remove()：旧会话关闭时不得再落盘，否则幽灵文件复活 */
  removed: boolean;
  /** 同一画布的多次 open 返回同一个会话对象（V3） */
  session: CanvasSession | null;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Portal 节点约定：kind 'portal'，meta 携带目标画布；正文一律为空 */
const portalTargetOf = (node: CanvasNode): string | null => {
  if (node.kind !== 'portal') return null;
  const target = node.meta['portalTarget'];
  return typeof target === 'string' && target.length > 0 ? target : null;
};

const makePortalNode = (input: {
  readonly id: string;
  readonly target: CanvasId;
  readonly title: string;
  readonly nodeCount: number;
  readonly rect: CanvasRect;
  readonly z: number;
}): CanvasNode => ({
  id: input.id,
  kind: 'portal',
  docId: null,
  text: null,
  rect: input.rect,
  z: input.z,
  groupId: null,
  meta: {
    portalTarget: String(input.target),
    portalTitle: input.title,
    portalNodeCount: input.nodeCount,
  },
});

export const createCanvasHost = (options: CanvasHostOptions): CanvasHost => {
  const { port, paths, events, settings, docs, log } = options;
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

  /** 字节 → 运行时文档；损坏一律抛 canvas_invalid（主文件与历史快照共用） */
  const decodeCanvas = (bytes: Uint8Array, label: string): CanvasDocument => {
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch (error) {
      throw new EmberError('canvas_invalid', `画布 JSON 解析失败：${label}`, {
        reason: String(error),
      });
    }
    const parsed = parseCanvasDocument(raw);
    if (parsed.document === null) {
      throw new EmberError('canvas_invalid', `画布文件不合法：${label}`, {
        issues: parsed.issues,
      });
    }
    if (!parsed.ok) {
      log.warn('画布文件存在校验问题，按原样载入', {
        id: label,
        issues: parsed.issues.map((item) => item.code),
      });
    }
    return parsed.document;
  };

  /** 读盘并转运行时文档；文件不存在返回 null，文件损坏抛 canvas_invalid */
  const readDocument = async (id: CanvasId): Promise<CanvasDocument | null> => {
    const bytes = await port.read(paths.normalize(canvasPath(String(id))));
    return bytes === null ? null : decodeCanvas(bytes, String(id));
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
        removed: false,
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
        if (!entry.removed) {
          void flushEntry(entry).catch((error: unknown) => {
            log.error('关闭画布会话时落盘失败', { id: String(id), error: String(error) });
          });
        }
        sessions.delete(String(id));
      },
    };
  };

  const historyPath = (id: string, n: number): VaultPath =>
    unsafeVaultPath(paths.normalize(`${HISTORY_DIR}/${id}.${n}.json`));

  const toHex = (buffer: ArrayBuffer): string =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  /** 历史快照的内容指纹：恢复前比对，避免把列表里看到的版本换成别的字节 */
  const hashBytes = async (bytes: Uint8Array): Promise<string> =>
    `sha256:${toHex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))}`;

  const assertSlot = (slot: number): void => {
    if (!Number.isInteger(slot) || slot < 1 || slot > HISTORY_KEEP) {
      throw new EmberError('invalid_payload', `画布历史槽位不合法：${String(slot)}`, {
        slot,
        max: HISTORY_KEEP,
      });
    }
  };

  const readHistoryBytes = async (id: string, slot: number): Promise<Uint8Array> => {
    const bytes = await port.read(historyPath(id, slot));
    if (bytes === null) {
      throw new EmberError('doc_not_found', `画布历史版本不存在：${id}.${slot}`);
    }
    return bytes;
  };

  const historyEntryOf = async (
    key: string,
    slot: number,
    bytes: Uint8Array,
  ): Promise<CanvasHistoryEntry> => {
    const hash = await hashBytes(bytes);
    try {
      const document = decodeCanvas(bytes, `历史版本 ${key}.${slot}`);
      return {
        slot,
        updatedAt: document.updatedAt,
        nodeCount: document.scene.nodes.length,
        hash,
        readable: true,
      };
    } catch (error) {
      log.error('画布历史版本解析失败，按不可读返回', { id: key, slot, error: String(error) });
      return { slot, updatedAt: '', nodeCount: 0, hash, readable: false };
    }
  };

  /**
   * 内容版本轮转：当前磁盘内容推进为 `.1`，旧版本依次后移，超过 HISTORY_KEEP 的永久删除。
   * 只用于内容写入（视口防抖不算版本）；purge 是内核内部历史管理，不进回收站。
   */
  const rotateHistory = async (id: string, previous: Uint8Array): Promise<void> => {
    await port.purge(historyPath(id, HISTORY_KEEP)).catch(() => undefined);
    for (let n = HISTORY_KEEP - 1; n >= 1; n -= 1) {
      try {
        await port.rename(historyPath(id, n), historyPath(id, n + 1));
      } catch {
        // 该槽位为空：继续腾下一个
      }
    }
    await port.write(historyPath(id, 1), previous, 'system');
  };

  const persist = async (entry: SessionEntry, record: boolean): Promise<void> => {
    if (entry.removed) return;
    const path = paths.normalize(canvasPath(String(entry.document.scene.id)));
    // 上一版本先轮转进历史（只记录内容变更；视口防抖不算版本）
    if (record && !port.readonlyMode) {
      const previous = await port.read(path);
      if (previous !== null) {
        await rotateHistory(String(entry.document.scene.id), previous);
      }
    }
    const document: CanvasDocument = { ...entry.document, updatedAt: now().toISOString() };
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
    const value = entry.pendingViewport;
    entry.pendingViewport = null;
    if (entry.removed) return;
    try {
      await enqueueWrite(entry, () => persist(entry, false));
    } catch (error) {
      // 写失败把视口挂回去：关窗重试（第二次关闭放行前）还能再试一次
      if (entry.pendingViewport === null) entry.pendingViewport = value;
      throw error;
    }
  };

  /** 是否存在可恢复的历史版本 */
  const hasHistory = async (id: CanvasId): Promise<boolean> =>
    (await port.read(historyPath(String(id), 1))) !== null;

  /** 列出可用槽位；损坏快照仍列出（readable=false），槽位空洞自动跳过 */
  const listHistory = async (id: CanvasId): Promise<readonly CanvasHistoryEntry[]> => {
    const key = String(id);
    const entries: CanvasHistoryEntry[] = [];
    for (let slot = 1; slot <= HISTORY_KEEP; slot += 1) {
      const bytes = await port.read(historyPath(key, slot));
      if (bytes === null) continue;
      entries.push(await historyEntryOf(key, slot, bytes));
    }
    return entries;
  };

  /** 只读预览：解析失败抛 canvas_invalid；不打开会话、不写盘 */
  const readHistory = async (id: CanvasId, slot: number): Promise<CanvasHistoryPreview> => {
    assertSlot(slot);
    const key = String(id);
    const bytes = await readHistoryBytes(key, slot);
    const document = decodeCanvas(bytes, `历史版本 ${key}.${slot}`);
    return {
      entry: {
        slot,
        updatedAt: document.updatedAt,
        nodeCount: document.scene.nodes.length,
        hash: await hashBytes(bytes),
        readable: true,
      },
      scene: document.scene,
    };
  };

  /**
   * 恢复指定槽位：当前版本（磁盘上的真相）先轮转进历史，恢复可逆。
   * expectedHash 非 null 时先比对快照指纹，不符抛 stale_revision 且不写盘。
   * 恢复是布局级操作，视口随历史一并还原；会话若已打开则在写队列内串行重载并广播。
   */
  const restoreSlot = async (
    id: CanvasId,
    slot: number,
    expectedHash: string | null,
  ): Promise<CanvasScene> => {
    guardWritable();
    assertSlot(slot);
    const key = String(id);
    const targetBytes = await readHistoryBytes(key, slot);
    if (expectedHash !== null) {
      const actual = await hashBytes(targetBytes);
      if (actual !== expectedHash) {
        throw new EmberError('stale_revision', '历史版本内容已变化，请刷新历史列表后重试', {
          slot,
          expected: expectedHash,
          actual,
        });
      }
    }
    // 先把目标快照解析成合法文档：损坏的历史不得覆盖当前画布
    const target = decodeCanvas(targetBytes, `历史版本 ${key}.${slot}`);
    const apply = async (): Promise<CanvasScene> => {
      const currentBytes = await port.read(paths.normalize(canvasPath(key)));
      if (currentBytes !== null) {
        await rotateHistory(key, currentBytes);
      }
      await port.write(paths.normalize(canvasPath(key)), targetBytes, 'user');
      const entry = sessions.get(key);
      if (entry === undefined) return target.scene;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.pendingViewport = null;
      entry.document = target;
      entry.rev += 1;
      notify(entry);
      events.emit('canvas:changed', { canvasId: id, rev: entry.rev });
      return entry.document.scene;
    };
    const entry = sessions.get(key);
    return entry === undefined ? apply() : enqueueWrite(entry, apply);
  };

  const restoreHistory = (id: CanvasId, slot: number, hash: string): Promise<CanvasScene> =>
    restoreSlot(id, slot, hash);

  const restorePrevious = (id: CanvasId): Promise<CanvasScene> => restoreSlot(id, 1, null);

  /** 全画布扫描（reconcile 用）：跳过不可读画布，同时把它们报告出来，避免误删其 Portal 卡片 */
  const scanCanvases = async (): Promise<{
    readonly summaries: readonly CanvasSummary[];
    readonly unreadable: readonly string[];
  }> => {
    const all = await port.listCanvases();
    const summaries: CanvasSummary[] = [];
    const unreadable: string[] = [];
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
          nodeCount: document.scene.nodes.length,
        });
      } catch (error) {
        unreadable.push(value.slice(CANVAS_DIR.length + 1, -'.json'.length));
        log.error('跳过无法读取的画布', { id: String(id), error: String(error) });
      }
    }
    return {
      summaries: summaries.sort((left, right) => left.title.localeCompare(right.title)),
      unreadable,
    };
  };

  const summaryOf = (entry: SessionEntry): CanvasSummary => ({
    id: entry.document.scene.id,
    title: entry.document.scene.title,
    updatedAt: entry.document.updatedAt,
    nodeCount: entry.document.scene.nodes.length,
  });

  const list = async (): Promise<readonly CanvasSummary[]> => (await scanCanvases()).summaries;

  const rememberDefault = async (id: CanvasId): Promise<void> => {
    if (port.readonlyMode) return;
    await settings.patch({ ui: { defaultCanvasId: String(id) } });
  };

  const guardWritable = (): void => {
    if (port.readonlyMode) {
      throw new EmberError('vault_locked', '库为只读，写操作被拒绝（原因见状态栏）', {
        reason: port.readonlyReason,
      });
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
      bookmarks: [],
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
    return { id: generated, title: scene.title, updatedAt: at, nodeCount: 0 };
  };

  const overviewIdFromSettings = async (): Promise<CanvasId | null> => {
    const current = await settings.read();
    const raw = current.ui[OVERVIEW_SETTINGS_KEY];
    if (typeof raw !== 'string' || raw.length === 0) return null;
    return asCanvasId(raw);
  };

  /**
   * 一批 mutation 一次原子写（V5）。
   * 变更（校验+内存修改）与落盘整体进写队列串行执行：并发 apply 不再交错——
   * 否则先排队者的落盘失败回滚会拿自己调用点捕获的快照，误伤后排队者已写入内存的变更，
   * 使其静默丢失却返回成功。串行化后 previous 恒为「此刻全部已生效变更」的基准。
   */
  const applyImpl = async (id: CanvasId, ops: readonly CanvasMutation[]): Promise<CanvasScene> => {
    guardWritable();
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
      if (entry.removed) {
        // 写队列排队期间画布被删除：放弃落盘，避免幽灵文件复活
        return entry.document.scene;
      }
      try {
        await persist(entry, true);
      } catch (error) {
        // 落盘失败：内存场景一并回滚，否则界面会留下「磁盘上并不存在」的节点
        entry.document = previous;
        notify(entry);
        throw error;
      }
      return entry.document.scene;
    });
  };

  /**
   * 总览对账：为每张画布保证一个 Portal 卡片，同步标题与节点数，清掉失效目标。
   * 只读库跳过对账：布局数据可重建，展示仍可用旧卡片。
   */
  const reconcileOverview = async (entry: SessionEntry): Promise<void> => {
    if (port.readonlyMode) return;
    const overviewId = entry.document.scene.id;
    const scanned = await scanCanvases();
    const canvases = scanned.summaries.filter((item) => String(item.id) !== String(overviewId));
    const ops: CanvasMutation[] = [];
    const queuedRemoval = new Set<string>();

    // portal 全集（含 meta 缺损的垃圾节点）参与清理，防止它们挡住新卡片的摆位
    const portalNodes = entry.document.scene.nodes.filter((node) => node.kind === 'portal');
    const byTarget = new Map<string, CanvasNode>();
    for (const node of portalNodes) {
      const target = portalTargetOf(node);
      if (target === null) {
        // meta 缺损的 portal 渲染成可编辑 note：对账时清理
        ops.push({ type: 'removeNodes', ids: [node.id] });
        queuedRemoval.add(node.id);
        continue;
      }
      // 同目标重复卡片只保留第一张，其余清理
      if (byTarget.has(target)) {
        ops.push({ type: 'removeNodes', ids: [node.id] });
        queuedRemoval.add(node.id);
        continue;
      }
      byTarget.set(target, node);
    }

    const liveTargets = new Set(canvases.map((canvas) => String(canvas.id)));
    const unreadable = new Set(scanned.unreadable);
    // 目标已消失（画布被删且非不可读）的卡片整体清理；不可读画布的卡片保留，
    // 文件恢复后自动接上，用户摆放不丢
    for (const node of portalNodes) {
      const target = portalTargetOf(node);
      if (
        target !== null &&
        !liveTargets.has(target) &&
        !unreadable.has(target) &&
        !queuedRemoval.has(node.id)
      ) {
        ops.push({ type: 'removeNodes', ids: [node.id] });
        queuedRemoval.add(node.id);
      }
    }

    // 新卡片摆位按网格占用扫描，而不是按数量推算：删卡/挪卡后不与既有卡片重叠
    const occupiedSlots = new Set<string>();
    for (const node of portalNodes) {
      if (queuedRemoval.has(node.id)) continue;
      const col = Math.round((node.rect.x - PORTAL_ORIGIN_X) / PORTAL_STEP_X);
      const row = Math.round((node.rect.y - PORTAL_ORIGIN_Y) / PORTAL_STEP_Y);
      if (col >= 0 && row >= 0) occupiedSlots.add(`${col}:${row}`);
    }
    const nextFreeSlot = (): { readonly col: number; readonly row: number } => {
      for (let row = 0; row < 64; row += 1) {
        for (let col = 0; col < 6; col += 1) {
          if (!occupiedSlots.has(`${col}:${row}`)) return { col, row };
        }
      }
      return { col: occupiedSlots.size % 6, row: Math.floor(occupiedSlots.size / 6) };
    };

    for (const canvas of canvases) {
      const key = String(canvas.id);
      const existing = byTarget.get(key);
      if (existing === undefined) {
        const slot = nextFreeSlot();
        occupiedSlots.add(`${slot.col}:${slot.row}`);
        ops.push({
          type: 'addNode',
          node: makePortalNode({
            id: `portal-${createUlid(now().getTime())}`,
            target: canvas.id,
            title: canvas.title,
            nodeCount: canvas.nodeCount,
            rect: {
              x: PORTAL_ORIGIN_X + slot.col * PORTAL_STEP_X,
              y: PORTAL_ORIGIN_Y + slot.row * PORTAL_STEP_Y,
              w: PORTAL_SIZE.w,
              h: PORTAL_SIZE.h,
            },
            z: 0,
          }),
        });
        continue;
      }
      const title = existing.meta['portalTitle'];
      const count = existing.meta['portalNodeCount'];
      if (title !== canvas.title || count !== canvas.nodeCount) {
        ops.push({
          type: 'updateNode',
          id: existing.id,
          patch: { meta: { portalTitle: canvas.title, portalNodeCount: canvas.nodeCount } },
        });
      }
    }

    if (ops.length === 0) return;
    await applyImpl(overviewId, ops);
  };

  return {
    list,

    create: createCanvas,

    rename: async (id, title) => applyImpl(id, [{ type: 'setTitle', title: title.trim() }]),

    duplicate: async (id, title) => {
      guardWritable();
      const source = await readDocument(id);
      if (source === null) throw new EmberError('doc_not_found', `画布不存在：${String(id)}`);
      const generated = asCanvasId(createUlid(now().getTime()));
      if (generated === null) throw new EmberError('io_failed', '生成画布 id 失败');
      const nextTitle = title ?? `${source.scene.title} 副本`;
      const scene: CanvasScene = {
        ...source.scene,
        id: generated,
        title: nextTitle,
        nodes: source.scene.nodes.map((node) => ({ ...node, meta: { ...node.meta } })),
        edges: source.scene.edges.map((edge) => ({ ...edge, meta: { ...edge.meta } })),
      };
      const issues = validateScene(scene);
      if (issues.length > 0) {
        throw new EmberError('canvas_invalid', `复制后的画布场景非法：${issues[0]?.message ?? ''}`, {
          issues,
        });
      }
      const at = now().toISOString();
      const document: CanvasDocument = {
        schemaVersion: 1,
        createdAt: at,
        updatedAt: at,
        scene,
        capabilityData: { ...source.capabilityData },
      };
      const path = paths.normalize(canvasPath(String(generated)));
      await port.write(path, encoder.encode(`${JSON.stringify(toCanvasFile(document), null, 2)}\n`), 'user');
      return { id: generated, title: nextTitle, updatedAt: at, nodeCount: scene.nodes.length };
    },

    remove: async (id) => {
      guardWritable();
      const overview = await overviewIdFromSettings();
      if (overview !== null && String(overview) === String(id)) {
        throw new EmberError('canvas_invalid', '总览画布不能删除');
      }
      const key = String(id);
      const entry = sessions.get(key);
      if (entry !== undefined) {
        entry.removed = true;
        if (entry.timer !== null) clearTimeout(entry.timer);
        sessions.delete(key);
      }
      const path = paths.normalize(canvasPath(key));
      const bytes = await port.read(path);
      if (bytes === null) return;
      await port.remove(path);
      // 主页固定指向被删画布时清掉固定值：ensureDefault 会回落到剩余画布
      const current = await settings.read();
      if (current.ui.defaultCanvasId === key) {
        await settings.patch({ ui: { defaultCanvasId: null } });
      }
    },

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

    ensureOverview: async () => {
      const existingId = await overviewIdFromSettings();
      if (existingId !== null) {
        try {
          const entry = await loadEntry(existingId);
          await reconcileOverview(entry);
          return summaryOf(entry);
        } catch (error) {
          log.warn('总览画布不可用，尝试重建', {
            id: String(existingId),
            error: String(error),
          });
        }
      }
      // 只读库无法重建：回退到已有画布（保持可用），而不是抛错把主区打空
      if (port.readonlyMode) {
        const existing = (await list())[0];
        if (existing !== undefined) return existing;
        throw new EmberError('canvas_invalid', '总览画布缺失且库为只读，无法重建');
      }
      const created = await createCanvas({ title: '总览' });
      await settings.patch({ ui: { [OVERVIEW_SETTINGS_KEY]: String(created.id) } });
      const entry = await loadEntry(created.id);
      await reconcileOverview(entry);
      return summaryOf(entry);
    },

    open: async (id) => {
      const entry = await loadEntry(id);
      entry.refs += 1;
      entry.session ??= makeSession(entry);
      return entry.session;
    },

    apply: applyImpl,

    createArticle: async (input) => {
      const name = safeFileName(input.title, { fallback: UNTITLED, maxLength: NAME_MAX });
      const candidatePath = (attempt: number): VaultPath =>
        unsafeVaultPath(`${ARTICLE_DIR}/${attempt === 1 ? name : `${name}-${attempt}`}.md`);

      let snapshot: DocSnapshot | null = null;
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && snapshot === null; attempt += 1) {
        try {
          snapshot = await docs.create({
            path: candidatePath(attempt),
            text: '',
            title: name,
            intent: 'user',
          });
        } catch (error) {
          if (isEmberError(error) && error.code === 'path_exists') continue;
          throw error;
        }
      }
      if (snapshot === null) {
        throw new EmberError('path_exists', `无法为「${name}」找到可用文件名`);
      }

      const created = snapshot;
      const node: CanvasNode = {
        id: input.nodeId,
        kind: 'doc',
        docId: created.meta.id,
        text: null,
        rect: { x: input.point.x, y: input.point.y, w: input.size.w, h: input.size.h },
        z: input.z,
        groupId: null,
        meta: {},
      };

      try {
        const scene = await applyImpl(input.canvasId, [{ type: 'addNode', node }]);
        return { snapshot: created, scene };
      } catch (canvasError) {
        const path = String(created.meta.path);
        try {
          await docs.purge(created.meta.id, { base: created.meta.rev, intent: 'user' });
        } catch (rollbackError) {
          throw new EmberError(
            'io_failed',
            `画布写入失败且回滚失败。文章仍在磁盘：${path}（回滚原因：${String(rollbackError)}；画布原因：${String(canvasError)}）`,
            { path, rolledBack: false },
          );
        }
        throw new EmberError(
          'io_failed',
          `画布写入失败，已回滚并删除刚创建的文件：${path}（原因：${String(canvasError)}）`,
          { path, rolledBack: true },
        );
      }
    },

    locateDoc: async (docId) => {
      const all = await list();
      const locations: CanvasDocLocation[] = [];
      const key = String(docId);
      for (const summary of all) {
        try {
          const document = await readDocument(summary.id);
          if (document === null) continue;
          for (const node of document.scene.nodes) {
            if (node.kind === 'doc' && node.docId !== null && String(node.docId) === key) {
              locations.push({ canvasId: summary.id, canvasTitle: summary.title, nodeId: node.id });
            }
          }
        } catch (error) {
          log.warn('定位文档时跳过无法读取的画布', {
            id: String(summary.id),
            error: String(error),
          });
        }
      }
      return locations;
    },

    locateAsset: async (assetPath) => {
      const all = await list();
      const locations: CanvasAssetLocation[] = [];
      for (const summary of all) {
        try {
          const document = await readDocument(summary.id);
          if (document === null) continue;
          for (const node of document.scene.nodes) {
            if (node.kind !== 'image') continue;
            const candidate = node.meta['assetPath'];
            if (typeof candidate === 'string' && candidate === assetPath) {
              locations.push({ canvasId: summary.id, canvasTitle: summary.title, nodeId: node.id });
            }
          }
        } catch (error) {
          log.warn('定位图片时跳过无法读取的画布', {
            id: String(summary.id),
            error: String(error),
          });
        }
      }
      return locations;
    },

    hasHistory,
    listHistory,
    readHistory,
    restoreHistory,
    restorePrevious,

    bookmarks: async () => {
      const all = await list();
      const entries: CanvasBookmarkEntry[] = [];
      for (const summary of all) {
        try {
          const document = await readDocument(summary.id);
          if (document === null) continue;
          for (const bookmark of document.scene.bookmarks) {
            entries.push({ canvasId: summary.id, canvasTitle: summary.title, bookmark });
          }
        } catch (error) {
          log.warn('收集书签时跳过无法读取的画布', {
            id: String(summary.id),
            error: String(error),
          });
        }
      }
      return entries;
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
      // allSettled：一个会话落盘失败不吞掉其余会话的最后机会
      await Promise.allSettled([...sessions.values()].map((entry) => flushEntry(entry)));
    },
  };
};
