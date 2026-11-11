/**
 * 「打开浮窗切换列表」的进程内信号。
 * 触发方是画布上的满额提示条，接收方是左下角横排里的浮窗胶囊；
 * 两者分属不同组件树（提示条在 CanvasSurface 内，胶囊在 ToolRail 内），
 * 为此给 zustand store 添 UI 状态会扩大已有数据契约，改用最小信号通道。
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const subscribeFloatSwitcher = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const openFloatSwitcher = (): void => {
  for (const listener of listeners) listener();
};
