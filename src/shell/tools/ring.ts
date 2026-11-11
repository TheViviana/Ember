import { isAudioRunning, sharedAudioContext } from './audio-engine.ts';

/**
 * 番茄钟铃声：WebAudio 现场合成的三组「滴滴」，不随包携带音频资产。
 * 复用 audio-engine 里已被用户手势解锁的共享上下文；
 * 上下文仍为 suspended（从未交互）时直接返回，提醒音缺位不影响计时。
 * 第一版未支持自定义铃声。
 */
export const playPomodoroRing = (): void => {
  const context = sharedAudioContext();
  if (context === null || !isAudioRunning()) return;
  try {
    const start = context.currentTime;
    for (let round = 0; round < 3; round += 1) {
      for (let beat = 0; beat < 2; beat += 1) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = round === 2 ? 1320 : 990;
        const at = start + round * 0.62 + beat * 0.18;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.3, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.16);
      }
    }
  } catch {
    // 调度失败（上下文已关闭等）：静默
  }
};
