/**
 * 编辑器只在正文容器真正有盒子之后创建：
 * 浮窗刚挂载时可能尚在阅读态（display:none），或还没应用记忆尺寸，
 * CodeMirror 会按那一刻的高度算视口与高度图，之后浮窗变大也不会再补算，
 * 表现就是只剩行号、正文不画、滚轮也没有可滚的高度。
 * 之后容器每次变尺寸都主动补一次测量，不靠延时兜底。
 */
export interface FloatHostBox {
  /** 盒子可见后 resolve；容器一直没尺寸就保持挂起，由调用方随卸载放弃 */
  readonly wait: () => Promise<void>;
  /** 停止观察并放弃等待 */
  readonly dispose: () => void;
}

export const observeFloatHostBox = (host: HTMLElement, remeasure: () => void): FloatHostBox => {
  let resolveBox: (() => void) | null = null;
  const observer = new ResizeObserver(() => {
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    if (resolveBox !== null) {
      const resolve = resolveBox;
      resolveBox = null;
      resolve();
    }
    remeasure();
  });
  observer.observe(host);
  return {
    wait: () =>
      new Promise((resolve) => {
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          resolve();
          return;
        }
        resolveBox = resolve;
      }),
    dispose: () => {
      observer.disconnect();
      resolveBox = null;
    },
  };
};
