import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowFrame, WindowPort } from '../../kernel/ports.ts';

/**
 * 无边框窗口的原生能力适配层（data 层持有 Tauri import，外壳只经 WindowPort 调用）。
 *
 * 拖拽与双击最大化不在这里：交给 Tauri 的 `data-tauri-drag-region`，
 * 它内置了 macOS「双击后指针一移动就取消最大化」的修正（tauri#8306）。
 *
 * 缩放必须自实现，原因：
 * tao 的 `drag_resize_window` 在 macOS 直接返回 `Err(NotSupported)`，
 * 而 tauri-runtime-wry 用 `let _ =` 丢弃该错误 —— 前端 `startResizeDragging()`
 * 会「成功返回但窗口不动」。所以走自绘 8 向热区 + `window_resize_frame`，
 * 一条 IPC 同时落位置与尺寸，避免两帧撕裂。
 */
const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const createTauriWindowPort = (): WindowPort => ({
  get native() {
    return inTauri();
  },

  close: async () => {
    if (!inTauri()) return;
    await getCurrentWindow().close();
  },

  minimize: async () => {
    if (!inTauri()) return;
    await getCurrentWindow().minimize();
  },

  toggleZoom: async () => {
    if (!inTauri()) return;
    // 无边框窗口在 tao 里会走 setFrame(visibleFrame) 分支，
    // 最大化后的 frame 与 visibleFrame 严格相等，因此 is_maximized 能正确回读、可再点回来。
    await getCurrentWindow().toggleMaximize();
  },

  readFrame: async (): Promise<WindowFrame | null> => {
    if (!inTauri()) return null;
    const current = getCurrentWindow();
    const scale = await current.scaleFactor();
    const position = (await current.outerPosition()).toLogical(scale);
    const size = (await current.innerSize()).toLogical(scale);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  },

  applyFrame: async (frame) => {
    if (!inTauri()) return;
    await invoke('window_resize_frame', {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    });
  },

  onCloseRequested: async (handler) => {
    if (!inTauri()) return () => undefined;
    // 不调用 preventDefault 时，Tauri 会等异步回调结束再销毁窗口
    return getCurrentWindow().onCloseRequested(async () => {
      try {
        await handler();
      } catch {
        // 收尾失败也要允许关闭；具体错误由各自的写入流程上报
      }
    });
  },
});
