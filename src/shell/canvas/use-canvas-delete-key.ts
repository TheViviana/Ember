import { useEffect, type MutableRefObject } from 'react';
import type { CanvasMutation } from '#canvas-engine';
import type { CanvasId } from '#doc-model';
import { useKernel } from '../kernel-provider.tsx';
import { isTypingTarget } from './surface-hit.ts';

export interface CanvasDeleteKeyOptions {
  /** 手势进行中不劫持按键：拖动 / 连线草稿尚未提交，删除会错位 */
  readonly gestureActiveRef: MutableRefObject<unknown>;
  readonly connectActiveRef: MutableRefObject<unknown>;
  readonly canvasId: CanvasId | null;
  readonly selectedNodes: ReadonlySet<string>;
  readonly selectedEdgeId: string | null;
  readonly onDeleted: () => void;
  readonly reportError: (cause: unknown) => void;
}

/**
 * Delete / Backspace：删除选中的连线或节点。
 * 输入框内不劫持；抽成独立 hook 是为了让 use-canvas-gestures 保持在 size 门禁限制内。
 */
export const useCanvasDeleteKey = (options: CanvasDeleteKeyOptions): void => {
  const {
    gestureActiveRef,
    connectActiveRef,
    canvasId,
    selectedNodes,
    selectedEdgeId,
    onDeleted,
    reportError,
  } = options;
  const kernel = useKernel();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isTypingTarget(event.target)) return;
      if (gestureActiveRef.current !== null || connectActiveRef.current !== null) return;
      if (canvasId === null) return;
      if (selectedEdgeId === null && selectedNodes.size === 0) return;
      event.preventDefault();
      const mutations: CanvasMutation[] = [];
      if (selectedEdgeId !== null) mutations.push({ type: 'removeEdges', ids: [selectedEdgeId] });
      if (selectedNodes.size > 0) mutations.push({ type: 'removeNodes', ids: [...selectedNodes] });
      void kernel.canvas
        .apply(canvasId, mutations)
        .then(onDeleted)
        .catch(reportError);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [canvasId, connectActiveRef, gestureActiveRef, kernel, onDeleted, reportError, selectedEdgeId, selectedNodes]);
};
