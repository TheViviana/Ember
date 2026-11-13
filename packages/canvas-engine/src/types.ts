import type { CanvasId, DocId } from '../../doc-model/src/ids.ts';

/** 画布几何与场景类型（kernel-contract §5），内核只做装配与持久化桥接 */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasRect extends CanvasPoint {
  readonly w: number;
  readonly h: number;
}

export interface Viewport extends CanvasPoint {
  readonly zoom: number;
}

/** 网格与吸附；与 vault-format §8.1 的 ui.canvasGrid 同形 */
export interface CanvasGrid {
  readonly size: 8 | 16 | 32;
  readonly snap: boolean;
}

/** v1 内置 'doc' | 'note' | 'group'；能力可注册自定义类型 */
export type CanvasNodeKind = string;

export interface CanvasNode {
  readonly id: string;
  readonly kind: CanvasNodeKind;
  readonly rect: CanvasRect;
  readonly z: number;
  readonly docId: DocId | null;
  readonly text: string | null;
  /** 所属组节点 id；一个节点最多属于一个组，组不能嵌套（vault-format §8.2） */
  readonly groupId: string | null;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
  readonly arrow: 'none' | 'end' | 'both';
  readonly kind: 'relation';
  readonly meta: Readonly<Record<string, unknown>>;
}

/** 画布过滤条件：按标签 / 节点类型 / 关键词临时高亮或隐藏（视图书签可一并保存） */
export interface CanvasFilters {
  readonly tags: readonly string[];
  readonly kinds: readonly string[];
  readonly text: string;
  readonly mode: 'dim' | 'hide';
}

/** 视图书签：命名的观察角度（镜头位置 + 缩放 + 过滤条件） */
export interface CanvasBookmark {
  readonly id: string;
  readonly name: string;
  readonly viewport: Viewport;
  readonly filters: CanvasFilters | null;
}

export interface CanvasScene {
  readonly id: CanvasId;
  readonly title: string;
  readonly viewport: Viewport;
  readonly grid: CanvasGrid;
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  /** 视图书签；画布只存摆放，书签也只存镜头与过滤，不承载正文 */
  readonly bookmarks: readonly CanvasBookmark[];
}

/** 磁盘上的画布文档：scene 之外还有时间戳、schema 与能力私有数据（写入时原样保留） */
export interface CanvasDocument {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scene: CanvasScene;
  readonly capabilityData: Readonly<Record<string, unknown>>;
}

export interface CanvasFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly viewport: Viewport;
  readonly size: { readonly w: number; readonly h: number };
  readonly scene: CanvasScene;
  readonly dpr: number;
}

/** 图层必须纯绘制：不得改场景、不得发 IPC（不变量 V1） */
export interface CanvasLayer {
  readonly id: string;
  readonly zIndex: number;
  draw(frame: CanvasFrame): void;
  hitTest?(point: CanvasPoint, frame: CanvasFrame): string | null;
}
