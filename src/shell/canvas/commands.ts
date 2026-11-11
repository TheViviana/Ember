import type {
  CanvasEdge,
  CanvasMutation,
  CanvasNode,
  CanvasPoint,
  CanvasRect,
  CanvasScene,
  Viewport,
} from '#canvas-engine';
import type { DocId } from '#doc-model';
import type { CanvasClipboard } from './clipboard.ts';
import { DEFAULT_NODE_SIZE, boundsOfRects, fitViewport, snapValue, type AnchorSide } from './geometry.ts';

export const NODE_COLORS = ['primary', 'secondary', 'success', 'warning', 'danger'] as const;
export type NodeColor = (typeof NODE_COLORS)[number];

export const GROUP_PADDING = 24;
export const DUPLICATE_OFFSET = 32;
export const FIT_PADDING = 80;
const GROUP_DEFAULT_SIZE = { w: 480, h: 320 } as const;

/** 右键目标：只存 id 与屏幕点，命令执行时统一从当前场景解析，避免持有过期对象 */
export type MenuTarget =
  | { readonly kind: 'empty'; readonly point: CanvasPoint }
  | { readonly kind: 'node'; readonly id: string; readonly point: CanvasPoint }
  | { readonly kind: 'selection'; readonly ids: readonly string[]; readonly point: CanvasPoint }
  | { readonly kind: 'edge'; readonly id: string; readonly point: CanvasPoint };

export interface CommandInput {
  readonly command: string;
  readonly target: MenuTarget;
  readonly scene: CanvasScene;
  readonly selection: readonly string[];
  readonly clipboard: CanvasClipboard | null;
  readonly newId: (prefix: 'n' | 'e') => string;
  readonly viewportSize: { readonly w: number; readonly h: number };
}

/** 就地编辑退出：内容未变则无需提交；否则原样保存（Esc / 失焦也不丢） */
export const planTextUpdate = (
  node: CanvasNode | undefined,
  text: string,
): { readonly id: string; readonly text: string } | null => {
  if (node === undefined) return null;
  return (node.text ?? '') === text ? null : { id: node.id, text };
};

/**
 * 引线拖到空白后新建节点：按拖出方向定向。
 * 右锚点拖出 → 起点指向新节点；左锚点拖出 → 新节点指向起点。
 */
export const planAnchorEdge = (
  anchorNodeId: string,
  side: AnchorSide,
  newNodeId: string,
  edgeId: string,
): CanvasEdge => ({
  id: edgeId,
  from: side === 'right' ? anchorNodeId : newNodeId,
  to: side === 'right' ? newNodeId : anchorNodeId,
  label: null,
  arrow: 'end',
  kind: 'relation',
  meta: {},
});

/** 新节点落在引线末端：世界坐标下节点中心对齐松手点 */
export const centeredNodeRect = (
  center: CanvasPoint,
  size: { readonly w: number; readonly h: number } = DEFAULT_NODE_SIZE,
): CanvasRect => ({
  x: center.x - size.w / 2,
  y: center.y - size.h / 2,
  w: size.w,
  h: size.h,
});

export type CommandPlan =
  | {
      readonly kind: 'mutate';
      readonly mutations: readonly CanvasMutation[];
      readonly select?: readonly string[];
      readonly selectEdge?: string | null;
      readonly editNode?: string;
    }
  | { readonly kind: 'viewport'; readonly viewport: Viewport }
  | { readonly kind: 'select'; readonly ids: readonly string[] }
  | { readonly kind: 'copy'; readonly payload: CanvasClipboard }
  | { readonly kind: 'prompt-edge-label'; readonly edgeId: string; readonly value: string }
  /** 一步新建文章：先问标题，再落盘 + 建节点（由 CanvasSurface 调用内核完成） */
  | { readonly kind: 'create-article'; readonly point: CanvasPoint }
  /** 从库添加已有文章：打开与引线菜单共用的目录下钻，选中后落一个 doc 节点 */
  | { readonly kind: 'pick-doc'; readonly point: CanvasPoint }
  /** 打开文档浮窗；focus=title 表示「编辑元数据」入口，把焦点放到标题 */
  | { readonly kind: 'open-float'; readonly docId: DocId; readonly focus: 'title' | null };

const targetIds = (target: MenuTarget): readonly string[] => {
  if (target.kind === 'node') return [target.id];
  if (target.kind === 'selection') return target.ids;
  return [];
};

const resolveNodes = (scene: CanvasScene, ids: readonly string[]): readonly CanvasNode[] => {
  const wanted = new Set(ids);
  return scene.nodes.filter((node) => wanted.has(node.id));
};

const maxZ = (nodes: readonly CanvasNode[]): number =>
  nodes.reduce((value, node) => Math.max(value, node.z), -1);

const snapped = (point: CanvasPoint, grid: CanvasScene['grid']): CanvasPoint => ({
  x: snapValue(point.x, grid),
  y: snapValue(point.y, grid),
});

const hasEdgeBetween = (scene: CanvasScene, a: string, b: string): boolean =>
  scene.edges.some(
    (edge) =>
      (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a),
  );

/** 把 nodes 的 z 重排成 0..n-1，顺序即绘制顺序（组与 z 的比较规则由渲染层处理） */
const reindex = (order: readonly string[]): readonly CanvasMutation[] =>
  order.map((id, z) => ({ type: 'updateNode', id, patch: { z } }));

const zOrder = (scene: CanvasScene): readonly string[] =>
  [...scene.nodes].sort((left, right) => left.z - right.z).map((node) => node.id);

const reorderPlan = (scene: CanvasScene, ids: readonly string[], mode: 'top' | 'bottom' | 'up' | 'down'): readonly CanvasMutation[] => {
  const selected = new Set(ids);
  const order = [...zOrder(scene)];

  if (mode === 'top' || mode === 'bottom') {
    const rest = order.filter((id) => !selected.has(id));
    const moved = order.filter((id) => selected.has(id));
    return reindex(mode === 'top' ? [...rest, ...moved] : [...moved, ...rest]);
  }

  if (mode === 'up') {
    for (let index = order.length - 2; index >= 0; index -= 1) {
      const current = order[index];
      const above = order[index + 1];
      if (current !== undefined && above !== undefined && selected.has(current) && !selected.has(above)) {
        order[index] = above;
        order[index + 1] = current;
      }
    }
  } else {
    for (let index = 1; index < order.length; index += 1) {
      const current = order[index];
      const below = order[index - 1];
      if (current !== undefined && below !== undefined && selected.has(current) && !selected.has(below)) {
        order[index] = below;
        order[index - 1] = current;
      }
    }
  }
  return reindex(order);
};

const duplicatePlan = (
  scene: CanvasScene,
  nodes: readonly CanvasNode[],
  newId: CommandInput['newId'],
): CommandPlan => {
  const base = maxZ(scene.nodes) + 1;
  const clones = nodes.map((node, index) => ({
    ...node,
    id: newId('n'),
    rect: { ...node.rect, x: node.rect.x + DUPLICATE_OFFSET, y: node.rect.y + DUPLICATE_OFFSET },
    z: base + index,
  }));
  return {
    kind: 'mutate',
    mutations: clones.map((node) => ({ type: 'addNode', node })),
    select: clones.map((node) => node.id),
  };
};

const pastePlan = (input: CommandInput): CommandPlan | null => {
  const payload = input.clipboard;
  if (payload === null || payload.nodes.length === 0) return null;

  const sceneIds = new Set(input.scene.nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  for (const node of payload.nodes) idMap.set(node.id, input.newId('n'));

  const base = maxZ(input.scene.nodes) + 1;
  const mutations: CanvasMutation[] = [];
  payload.nodes.forEach((node, index) => {
    const mappedGroup = node.groupId === null ? null : (idMap.get(node.groupId) ?? (sceneIds.has(node.groupId) ? node.groupId : null));
    mutations.push({
      type: 'addNode',
      node: {
        ...node,
        id: idMap.get(node.id) ?? input.newId('n'),
        rect: { ...node.rect, x: node.rect.x + DUPLICATE_OFFSET, y: node.rect.y + DUPLICATE_OFFSET },
        z: base + index,
        groupId: mappedGroup,
      },
    });
  });

  for (const edge of payload.edges) {
    const from = idMap.get(edge.from);
    const to = idMap.get(edge.to);
    if (from === undefined || to === undefined) continue;
    mutations.push({ type: 'addEdge', edge: { ...edge, id: input.newId('e'), from, to } });
  }

  return {
    kind: 'mutate',
    mutations,
    select: payload.nodes.map((node) => idMap.get(node.id) ?? node.id),
  };
};

/**
 * 菜单命令 → 场景变更计划。纯函数：不落盘、不发事件、不生成随机 id（由调用方注入）。
 * 返回 null 表示该命令在当前状态下不成立；菜单模型不会在不可用时给出该命令。
 */
export const planCommand = (input: CommandInput): CommandPlan | null => {
  const { command, scene, target } = input;
  const ids = targetIds(target);
  const nodes = resolveNodes(scene, ids);
  const edge = target.kind === 'edge' ? (scene.edges.find((item) => item.id === target.id) ?? null) : null;

  switch (command) {
    case 'node.create-article':
      // 只有空白处能一步新建文章
      return target.kind === 'empty'
        ? { kind: 'create-article', point: snapped(target.point, scene.grid) }
        : null;

    case 'node.add-doc':
      // 与「新建文章」一样只对空白处开放；菜单复用 AnchorMenu 的目录下钻
      return target.kind === 'empty'
        ? { kind: 'pick-doc', point: snapped(target.point, scene.grid) }
        : null;

    case 'node.open-float':
    case 'node.edit-meta': {
      const node = nodes[0];
      if (node === undefined || node.kind !== 'doc' || node.docId === null) return null;
      return {
        kind: 'open-float',
        docId: node.docId,
        focus: command === 'node.edit-meta' ? 'title' : null,
      };
    }

    case 'node.create-note': {
      const point = snapped(target.point, scene.grid);
      const node: CanvasNode = {
        id: input.newId('n'),
        kind: 'note',
        docId: null,
        text: '',
        rect: { x: point.x, y: point.y, ...DEFAULT_NODE_SIZE },
        z: maxZ(scene.nodes) + 1,
        groupId: null,
        meta: {},
      };
      return { kind: 'mutate', mutations: [{ type: 'addNode', node }], select: [node.id], editNode: node.id };
    }

    case 'node.create-group': {
      const point = snapped(target.point, scene.grid);
      const group: CanvasNode = {
        id: input.newId('n'),
        kind: 'group',
        docId: null,
        text: '新分组',
        rect: { x: point.x, y: point.y, ...GROUP_DEFAULT_SIZE },
        z: maxZ(scene.nodes) + 1,
        groupId: null,
        meta: {},
      };
      return { kind: 'mutate', mutations: [{ type: 'addNode', node: group }], select: [group.id] };
    }

    case 'node.duplicate':
      if (nodes.length === 0 || nodes.some((node) => node.kind === 'group')) return null;
      return duplicatePlan(scene, nodes, input.newId);

    case 'node.copy': {
      if (nodes.length === 0) return null;
      const idsInCopy = new Set(nodes.map((node) => node.id));
      const edges = scene.edges.filter((item) => idsInCopy.has(item.from) && idsInCopy.has(item.to));
      return { kind: 'copy', payload: { nodes, edges } };
    }

    case 'node.paste':
      return pastePlan(input);

    case 'node.delete':
      if (nodes.length === 0) return null;
      return { kind: 'mutate', mutations: [{ type: 'removeNodes', ids: nodes.map((node) => node.id) }], select: [] };

    case 'node.edit': {
      const node = nodes[0];
      if (node === undefined || node.kind === 'doc') return null;
      return { kind: 'mutate', mutations: [], editNode: node.id };
    }

    case 'node.group-selection': {
      const members = nodes.filter((node) => node.kind !== 'group');
      if (members.length < 2) return null;
      const bounds = boundsOfRects(members.map((node) => node.rect));
      if (bounds === null) return null;
      const group: CanvasNode = {
        id: input.newId('n'),
        kind: 'group',
        docId: null,
        text: '新分组',
        rect: {
          x: bounds.x - GROUP_PADDING,
          y: bounds.y - GROUP_PADDING,
          w: bounds.w + GROUP_PADDING * 2,
          h: bounds.h + GROUP_PADDING * 2,
        },
        z: maxZ(scene.nodes) + 1,
        groupId: null,
        meta: {},
      };
      return {
        kind: 'mutate',
        mutations: [
          { type: 'addNode', node: group },
          ...members.map((node) => ({ type: 'updateNode' as const, id: node.id, patch: { groupId: group.id } })),
        ],
        select: [group.id],
      };
    }

    case 'node.ungroup': {
      const group = nodes.find((node) => node.kind === 'group');
      if (group === undefined) return null;
      const members = scene.nodes.filter((node) => node.groupId === group.id);
      return {
        kind: 'mutate',
        mutations: [{ type: 'removeNodes', ids: [group.id] }],
        select: members.map((node) => node.id),
      };
    }

    case 'node.remove-from-group': {
      const node = nodes.find((item) => item.groupId !== null);
      if (node === undefined) return null;
      return { kind: 'mutate', mutations: [{ type: 'updateNode', id: node.id, patch: { groupId: null } }], select: [node.id] };
    }

    case 'node.z.top':
    case 'node.z.bottom':
    case 'node.z.up':
    case 'node.z.down': {
      if (nodes.length === 0) return null;
      const mode = command === 'node.z.top' ? 'top' : command === 'node.z.bottom' ? 'bottom' : command === 'node.z.up' ? 'up' : 'down';
      return { kind: 'mutate', mutations: reorderPlan(scene, nodes.map((node) => node.id), mode) };
    }

    case 'edge.connect': {
      const picked = nodes.filter((node) => node.kind !== 'group');
      if (picked.length !== 2) return null;
      const [from, to] = picked;
      if (from === undefined || to === undefined || hasEdgeBetween(scene, from.id, to.id)) return null;
      const created: CanvasEdge = {
        id: input.newId('e'),
        from: from.id,
        to: to.id,
        label: null,
        arrow: 'end',
        kind: 'relation',
        meta: {},
      };
      return { kind: 'mutate', mutations: [{ type: 'addEdge', edge: created }], selectEdge: created.id };
    }

    case 'edge.reverse': {
      if (edge === null) return null;
      // 只挡「另一条反向连线已经存在」；当前这条自己不算
      const reversedExists = scene.edges.some(
        (item) => item.id !== edge.id && item.from === edge.to && item.to === edge.from,
      );
      if (reversedExists) return null;
      const reversed: CanvasEdge = { ...edge, from: edge.to, to: edge.from };
      return {
        kind: 'mutate',
        mutations: [
          { type: 'removeEdges', ids: [edge.id] },
          { type: 'addEdge', edge: reversed },
        ],
        selectEdge: edge.id,
      };
    }

    case 'edge.arrow.none':
      return edge === null ? null : { kind: 'mutate', mutations: [{ type: 'updateEdge', id: edge.id, patch: { arrow: 'none' } }] };

    case 'edge.arrow.end':
      return edge === null ? null : { kind: 'mutate', mutations: [{ type: 'updateEdge', id: edge.id, patch: { arrow: 'end' } }] };

    case 'edge.arrow.both':
      return edge === null ? null : { kind: 'mutate', mutations: [{ type: 'updateEdge', id: edge.id, patch: { arrow: 'both' } }] };

    case 'edge.delete':
      return edge === null ? null : { kind: 'mutate', mutations: [{ type: 'removeEdges', ids: [edge.id] }], selectEdge: null };

    case 'edge.edit-label':
      return edge === null ? null : { kind: 'prompt-edge-label', edgeId: edge.id, value: edge.label ?? '' };

    case 'view.select-all':
      return { kind: 'select', ids: scene.nodes.filter((node) => node.kind !== 'group').map((node) => node.id) };

    case 'view.fit': {
      const bounds = boundsOfRects(scene.nodes.map((node) => node.rect));
      if (bounds === null) return { kind: 'viewport', viewport: { x: 0, y: 0, zoom: 1 } };
      return { kind: 'viewport', viewport: fitViewport(bounds, input.viewportSize, FIT_PADDING) };
    }

    case 'view.reset':
      return { kind: 'viewport', viewport: { x: 0, y: 0, zoom: 1 } };

    case 'view.toggle-snap':
      return { kind: 'mutate', mutations: [{ type: 'setGrid', grid: { size: scene.grid.size, snap: !scene.grid.snap } }] };

    default: {
      if (command.startsWith('color:')) {
        const value = command.slice('color:'.length);
        if (nodes.length === 0) return null;
        if (value !== 'default' && !NODE_COLORS.includes(value as NodeColor)) return null;
        const color = value === 'default' ? null : value;
        return {
          kind: 'mutate',
          mutations: nodes.map((node) => ({ type: 'updateNode' as const, id: node.id, patch: { meta: { color } } })),
        };
      }
      return null;
    }
  }
};

/** 连线标签提交：独立入口，避免把任意字符串塞进命令 id */
export const planEdgeLabel = (
  scene: CanvasScene,
  edgeId: string,
  label: string,
): CanvasMutation | null => {
  if (!scene.edges.some((edge) => edge.id === edgeId)) return null;
  const trimmed = label.trim();
  return { type: 'updateEdge', id: edgeId, patch: { label: trimmed.length === 0 ? null : trimmed } };
};

export type ConnectionPlan =
  | { readonly kind: 'edge'; readonly edge: CanvasEdge }
  /** 起止点已存在连线：不新建，改为高亮那条（避免点了没反应） */
  | { readonly kind: 'duplicate'; readonly edgeId: string };

/**
 * 左键从锚点拖到目标节点生成连线（纯函数）。
 * 方向约定：左侧锚点拖出 = 本节点指向目标；右侧锚点拖出 = 目标指向本节点。
 * 两端只要有一侧存在连线就算重复（与右键「连接所选节点」的判定保持一致）。
 */
export const planConnection = (
  scene: CanvasScene,
  anchorNodeId: string,
  side: AnchorSide,
  targetNodeId: string | null,
  newId: (prefix: 'n' | 'e') => string,
): ConnectionPlan | null => {
  if (targetNodeId === null || targetNodeId === anchorNodeId) return null;
  const anchor = scene.nodes.find((node) => node.id === anchorNodeId);
  const target = scene.nodes.find((node) => node.id === targetNodeId);
  if (anchor === undefined || target === undefined) return null;
  if (anchor.kind === 'group' || target.kind === 'group') return null;

  const from = side === 'left' ? anchor.id : target.id;
  const to = side === 'left' ? target.id : anchor.id;
  const existing = scene.edges.find(
    (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
  );
  if (existing !== undefined) return { kind: 'duplicate', edgeId: existing.id };

  return {
    kind: 'edge',
    edge: {
      id: newId('e'),
      from,
      to,
      label: null,
      arrow: 'end',
      kind: 'relation',
      meta: {},
    },
  };
};
