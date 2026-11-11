import { isAudioRunning, sharedAudioContext } from './audio-engine.ts';

export type NoiseKind = 'white' | 'pink';

/** 循环缓冲 4 秒，足够长且生成成本低 */
const BUFFER_SECONDS = 4;
const FADE_SECONDS = 0.25;

/**
 * 本地合成噪声样本：白噪声是均匀随机；粉噪声用 Paul Kellet 近似滤波器（-3 dB/oct）。
 * 纯函数，随机源可注入，便于单测。
 */
export const fillNoiseSamples = (
  kind: NoiseKind,
  length: number,
  random: () => number,
): Float32Array => {
  const samples = new Float32Array(Math.max(0, Math.floor(length)));
  if (kind === 'white') {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = random() * 2 - 1;
    }
    return samples;
  }
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
    samples[index] = Math.max(-1, Math.min(1, pink));
  }
  return samples;
};

let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let playing: NoiseKind | null = null;
let volume = 0;

/** 停止并淡出；source 为 null 时是幂等的 */
export const stopNoise = (): void => {
  const context = sharedAudioContext();
  const node = source;
  const nodeGain = gain;
  source = null;
  gain = null;
  playing = null;
  if (node === null) return;
  if (context === null || context.state !== 'running') {
    try {
      node.stop();
    } catch {
      // 已停止
    }
    return;
  }
  try {
    nodeGain?.gain.cancelScheduledValues(context.currentTime);
    nodeGain?.gain.setTargetAtTime(0.0001, context.currentTime, FADE_SECONDS / 3);
    window.setTimeout(() => {
      try {
        node.stop();
      } catch {
        // 已停止
      }
    }, FADE_SECONDS * 1000);
  } catch {
    try {
      node.stop();
    } catch {
      // 已停止
    }
  }
};

/**
 * 让实际播放状态对齐期望：desired 为 null 表示应停止。
 * 未解锁或类型未变时只调整音量，不重建节点；重复调用是幂等的。
 */
export const syncNoise = (desired: NoiseKind | null, nextVolume: number): void => {
  const context = sharedAudioContext();
  const safeVolume = Math.min(1, Math.max(0, nextVolume));
  volume = safeVolume;
  if (desired === null || context === null || !isAudioRunning()) {
    stopNoise();
    return;
  }
  if (source !== null && playing === desired) {
    try {
      gain?.gain.setTargetAtTime(safeVolume, context.currentTime, 0.05);
    } catch {
      // 上下文已关闭：下一次 tick 会重建
    }
    return;
  }
  stopNoise();

  try {
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * BUFFER_SECONDS), context.sampleRate);
    buffer.getChannelData(0).set(fillNoiseSamples(desired, buffer.length, Math.random));
    const nodeGain = context.createGain();
    const start = context.currentTime;
    nodeGain.gain.setValueAtTime(0.0001, start);
    nodeGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, safeVolume), start + FADE_SECONDS);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(nodeGain).connect(context.destination);
    node.start();
    source = node;
    gain = nodeGain;
    playing = desired;
  } catch {
    stopNoise();
  }
};

/** 当前音量（同步给 UI 状态用） */
export const noiseVolume = (): number => volume;
