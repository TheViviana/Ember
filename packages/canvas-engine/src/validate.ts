import type { CanvasEdge, CanvasNode, CanvasScene } from './types.ts';

/** 通用下限：任何节点不得小于它；具体 kind 可以要求更大（CanvasNodeKindSpec.minSize） */
export const MIN_NODE_SIZE = { w: 160, h: 100 } as const;
export const ZOOM_RANGE = { min: 0.1, max: 4 } as const;
export const TITLE_MAX = 120;

export type CanvasIssueCode =
  | 'invalid_document'
  | 'invalid_title'
  | 'invalid_viewport'
  | 'invalid_grid'
  | 'invalid_node'
  | 'duplicate_node_id'
  | 'invalid_node_rect'
  | 'invalid_node_doc'
  | 'group_missing'
  | 'group_nesting'
  | 'invalid_edge'
  | 'duplicate_edge_id'
  | 'edge_missing_endpoint'
  | 'edge_group_endpoint'
  | 'edge_self_loop'
  | 'duplicate_edge';

export interface CanvasIssue {
  readonly code: CanvasIssueCode;
  readonly message: string;
  /** 出问题的节点/连线 id，便于 UI 定位 */
  readonly id: string | null;
}

const issue = (code: CanvasIssueCode, message: string, id: string | null = null): CanvasIssue => ({
  code,
  message,
  id,
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const checkNode = (
  node: CanvasNode,
  groups: ReadonlyMap<string, CanvasNode>,
): readonly CanvasIssue[] => {
  const issues: CanvasIssue[] = [];
  if (typeof node.id !== 'string' || node.id.length === 0) {
    issues.push(issue('invalid_node', '节点 id 必须是非空字符串', null));
    return issues;
  }
  if (typeof node.kind !== 'string' || node.kind.length === 0) {
    issues.push(issue('invalid_node', `节点 ${node.id} 缺少 kind`, node.id));
  }
  if (
    !isFiniteNumber(node.rect.x) ||
    !isFiniteNumber(node.rect.y) ||
    !isFiniteNumber(node.rect.w) ||
    !isFiniteNumber(node.rect.h)
  ) {
    issues.push(issue('invalid_node_rect', `节点 ${node.id} 的坐标或尺寸不是有限数`, node.id));
  } else if (node.rect.w < MIN_NODE_SIZE.w || node.rect.h < MIN_NODE_SIZE.h) {
    issues.push(
      issue(
        'invalid_node_rect',
        `节点 ${node.id} 小于最小尺寸 ${MIN_NODE_SIZE.w}×${MIN_NODE_SIZE.h}`,
        node.id,
      ),
    );
  }
  if (!Number.isInteger(node.z)) {
    issues.push(issue('invalid_node', `节点 ${node.id} 的 z 必须是整数`, node.id));
  }
  if (node.kind === 'doc') {
    if (node.docId === null) {
      issues.push(issue('invalid_node_doc', `文档节点 ${node.id} 必须带 docId`, node.id));
    }
    if (node.text !== null) {
      issues.push(issue('invalid_node_doc', `文档节点 ${node.id} 的 text 必须为 null`, node.id));
    }
  } else if (node.docId !== null) {
    issues.push(issue('invalid_node_doc', `${node.kind} 节点 ${node.id} 的 docId 必须为 null`, node.id));
  }
  if (node.groupId !== null) {
    if (node.kind === 'group') {
      issues.push(issue('group_nesting', `组节点 ${node.id} 不能再属于其它组`, node.id));
    } else {
      const group = groups.get(node.groupId);
      if (group === undefined) {
        issues.push(issue('group_missing', `节点 ${node.id} 引用了不存在的组 ${node.groupId}`, node.id));
      }
    }
  }
  return issues;
};

const checkEdge = (
  edge: CanvasEdge,
  nodes: ReadonlyMap<string, CanvasNode>,
): readonly CanvasIssue[] => {
  const issues: CanvasIssue[] = [];
  if (typeof edge.id !== 'string' || edge.id.length === 0) {
    issues.push(issue('invalid_edge', '连线 id 必须是非空字符串', null));
    return issues;
  }
  if (edge.kind !== 'relation') {
    issues.push(issue('invalid_edge', `连线 ${edge.id} 的 kind 必须是 relation`, edge.id));
  }
  if (edge.arrow !== 'none' && edge.arrow !== 'end' && edge.arrow !== 'both') {
    issues.push(issue('invalid_edge', `连线 ${edge.id} 的 arrow 非法`, edge.id));
  }
  if (edge.from === edge.to) {
    issues.push(issue('edge_self_loop', `连线 ${edge.id} 不能自环`, edge.id));
    return issues;
  }
  for (const endpoint of [edge.from, edge.to]) {
    const node = nodes.get(endpoint);
    if (node === undefined) {
      issues.push(issue('edge_missing_endpoint', `连线 ${edge.id} 的端点 ${endpoint} 不存在`, edge.id));
    } else if (node.kind === 'group') {
      issues.push(issue('edge_group_endpoint', `连线 ${edge.id} 不能连到组 ${endpoint}`, edge.id));
    }
  }
  return issues;
};

/**
 * 整场景校验（vault-format §8.2）：节点 id 唯一、组引用合法且不嵌套、
 * 边端点存在且非组、无自环、同一 (from, to) 只允许一条边。
 * 空数组 = 合法。
 */
export const validateScene = (scene: CanvasScene): readonly CanvasIssue[] => {
  const issues: CanvasIssue[] = [];

  if (typeof scene.title !== 'string' || scene.title.trim().length === 0) {
    issues.push(issue('invalid_title', '画布标题不能为空'));
  } else if (scene.title.length > TITLE_MAX) {
    issues.push(issue('invalid_title', `画布标题不得超过 ${TITLE_MAX} 字符`));
  }

  const { viewport } = scene;
  if (
    !isFiniteNumber(viewport.x) ||
    !isFiniteNumber(viewport.y) ||
    !isFiniteNumber(viewport.zoom) ||
    viewport.zoom < ZOOM_RANGE.min ||
    viewport.zoom > ZOOM_RANGE.max
  ) {
    issues.push(issue('invalid_viewport', '视口坐标必须是有限数，缩放需在 0.1–4 之间'));
  }

  if (
    (scene.grid.size !== 8 && scene.grid.size !== 16 && scene.grid.size !== 32) ||
    typeof scene.grid.snap !== 'boolean'
  ) {
    issues.push(issue('invalid_grid', '网格尺寸只允许 8 / 16 / 32，吸附必须是布尔值'));
  }

  const nodes = new Map<string, CanvasNode>();
  const groups = new Map<string, CanvasNode>();
  for (const node of scene.nodes) {
    if (nodes.has(node.id)) {
      issues.push(issue('duplicate_node_id', `节点 id 重复：${node.id}`, node.id));
      continue;
    }
    nodes.set(node.id, node);
  }
  for (const node of scene.nodes) {
    if (node.kind === 'group' && !groups.has(node.id)) groups.set(node.id, node);
  }
  for (const node of scene.nodes) issues.push(...checkNode(node, groups));

  const edges = new Map<string, CanvasEdge>();
  const pairs = new Set<string>();
  for (const edge of scene.edges) {
    if (edges.has(edge.id)) {
      issues.push(issue('duplicate_edge_id', `连线 id 重复：${edge.id}`, edge.id));
      continue;
    }
    edges.set(edge.id, edge);
    // 规范 §8.2 的「同一 (from, to)」是有向语义：A→B 与 B→A 可以并存
    const pair = `${edge.from}→${edge.to}`;
    if (pairs.has(pair)) {
      issues.push(issue('duplicate_edge', `同一 (from, to) 只允许一条连线：${pair}`, edge.id));
    }
    pairs.add(pair);
  }
  for (const edge of scene.edges) issues.push(...checkEdge(edge, nodes));

  return issues;
};
