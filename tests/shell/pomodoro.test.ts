import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_POMODORO, type PomodoroState } from '../../src/data/stores/machine-store.ts';
import {
  clampBreakMinutes,
  clampFocusMinutes,
  pomodoroRemainingLabel,
  pomodoroRemainingMs,
  settlePomodoro,
  startPomodoro,
  stopPomodoro,
  withPomodoroSettings,
} from '../../src/shell/tools/pomodoro.ts';

const MINUTE = 60_000;

const state = (patch: Partial<PomodoroState> = {}): PomodoroState => ({
  ...DEFAULT_POMODORO,
  ...patch,
});

void test('剩余时间只由 endTs - now 计算，且不会为负', () => {
  assert.equal(pomodoroRemainingMs(10_000, 4_000), 6_000);
  assert.equal(pomodoroRemainingMs(10_000, 12_000), 0);
  assert.equal(pomodoroRemainingMs(null, 12_000), 0);
});

void test('倒计时文案向上取整到秒，最后一秒不显示 00:00', () => {
  assert.equal(pomodoroRemainingLabel(0), '00:00');
  assert.equal(pomodoroRemainingLabel(1), '00:01');
  assert.equal(pomodoroRemainingLabel(999), '00:01');
  assert.equal(pomodoroRemainingLabel(60_000), '01:00');
  assert.equal(pomodoroRemainingLabel(90_500), '01:31');
});

void test('时长夹到合法区间', () => {
  assert.equal(clampFocusMinutes(0), 1);
  assert.equal(clampFocusMinutes(999), 180);
  assert.equal(clampFocusMinutes(24.6), 25);
  assert.equal(clampBreakMinutes(-5), 1);
  assert.equal(clampBreakMinutes(90), 60);
});

void test('开始一轮：段索引回到 1，专注从当前时刻起算', () => {
  const started = startPomodoro(state({ focusMinutes: 45 }), 1_000);
  assert.deepEqual(started, {
    focusMinutes: 45,
    breakMinutes: 5,
    segment: 1,
    phase: 'focus',
    endTs: 1_000 + 45 * MINUTE,
    noise: 'off',
    noiseVolume: 0.3,
  });
});

void test('结束本轮：停在空闲态，保留时长设置', () => {
  const stopped = stopPomodoro(state({ segment: 4, phase: 'break', endTs: 9_999, focusMinutes: 30 }));
  assert.equal(stopped.endTs, null);
  assert.equal(stopped.segment, 1);
  assert.equal(stopped.phase, 'focus');
  assert.equal(stopped.focusMinutes, 30);
});

void test('未到点不结算', () => {
  const running = state({ endTs: 10_000 });
  const settled = settlePomodoro(running, 9_999);
  assert.equal(settled.completed, 0);
  assert.equal(settled.state, running);
});

void test('专注到点后进入休息段，终点按上一段终点累加而不是 now', () => {
  const end = 10_000;
  const settled = settlePomodoro(state({ endTs: end }), end + 1_000);
  assert.equal(settled.completed, 1);
  assert.equal(settled.state.phase, 'break');
  assert.equal(settled.state.segment, 2);
  assert.equal(settled.state.endTs, end + 5 * MINUTE);
});

void test('关闭很久后重开：连续顺延到未来段，不从 now 重新计时', () => {
  const end = 1_000_000;
  const settled = settlePomodoro(state({ endTs: end }), end + 31 * MINUTE);
  assert.equal(settled.completed, 3);
  assert.equal(settled.state.phase, 'break');
  assert.equal(settled.state.segment, 4);
  assert.equal(settled.state.endTs, end + 35 * MINUTE);
});

void test('空闲态结算保持空闲', () => {
  const idle = state();
  const settled = settlePomodoro(idle, 5_000);
  assert.equal(settled.completed, 0);
  assert.equal(settled.state, idle);
});

void test('改时长让下一段生效，不推翻正在跑的 endTs', () => {
  const running = state({ focusMinutes: 25, endTs: 88_000 });
  const next = withPomodoroSettings(running, { focusMinutes: 50, breakMinutes: 0 });
  assert.equal(next.focusMinutes, 50);
  assert.equal(next.breakMinutes, 1);
  assert.equal(next.endTs, 88_000);
});
