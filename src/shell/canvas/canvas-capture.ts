/**
 * 快捷捕获信号：命令需要「当前画布 + 当前镜头中心」落新文章；
 * 视口状态在 CanvasSurface 内部，经此信号按需取用。画布未就绪时返回 null。
 */
export interface CapturePoint {
  readonly canvasId: string;
  /** 世界坐标（已按网格吸附），新节点左上角 */
  readonly point: { readonly x: number; readonly y: number };
  readonly z: number;
}

let provider: (() => CapturePoint | null) | null = null;

export const registerCaptureProvider = (fn: () => CapturePoint | null): { dispose: () => void } => {
  provider = fn;
  return {
    dispose: (): void => {
      if (provider === fn) provider = null;
    },
  };
};

export const readCapturePoint = (): CapturePoint | null => provider?.() ?? null;
