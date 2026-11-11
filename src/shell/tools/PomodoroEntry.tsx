import { useEffect, useState, type ReactElement } from 'react';
import {
  POMODORO_BREAK_MAX,
  POMODORO_BREAK_MIN,
  POMODORO_FOCUS_MAX,
  POMODORO_FOCUS_MIN,
  POMODORO_NOISE_TYPES,
  useMachineStore,
  type PomodoroNoise,
} from '../../data/stores/machine-store.ts';
import { installAudioUnlock, isAudioRunning, onAudioUnlocked } from './audio-engine.ts';
import { stopNoise, syncNoise, type NoiseKind } from './noise.ts';
import {
  pomodoroRemainingLabel,
  pomodoroRemainingMs,
  settlePomodoro,
  startPomodoro,
  stopPomodoro,
  withPomodoroSettings,
} from './pomodoro.ts';
import { playPomodoroRing } from './ring.ts';
import styles from './ToolEntry.module.css';

const NOISE_LABEL: Record<PomodoroNoise, string> = {
  off: '关闭',
  white: '白噪声',
  pink: '粉噪声',
};

const ClockIcon = (): ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 4.8V8l2.1 1.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const FOCUS_PRESETS = [15, 25, 45, 60] as const;

export interface PomodoroEntryProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
}

/**
 * 番茄钟入口：闭式计时（endTs - now），设置与当前段一起存机器本地 ui.json。
 * 跨重启：重开时若 endTs 未到点就接着倒计时；已过点则按已结束处理，
 * 沿时间轴顺延到下一段（关闭很久会连续顺延，不重新从 now 起算）。
 * 只提供按钮与浮层锚点；排在左下角哪一格由 ToolRail 的 flex 顺序决定。
 */
export const PomodoroEntry = ({ open, onToggle, onClose }: PomodoroEntryProps): ReactElement => {
  const pomodoro = useMachineStore((state) => state.pomodoro);
  const [now, setNow] = useState(() => Date.now());
  /** 音频是否已由用户手势解锁；解锁后重跑噪声同步 */
  const [audioReady, setAudioReady] = useState(isAudioRunning);

  useEffect(() => {
    const stopUnlock = installAudioUnlock();
    const offUnlocked = onAudioUnlocked(() => {
      setAudioReady(true);
    });
    return () => {
      stopUnlock();
      offUnlocked();
      stopNoise();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  // 到点结算：每次 tick 都检查；水合恢复的过期 endTs 也会走到这里
  useEffect(() => {
    if (pomodoro.endTs === null || pomodoro.endTs > now) return;
    const settlement = settlePomodoro(pomodoro, now);
    if (settlement.completed === 0) return;
    playPomodoroRing();
    useMachineStore.getState().setPomodoro(settlement.state);
  }, [now, pomodoro]);

  const remaining = pomodoroRemainingMs(pomodoro.endTs, now);
  const running = pomodoro.endTs !== null && remaining > 0;
  const focus = pomodoro.phase === 'focus';
  /** 只在专注段播放；休息、结束、关闭都回落到 null */
  const noiseDesired: NoiseKind | null =
    running && focus && pomodoro.noise !== 'off' ? pomodoro.noise : null;

  useEffect(() => {
    syncNoise(noiseDesired, pomodoro.noiseVolume);
  }, [noiseDesired, pomodoro.noiseVolume, audioReady]);

  const updateMinutes = (patch: { readonly focusMinutes?: number; readonly breakMinutes?: number }): void => {
    useMachineStore.getState().setPomodoro(withPomodoroSettings(pomodoro, patch));
  };

  const readMinutes = (raw: string): number | null => {
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  };

  return (
    <div className={styles.slot}>
      <button
        type="button"
        className={styles.entry}
        aria-expanded={open}
        aria-label={
          running
            ? `番茄钟：第 ${pomodoro.segment} 段${focus ? '专注' : '休息'}中，剩余 ${pomodoroRemainingLabel(remaining)}`
            : '打开番茄钟'
        }
        title={
          running
            ? `第 ${pomodoro.segment} 段 · ${focus ? '专注' : '休息'} · 剩余 ${pomodoroRemainingLabel(remaining)}`
            : '番茄钟：专注 / 休息时长与倒计时'
        }
        onClick={onToggle}
      >
        {running ? (
          <span className={styles.pomoRunningLabel}>
            {focus ? '专注' : '休息'} {pomodoroRemainingLabel(remaining)}
          </span>
        ) : (
          <>
            <ClockIcon />
            <span>番茄钟</span>
          </>
        )}
      </button>

      {open ? (
        <section className={styles.panel} role="dialog" aria-label="番茄钟">
          <header className={styles.head}>
            <h2 className={styles.title}>番茄钟</h2>
            <button type="button" className={styles.close} aria-label="关闭番茄钟" onClick={onClose}>
              ×
            </button>
          </header>

          <div className={styles.pomoGrid}>
            <label className={styles.pomoField}>
              <span className={styles.pomoLabel}>专注</span>
              <span className={styles.pomoNumber}>
                <input
                  type="number"
                  className={styles.pomoInput}
                  min={POMODORO_FOCUS_MIN}
                  max={POMODORO_FOCUS_MAX}
                  step={1}
                  value={pomodoro.focusMinutes}
                  aria-label="专注时长（分钟）"
                  onChange={(event) => {
                    const value = readMinutes(event.target.value);
                    if (value !== null) updateMinutes({ focusMinutes: value });
                  }}
                />
                分
              </span>
            </label>
            <label className={styles.pomoField}>
              <span className={styles.pomoLabel}>休息</span>
              <span className={styles.pomoNumber}>
                <input
                  type="number"
                  className={styles.pomoInput}
                  min={POMODORO_BREAK_MIN}
                  max={POMODORO_BREAK_MAX}
                  step={1}
                  value={pomodoro.breakMinutes}
                  aria-label="休息时长（分钟）"
                  onChange={(event) => {
                    const value = readMinutes(event.target.value);
                    if (value !== null) updateMinutes({ breakMinutes: value });
                  }}
                />
                分
              </span>
            </label>
          </div>

          <div className={styles.presets} role="group" aria-label="专注时长快捷档">
            {FOCUS_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                className={`${styles.preset} ${pomodoro.focusMinutes === minutes ? styles.presetActive : ''}`}
                onClick={() => {
                  updateMinutes({ focusMinutes: minutes });
                }}
              >
                {minutes} 分
              </button>
            ))}
          </div>

          <div className={styles.pomoNoise}>
            <label className={styles.pomoField}>
              <span className={styles.pomoLabel}>白噪音</span>
              <select
                className={styles.pomoSelect}
                value={pomodoro.noise}
                aria-label="白噪音类型"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (next === 'off' || next === 'white' || next === 'pink') {
                    useMachineStore.getState().setPomodoro({ ...pomodoro, noise: next });
                  }
                }}
              >
                {POMODORO_NOISE_TYPES.map((kind) => (
                  <option key={kind} value={kind}>
                    {NOISE_LABEL[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.pomoField}>
              <span className={styles.pomoLabel}>音量</span>
              <input
                type="range"
                className={styles.pomoRange}
                min={0}
                max={100}
                step={5}
                value={Math.round(pomodoro.noiseVolume * 100)}
                aria-label="白噪音音量"
                disabled={pomodoro.noise === 'off'}
                onChange={(event) => {
                  useMachineStore
                    .getState()
                    .setPomodoro({ ...pomodoro, noiseVolume: Number(event.currentTarget.value) / 100 });
                }}
              />
              <span className={styles.pomoValue}>{Math.round(pomodoro.noiseVolume * 100)}%</span>
            </label>
          </div>

          {running ? (
            <div className={styles.pomoStatus}>
              <div className={styles.pomoStatusText}>
                <span className={styles.pomoSegment}>
                  第 {pomodoro.segment} 段 · {focus ? '专注中' : '休息中'}
                </span>
                <span className={styles.pomoRemaining}>{pomodoroRemainingLabel(remaining)}</span>
              </div>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => {
                  useMachineStore.getState().setPomodoro(stopPomodoro(pomodoro));
                }}
              >
                结束本轮
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => {
                useMachineStore.getState().setPomodoro(startPomodoro(pomodoro, Date.now()));
                onClose();
              }}
            >
              开始专注 {pomodoro.focusMinutes} 分钟
            </button>
          )}

          <p className={styles.note}>
            闭式计时（endTs − now），切页或锁屏不漂移；重开应用没到点会接着走，已过点按已结束处理并顺延到下一段。
          </p>
          <p className={styles.note}>
            铃声与白噪音都是 WebAudio 现场合成，不携带音频文件；白噪音只在专注段播放，休息段与结束本轮自动停。
            首次点击界面后音频才解锁（WKWebView 自动播放限制），未解锁时静默、不强播。
          </p>
        </section>
      ) : null}
    </div>
  );
};
