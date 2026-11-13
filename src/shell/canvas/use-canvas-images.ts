import { useCallback, useEffect, type RefObject } from 'react';
import { createUlid, type CanvasId } from '#doc-model';
import type { CanvasScene } from '#canvas-engine';
import { useQueryClient } from '@tanstack/react-query';
import { saveAsset } from '../../data/tauri/asset-port.ts';
import type { KernelContext } from '../../kernel/context.ts';
import { screenToWorld, snapValue } from './geometry.ts';

export interface CanvasImagesOptions {
  readonly canvasId: CanvasId | null;
  readonly kernel: KernelContext;
  readonly viewportRef: RefObject<{ x: number; y: number; zoom: number }>;
  readonly sceneRef: RefObject<CanvasScene | null>;
  readonly showError: (message: string) => void;
  readonly surfaceRef: RefObject<HTMLDivElement | null>;
}

/** DataTransfer.files 是 FileList（ArrayLike<File>）；React DragEvent 与原生 ClipboardEvent 都兼容 */
interface DropLikeEvent {
  preventDefault(): void;
  clientX: number;
  clientY: number;
  dataTransfer: { files: ArrayLike<File> } | null;
}

/**
 * 图片入库落节点：拖入与 ⌘V 粘贴共用的核心。
 * asset_save 内容去重 → 失效资产列表（附件面板免重开）→ 依次落图片节点。
 * 拖放走 onDropFiles；粘贴挂 window paste —— 编辑器内的图片粘贴由编辑器自己
 * preventDefault，这里的 defaultPrevented 守卫避免一次粘贴落两张。
 */
export const useCanvasImages = (
  options: CanvasImagesOptions,
): { readonly onDropFiles: (event: DropLikeEvent) => void } => {
  const { canvasId, kernel, viewportRef, sceneRef, showError, surfaceRef } = options;
  const queryClient = useQueryClient();

  const insertImageFiles = useCallback(
    (files: readonly File[], at: { readonly x: number; readonly y: number }): void => {
      if (canvasId === null) return;
      const grid = sceneRef.current?.grid ?? { size: 8, snap: false };
      let z = (sceneRef.current?.nodes.reduce((max, node) => Math.max(max, node.z), 0) ?? 0) + 1;
      for (const [offset, file] of files.entries()) {
        void (async () => {
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
              reader.onerror = () => reject(new Error('读取文件失败'));
              reader.readAsDataURL(file);
            });
            const marker = 'base64,';
            const markerAt = dataUrl.indexOf(marker);
            if (markerAt < 0) throw new Error('不是可用的 data URL');
            const saved = await saveAsset(dataUrl.slice(markerAt + marker.length), file.type);
            const world = screenToWorld(
              { x: at.x + offset * 24, y: at.y + offset * 24 },
              viewportRef.current,
            );
            const node = {
              id: `n_${createUlid()}`,
              kind: 'image' as const,
              docId: null,
              text: null,
              rect: {
                x: snapValue(world.x, grid),
                y: snapValue(world.y, grid),
                w: 320,
                h: 220,
              },
              z,
              groupId: null,
              meta: { assetPath: saved.path },
            };
            z += 1;
            await kernel.canvas.apply(canvasId, [{ type: 'addNode', node }]);
            if (saved.deduped) showError('内容已存在，直接复用库内图片');
            void queryClient.invalidateQueries({ queryKey: ['assets'] });
          } catch (cause) {
            showError(`导入图片失败：${String(cause)}`);
          }
        })();
      }
    },
    [canvasId, kernel, queryClient, viewportRef, sceneRef, showError],
  );

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (canvasId === null) return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null) {
        return;
      }
      const clipboard = event.clipboardData;
      if (clipboard === null) return;
      const files = Array.from(clipboard.files).filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return;
      const element = surfaceRef.current;
      if (element === null) return;
      event.preventDefault();
      insertImageFiles(files, { x: element.clientWidth / 2, y: element.clientHeight / 2 });
    };
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('paste', onPaste);
    };
  }, [canvasId, insertImageFiles, surfaceRef]);

  const onDropFiles = useCallback(
    (event: DropLikeEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return;
      const element = surfaceRef.current;
      if (element === null) return;
      const bounds = element.getBoundingClientRect();
      event.preventDefault();
      insertImageFiles(files, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    },
    [insertImageFiles, surfaceRef],
  );

  return { onDropFiles };
};
