import type {
  CanvasBookmark,
  CanvasEdge,
  CanvasGrid,
  CanvasNode,
  CanvasNodeKind,
  CanvasScene,
  Viewport,
} from './types.ts';
import { validateScene, type CanvasIssue } from './validate.ts';

export interface CanvasNodePatch {
  readonly kind?: CanvasNodeKind;
  readonly rect?: CanvasNode['rect'];
  readonly z?: number;
  /** 显式 null 表示解除文档引用（kind 与 docId 必须同步改，见 vault-format §8.2） */
  readonly docId?: CanvasNode['docId'];
  readonly text?: string | null;
  readonly groupId?: string | null;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface CanvasEdgePatch {
  readonly label?: string | null;
  readonly arrow?: CanvasEdge['arrow'];
}

export type CanvasMutation =
  | { readonly type: 'addNode'; readonly node: CanvasNode }
  | { readonly type: 'updateNode'; readonly id: string; readonly patch: CanvasNodePatch }
  | { readonly type: 'removeNodes'; readonly ids: readonly string[] }
  | { readonly type: 'addEdge'; readonly edge: CanvasEdge }
  | { readonly type: 'updateEdge'; readonly id: string; readonly patch: CanvasEdgePatch }
  | { readonly type: 'removeEdges'; readonly ids: readonly string[] }
  | { readonly type: 'setViewport'; readonly viewport: Viewport }
  | { readonly type: 'setTitle'; readonly title: string }
  | { readonly type: 'setGrid'; readonly grid: CanvasGrid }
  | { readonly type: 'setBookmarks'; readonly bookmarks: readonly CanvasBookmark[] };

export interface MutationResult {
  readonly ok: boolean;
  /** 失败时是入参原样场景，成功时是新场景 */
  readonly scene: CanvasScene;
  readonly issues: readonly CanvasIssue[];
  /** 整批只改了视口：上层据此走 400ms 防抖落盘 */
  readonly viewportOnly: boolean;
}

const unknownNode = (id: string): CanvasIssue => ({
  code: 'invalid_node',
  message: `节点不存在：${id}`,
  id,
});

const unknownEdge = (id: string): CanvasIssue => ({
  code: 'invalid_edge',
  message: `连线不存在：${id}`,
  id,
});

/**
 * 纯函数：一批 mutation 作用在场景上，再整场景校验（V5）。
 * 不做 IO、不分配 id；调用方负责落盘与通知。
 */
export const applyMutations = (
  scene: CanvasScene,
  ops: readonly CanvasMutation[],
): MutationResult => {
  let title = scene.title;
  let viewport = scene.viewport;
  let grid = scene.grid;
  let bookmarks = scene.bookmarks;
  let nodes: CanvasNode[] = [...scene.nodes];
  let edges: CanvasEdge[] = [...scene.edges];
  const issues: CanvasIssue[] = [];

  for (const op of ops) {
    switch (op.type) {
      case 'addNode':
        nodes = [...nodes, op.node];
        break;
      case 'updateNode': {
        const index = nodes.findIndex((node) => node.id === op.id);
        if (index < 0) {
          issues.push(unknownNode(op.id));
          break;
        }
        const current = nodes[index] as CanvasNode;
        const patch = op.patch;
        const next: CanvasNode = {
          ...current,
          ...(patch.kind === undefined ? {} : { kind: patch.kind }),
          ...(patch.rect === undefined ? {} : { rect: patch.rect }),
          ...(patch.z === undefined ? {} : { z: patch.z }),
          ...(patch.docId === undefined ? {} : { docId: patch.docId }),
          ...(patch.text === undefined ? {} : { text: patch.text }),
          ...(patch.groupId === undefined ? {} : { groupId: patch.groupId }),
          ...(patch.meta === undefined ? {} : { meta: { ...current.meta, ...patch.meta } }),
        };
        nodes = nodes.map((node, at) => (at === index ? next : node));
        break;
      }
      case 'removeNodes': {
        const removed = new Set(op.ids);
        nodes = nodes.filter((node) => !removed.has(node.id));
        edges = edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to));
        // 解散被删的组：成员保留但脱离组，避免悬空 groupId
        nodes = nodes.map((node) =>
          node.groupId !== null && removed.has(node.groupId) ? { ...node, groupId: null } : node,
        );
        break;
      }
      case 'addEdge':
        edges = [...edges, op.edge];
        break;
      case 'updateEdge': {
        const index = edges.findIndex((edge) => edge.id === op.id);
        if (index < 0) {
          issues.push(unknownEdge(op.id));
          break;
        }
        const current = edges[index] as CanvasEdge;
        const next: CanvasEdge = {
          ...current,
          // 空串与 null 同义：清空标签统一落 null（vault-format §8.2）
          ...(op.patch.label === undefined
            ? {}
            : { label: op.patch.label === '' ? null : op.patch.label }),
          ...(op.patch.arrow === undefined ? {} : { arrow: op.patch.arrow }),
        };
        edges = edges.map((edge, at) => (at === index ? next : edge));
        break;
      }
      case 'removeEdges': {
        const removed = new Set(op.ids);
        edges = edges.filter((edge) => !removed.has(edge.id));
        break;
      }
      case 'setViewport':
        viewport = op.viewport;
        break;
      case 'setTitle':
        title = op.title;
        break;
      case 'setGrid':
        grid = op.grid;
        break;
      case 'setBookmarks':
        bookmarks = op.bookmarks;
        break;
      default:
        break;
    }
  }

  const next: CanvasScene = { ...scene, title, viewport, grid, bookmarks, nodes, edges };
  const validationIssues = validateScene(next);
  const all = [...issues, ...validationIssues];
  if (all.length > 0) {
    return { ok: false, scene, issues: all, viewportOnly: false };
  }
  const viewportOnly = ops.length > 0 && ops.every((op) => op.type === 'setViewport');
  return { ok: true, scene: next, issues: [], viewportOnly };
};
