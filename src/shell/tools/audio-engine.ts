/**
 * 共享音频上下文：铃声与白噪音共用同一个 AudioContext。
 *
 * WKWebView 的自动播放策略：AudioContext 在没有用户手势时创建会停在 suspended，
 * 之后必须由用户手势触发 resume 才能真正出声。所以这里在首次 pointerdown / keydown 时解锁，
 * 之后段结束的铃声与白噪音都复用这个已解锁的上下文；从未解锁则静默降级（不影响计时）。
 */
let context: AudioContext | null = null;
let installed = false;

const unlockListeners = new Set<() => void>();

const createContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext;
  if (Ctor === undefined) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
};

export const sharedAudioContext = (): AudioContext | null => {
  context ??= createContext();
  return context;
};

export const isAudioRunning = (): boolean => context !== null && context.state === 'running';

/** 在用户手势里调用：resume 成功才认为解锁 */
export const unlockAudio = async (): Promise<void> => {
  const ctx = sharedAudioContext();
  if (ctx === null) return;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    return;
  }
  if (ctx.state !== 'running') return;
  for (const listener of unlockListeners) listener();
};

export const onAudioUnlocked = (listener: () => void): (() => void) => {
  unlockListeners.add(listener);
  return () => {
    unlockListeners.delete(listener);
  };
};

/**
 * 安装一次性解锁监听：pointerdown 与 keydown 都算手势。
 * 解锁成功后自行移除，避免每次点击都走一遍 resume。
 */
export const installAudioUnlock = (): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  if (installed) return () => undefined;
  installed = true;

  const stop = (): void => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    window.removeEventListener('touchstart', onGesture, true);
    installed = false;
  };

  const onGesture = (): void => {
    void unlockAudio().then(() => {
      if (isAudioRunning()) stop();
    });
  };

  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  window.addEventListener('touchstart', onGesture, true);

  return stop;
};
