import type { CanvasEdge, CanvasNode } from '#canvas-engine';

export interface CanvasClipboard {
  readonly nodes: readonly CanvasNode[];
  /** 只包含两端都在 nodes 里的连线 */
  readonly edges: readonly CanvasEdge[];
}

let clipboard: CanvasClipboard | null = null;

export const readClipboard = (): CanvasClipboard | null => clipboard;

export const writeClipboard = (value: CanvasClipboard): void => {
  clipboard = value;
};
