import {
  DEFAULT_POMODORO,
  POMODORO_BREAK_MAX,
  POMODORO_BREAK_MIN,
  POMODORO_FOCUS_MAX,
  POMODORO_FOCUS_MIN,
  type PomodoroPhase,
  type PomodoroState,
} from '../../data/stores/machine-store.ts';

const MINUTE_MS = 60_000;

export const clampFocusMinutes = (value: number): number =>
  Math.min(POMODORO_FOCUS_MAX, Math.max(POMODORO_FOCUS_MIN, Math.round(value)));

export const clampBreakMinutes = (value: number): number =>
  Math.min(POMODORO_BREAK_MAX, Math.max(POMODORO_BREAK_MIN, Math.round(value)));

/** 闭式剩余时间：只由 endTs - now 决定，不累加 tick，后台节流也不漂移 */
export const pomodoroRemainingMs = (endTs: number | null, now: number): number =>
  endTs === null ? 0 : Math.max(0, endTs - now);

/** 倒计时文案：向上取整到秒，避免最后 1 秒显示 00:00 却还在跑 */
export const pomodoroRemainingLabel = (remainingMs: number): string => {
  const totalSeconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

export const phaseDurationMs = (state: PomodoroState, phase: PomodoroPhase): number =>
  (phase === 'focus' ? state.focusMinutes : state.breakMinutes) * MINUTE_MS;

/** 开始新一轮：段索引回到 1，专注段从当前时刻起算 */
export const startPomodoro = (state: PomodoroState, now: number): PomodoroState => ({
  ...state,
  segment: 1,
  phase: 'focus',
  endTs: now + state.focusMinutes * MINUTE_MS,
});

/** 结束本轮：停在空闲态，保留时长设置 */
export const stopPomodoro = (state: PomodoroState): PomodoroState => ({
  ...state,
  segment: 1,
  phase: 'focus',
  endTs: null,
});

export interface PomodoroSettlement {
  readonly state: PomodoroState;
  /** 本次结算跨过的段数；进程关闭期间到点的段也计入 */
  readonly completed: number;
}

/**
 * 把已到点的段按闭式时间轴推到达点之后的下一段。
 * endTs 始终以「上一段终点 + 下一段时长」累加，保证重开应用后不是从 now 重新计时。
 * 关闭很久时会连续跨段，用 guard 防止异常值造成死循环。
 */
export const settlePomodoro = (state: PomodoroState, now: number): PomodoroSettlement => {
  if (state.endTs === null) return { state, completed: 0 };
  let current = state;
  let completed = 0;
  while (current.endTs !== null && current.endTs <= now && completed < 10_000) {
    const nextPhase: PomodoroPhase = current.phase === 'focus' ? 'break' : 'focus';
    current = {
      ...current,
      phase: nextPhase,
      segment: current.segment + 1,
      endTs: current.endTs + phaseDurationMs(current, nextPhase),
    };
    completed += 1;
  }
  return { state: current, completed };
};

/** 设置变更：只影响下一段，正在跑的 endTs 不因改时长而跳变 */
export const withPomodoroSettings = (
  state: PomodoroState,
  patch: { readonly focusMinutes?: number; readonly breakMinutes?: number },
): PomodoroState => ({
  ...state,
  focusMinutes:
    patch.focusMinutes === undefined ? state.focusMinutes : clampFocusMinutes(patch.focusMinutes),
  breakMinutes:
    patch.breakMinutes === undefined
      ? state.breakMinutes
      : clampBreakMinutes(patch.breakMinutes),
});

export { DEFAULT_POMODORO };
