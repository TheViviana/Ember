import { useCallback, useEffect, useRef, useState } from 'react';

/** DEV：拖动期间的 rAF 帧间隔采样，用来量化卡顿（生产构建不启动） */
interface ProbeState {
  readonly frames: number[];
  raf: number | null;
  last: number;
  readonly handler: number[];
  readonly latency: number[];
}

export interface DragPerf {
  readonly avg: number;
  readonly p95: number;
  readonly dropped: number;
  readonly max: number;
  readonly frames: number;
  readonly latency: number;
  readonly handler: number;
}

export interface DragProbe {
  /** 空闲刷新基线（毫秒）：区分「本机就是 30Hz」和「拖动掉帧」 */
  readonly refreshMs: number | null;
  readonly dragPerf: DragPerf | null;
  readonly start: () => void;
  readonly stop: () => void;
  readonly markHandler: (started: number) => void;
  readonly markLatency: (assigned: number) => void;
}

/** 画布拖动性能探针：只在 DEV 生效，生产构建下所有入口都是空操作 */
export const useDragProbe = (): DragProbe => {
  const probeRef = useRef<ProbeState | null>(null);
  const [dragPerf, setDragPerf] = useState<DragPerf | null>(null);
  const [refreshMs, setRefreshMs] = useState<number | null>(null);

  const start = useCallback((): void => {
    if (!import.meta.env.DEV) return;
    const frames: number[] = [];
    const tick = (time: number): void => {
      const current = probeRef.current;
      if (current === null) return;
      if (current.last > 0) frames.push(time - current.last);
      current.last = time;
      current.raf = requestAnimationFrame(tick);
    };
    probeRef.current = {
      frames,
      raf: requestAnimationFrame(tick),
      last: 0,
      handler: [],
      latency: [],
    };
  }, []);

  const stop = useCallback((): void => {
    const current = probeRef.current;
    if (current === null) return;
    probeRef.current = null;
    if (current.raf !== null) cancelAnimationFrame(current.raf);
    if (current.frames.length === 0) return;
    const avg = current.frames.reduce((sum, value) => sum + value, 0) / current.frames.length;
    const mean = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    const sorted = [...current.frames].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? avg;
    const dropped = current.frames.filter((value) => value > 40).length / current.frames.length;
    setDragPerf({
      avg,
      p95,
      dropped,
      max: Math.max(...current.frames),
      frames: current.frames.length,
      latency: mean(current.latency),
      handler: mean(current.handler),
    });
  }, []);

  /** DEV：一次 pointermove 的同步处理耗时（提交本身在帧末，已计入响应延迟） */
  const markHandler = useCallback((started: number): void => {
    if (!import.meta.env.DEV || probeRef.current === null) return;
    probeRef.current.handler.push(performance.now() - started);
  }, []);

  const markLatency = useCallback((assigned: number): void => {
    if (!import.meta.env.DEV || probeRef.current === null) return;
    probeRef.current.latency.push(performance.now() - assigned);
  }, []);

  // DEV：挂载后采样 40 帧，得到本机空闲刷新间隔作为对照基线
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    let last = 0;
    let raf = 0;
    const samples: number[] = [];
    const tick = (time: number): void => {
      if (last > 0) samples.push(time - last);
      last = time;
      if (samples.length < 40) {
        raf = requestAnimationFrame(tick);
        return;
      }
      setRefreshMs(samples.reduce((sum, value) => sum + value, 0) / samples.length);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  return { refreshMs, dragPerf, start, stop, markHandler, markLatency };
};
