import { createUlid, type DocId } from '#doc-model';
import type { CanvasMutation, CanvasPoint } from '#canvas-engine';

/**
 * AI 生成画布思维导图：模型只负责输出结构 JSON，落盘用真实画布节点 + 连线。
 * 生成结果就是普通画布节点 —— 拖动、改文字、连线、删除全部沿用画布既有交互，
 * 不存在「只能查看不能修改」的只读产物。
 */

export interface MindMapNode {
  readonly title: string;
  readonly children?: readonly MindMapNode[];
}

export interface MindMapSpec {
  readonly mutations: readonly CanvasMutation[];
  readonly nodeCount: number;
  readonly edgeCount: number;
}

const MAX_DEPTH = 3;
const MAX_CHILDREN = 6;

const NODE_SIZE_ROOT = { w: 240, h: 120 } as const;
const NODE_SIZE_L1 = { w: 220, h: 110 } as const;
const NODE_SIZE_L2 = { w: 200, h: 100 } as const;

const GAP_X = 90;
const GAP_Y = 36;

/** 宽松解析：剥掉 ```json 围栏，取第一个平衡的 JSON 对象 */
export const parseMindMap = (text: string): MindMapNode | null => {
  const stripped = text.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end));
  } catch (error) {
    // 模型偶尔会输出非 JSON 片段：保留「解析失败」以便排查，但仍按无导图处理
    console.error(
      '思维导图 JSON 解析失败，本次不生成导图：',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
  return normalizeNode(raw, 0);
};

const normalizeNode = (raw: unknown, depth: number): MindMapNode | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title.length === 0) return null;
  if (depth >= MAX_DEPTH) return { title, children: [] };
  const rawChildren = Array.isArray(record.children) ? record.children.slice(0, MAX_CHILDREN) : [];
  const children: MindMapNode[] = [];
  for (const child of rawChildren) {
    const normalized = normalizeNode(child, depth + 1);
    if (normalized !== null) children.push(normalized);
  }
  return { title, children };
};

interface LayoutNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface LayoutContext {
  readonly mutations: CanvasMutation[];
  z: number;
  nodeCount: number;
  edgeCount: number;
}

/**
 * 布局：根在给定点（节点中心），第 1 层在其右侧竖排，第 2 层再往右一列。
 * 返回 addNode / addEdge 变更列表，一次 kernel.canvas.apply 落盘。
 */
export const mindMapMutations = (
  root: MindMapNode,
  center: CanvasPoint,
  startZ: number,
  docId: string,
): MindMapSpec => {
  const context: LayoutContext = { mutations: [], z: startZ, nodeCount: 0, edgeCount: 0 };

  const placeLevel = (
    node: MindMapNode,
    depth: number,
    centerX: number,
    centerY: number,
    parentId: string | null,
  ): LayoutNode => {
    const size = depth === 0 ? NODE_SIZE_ROOT : depth === 1 ? NODE_SIZE_L1 : NODE_SIZE_L2;
    const id = `n_${createUlid()}`;
    context.mutations.push({
      type: 'addNode',
      node: {
        id,
        kind: docId.length > 0 && depth === 0 ? 'doc' : 'note',
        rect: {
          x: Math.round(centerX - size.w / 2),
          y: Math.round(centerY - size.h / 2),
          w: size.w,
          h: size.h,
        },
        z: context.z,
        docId: docId.length > 0 && depth === 0 ? (docId as DocId) : null,
        text: docId.length > 0 && depth === 0 ? null : node.title,
        groupId: null,
        meta: {},
      },
    });
    context.z += 1;
    context.nodeCount += 1;

    const childNodes: LayoutNode[] = [];
    const children = node.children ?? [];
    const columnX = centerX + size.w / 2 + GAP_X + (depth === 0 ? NODE_SIZE_L1.w / 2 : NODE_SIZE_L2.w / 2);
    const totalHeight = children.length * (depth === 1 ? NODE_SIZE_L1.h : NODE_SIZE_L2.h) +
      Math.max(0, children.length - 1) * GAP_Y;
    let childY = centerY - totalHeight / 2;
    for (const child of children) {
      const childHeight = depth === 1 ? NODE_SIZE_L1.h : NODE_SIZE_L2.h;
      const placedChild = placeLevel(child, depth + 1, columnX, childY + childHeight / 2, id);
      childNodes.push(placedChild);
      childY += childHeight + GAP_Y;
    }

    if (parentId !== null) {
      context.mutations.push({
        type: 'addEdge',
        edge: {
          id: `e_${createUlid()}`,
          from: parentId,
          to: id,
          label: null,
          arrow: 'end',
          kind: 'relation',
          meta: {},
        },
      });
      context.edgeCount = (context.edgeCount ?? 0) + 1;
    }
    return { id, x: centerX, y: centerY, w: size.w, h: size.h };
  };

  placeLevel(root, 0, center.x, center.y, null);

  return {
    mutations: context.mutations,
    nodeCount: context.nodeCount,
    edgeCount: context.edgeCount ?? 0,
  };
};
