import { asCanvasId, asDocId } from '../../doc-model/src/ids.ts';
import type {
  CanvasBookmark,
  CanvasDocument,
  CanvasEdge,
  CanvasFilters,
  CanvasGrid,
  CanvasNode,
  CanvasScene,
} from './types.ts';
import { validateScene, type CanvasIssue } from './validate.ts';

export const DEFAULT_GRID: CanvasGrid = { size: 8, snap: true };

export interface ParseResult {
  readonly ok: boolean;
  readonly document: CanvasDocument | null;
  readonly issues: readonly CanvasIssue[];
}

const fail = (message: string): ParseResult => ({
  ok: false,
  document: null,
  issues: [{ code: 'invalid_document', message, id: null }],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * 视图书签解析：书签是布局数据，坏一条跳过一条而不是炸掉整张画布；
 * 旧文件没有该字段时回退空数组（unknown keys 在旧解析里本来就被丢弃，兼容无虞）。
 */
const parseBookmarks = (raw: unknown): readonly CanvasBookmark[] => {
  if (!Array.isArray(raw)) return [];
  const bookmarks: CanvasBookmark[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item['id']);
    const name = asString(item['name']);
    if (id === null || id === '' || name === null) continue;
    const viewportItem = isRecord(item['viewport']) ? item['viewport'] : null;
    const vx = asNumber(viewportItem?.['x']);
    const vy = asNumber(viewportItem?.['y']);
    const vz = asNumber(viewportItem?.['zoom']);
    if (vx === null || vy === null || vz === null) continue;
    let filters: CanvasFilters | null = null;
    const rawFilters = item['filters'];
    if (isRecord(rawFilters)) {
      const tags = Array.isArray(rawFilters['tags'])
        ? rawFilters['tags'].filter((tag): tag is string => typeof tag === 'string')
        : [];
      const kinds = Array.isArray(rawFilters['kinds'])
        ? rawFilters['kinds'].filter((kind): kind is string => typeof kind === 'string')
        : [];
      const text = asString(rawFilters['text']) ?? '';
      const mode = rawFilters['mode'] === 'hide' ? 'hide' : 'dim';
      filters = { tags, kinds, text, mode };
    }
    bookmarks.push({ id, name, viewport: { x: vx, y: vy, zoom: vz }, filters });
  }
  return bookmarks;
};

/**
 * 磁盘格式（vault-format §8.2）→ 运行时文档。
 * 节点在文件里是扁平的 x/y/w/h，运行时收成 rect；未知字段不参与（meta 之外的未知键丢弃）。
 */
export const parseCanvasDocument = (raw: unknown): ParseResult => {
  if (!isRecord(raw)) return fail('画布文件必须是 JSON 对象');

  const schemaVersion = raw['schemaVersion'] ?? 1;
  if (schemaVersion !== 1) {
    return fail(`不支持的画布 schemaVersion：${JSON.stringify(schemaVersion)}`);
  }

  const id = asCanvasId(asString(raw['id']) ?? '');
  if (id === null) return fail('画布 id 非法');
  const title = asString(raw['title']);
  if (title === null) return fail('画布 title 必须是字符串');

  const rawViewport = isRecord(raw['viewport']) ? raw['viewport'] : null;
  const vx = asNumber(rawViewport?.['x']);
  const vy = asNumber(rawViewport?.['y']);
  const vz = asNumber(rawViewport?.['zoom']);
  if (vx === null || vy === null || vz === null) return fail('画布 viewport 非法');

  const rawGrid = isRecord(raw['grid']) ? raw['grid'] : null;
  const size = rawGrid?.['size'] ?? DEFAULT_GRID.size;
  const snap = rawGrid?.['snap'] ?? DEFAULT_GRID.snap;
  const grid: CanvasGrid =
    (size === 8 || size === 16 || size === 32) && typeof snap === 'boolean'
      ? { size, snap }
      : DEFAULT_GRID;

  const rawNodes = Array.isArray(raw['nodes']) ? raw['nodes'] : [];
  const rawEdges = Array.isArray(raw['edges']) ? raw['edges'] : [];

  const nodes: CanvasNode[] = [];
  for (const item of rawNodes) {
    if (!isRecord(item)) return fail('节点必须是对象');
    const nodeId = asString(item['id']);
    const kind = asString(item['kind']);
    if (nodeId === null || kind === null) return fail('节点缺少 id 或 kind');
    const rawDocId = item['docId'] ?? null;
    const x = asNumber(item['x']);
    const y = asNumber(item['y']);
    const w = asNumber(item['w']);
    const h = asNumber(item['h']);
    if (x === null || y === null || w === null || h === null) {
      return fail(`节点 ${nodeId} 的坐标或尺寸非法`);
    }
    let docId: CanvasNode['docId'] = null;
    if (rawDocId !== null) {
      docId = asDocId(asString(rawDocId) ?? '');
      if (docId === null) return fail(`节点 ${nodeId} 的 docId 非法`);
    }
    nodes.push({
      id: nodeId,
      kind,
      rect: { x, y, w, h },
      z: asNumber(item['z']) ?? 0,
      docId,
      text: asString(item['text']),
      groupId: asString(item['groupId']),
      meta: isRecord(item['meta']) ? item['meta'] : {},
    });
  }

  const edges: CanvasEdge[] = [];
  for (const item of rawEdges) {
    if (!isRecord(item)) return fail('连线必须是对象');
    const edgeId = asString(item['id']);
    const from = asString(item['from']);
    const to = asString(item['to']);
    if (edgeId === null || from === null || to === null) return fail('连线缺少 id / from / to');
    const arrow = item['arrow'] ?? 'end';
    const rawLabel = asString(item['label']);
    edges.push({
      id: edgeId,
      from,
      to,
      // 空字符串按规范 §8.2 归一化为 null，避免「无标签」以两种形态在磁盘上往返
      label: rawLabel === '' ? null : rawLabel,
      arrow: arrow === 'none' || arrow === 'both' ? arrow : 'end',
      kind: 'relation',
      meta: isRecord(item['meta']) ? item['meta'] : {},
    });
  }

  const scene: CanvasScene = {
    id,
    title,
    viewport: { x: vx, y: vy, zoom: vz },
    grid,
    nodes,
    edges,
    bookmarks: parseBookmarks(raw['bookmarks']),
  };
  const issues = validateScene(scene);
  const document: CanvasDocument = {
    schemaVersion: 1,
    createdAt: asString(raw['createdAt']) ?? '',
    updatedAt: asString(raw['updatedAt']) ?? '',
    scene,
    capabilityData: isRecord(raw['capabilityData']) ? raw['capabilityData'] : {},
  };
  return { ok: issues.length === 0, document, issues };
};

/** 运行时文档 → 磁盘格式；字段顺序固定，便于 diff 与人工核对 */
export const toCanvasFile = (document: CanvasDocument): Record<string, unknown> => {
  const { scene } = document;
  return {
    schemaVersion: 1,
    id: String(scene.id),
    title: scene.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    viewport: { x: scene.viewport.x, y: scene.viewport.y, zoom: scene.viewport.zoom },
    grid: { size: scene.grid.size, snap: scene.grid.snap },
    nodes: scene.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      docId: node.docId === null ? null : String(node.docId),
      text: node.text,
      x: node.rect.x,
      y: node.rect.y,
      w: node.rect.w,
      h: node.rect.h,
      z: node.z,
      groupId: node.groupId,
      meta: node.meta,
    })),
    edges: scene.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      arrow: edge.arrow,
      kind: edge.kind,
      meta: edge.meta,
    })),
    bookmarks: scene.bookmarks.map((bookmark) => ({
      id: bookmark.id,
      name: bookmark.name,
      viewport: {
        x: bookmark.viewport.x,
        y: bookmark.viewport.y,
        zoom: bookmark.viewport.zoom,
      },
      filters:
        bookmark.filters === null
          ? null
          : {
              tags: [...bookmark.filters.tags],
              kinds: [...bookmark.filters.kinds],
              text: bookmark.filters.text,
              mode: bookmark.filters.mode,
            },
    })),
    capabilityData: document.capabilityData,
  };
};
