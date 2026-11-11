import { useRef, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { RESIZE_ZONES, resolveResize, type ResizeZone, type WindowFrame } from './resize.ts';
import { windowApi } from './window-api.ts';
import styles from './WindowChrome.module.css';

interface Session {
  readonly zone: ResizeZone;
  readonly start: WindowFrame;
  readonly origin: { readonly x: number; readonly y: number };
}

/**
 * 自绘窗口缩放的 8 个热区（边 6px、角 12px）。
 *
 * 跟手性依赖两点：
 * 1. 用屏幕坐标的「总位移」而不是逐帧增量 —— 窗口被移动时 WebKit 会补发
 *    clientX 变化的合成事件，增量算法会在此处抖动，总量算法不受影响；
 * 2. 每个动画帧最多发一条 IPC，且只发最新一帧（latest wins），
 *    避免 IPC 排队导致窗口落后于指针。
 */
export const WindowChrome = (): ReactElement | null => {
  const session = useRef<Session | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const latest = useRef<WindowFrame | null>(null);
  const frameHandle = useRef(0);
  const dragging = useRef(false);

  const flush = (): void => {
    frameHandle.current = 0;
    const frame = latest.current;
    latest.current = null;
    if (frame !== null) void windowApi.applyFrame(frame);
  };

  const schedule = (frame: WindowFrame): void => {
    latest.current = frame;
    if (frameHandle.current !== 0) return;
    frameHandle.current = window.requestAnimationFrame(flush);
  };

  const track = (): void => {
    const current = session.current;
    const point = pointer.current;
    if (current === null || point === null) return;
    schedule(
      resolveResize(
        current.zone,
        current.start,
        point.x - current.origin.x,
        point.y - current.origin.y,
      ),
    );
  };

  const onPointerDown = (zone: ResizeZone, event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const origin = { x: event.screenX, y: event.screenY };
    pointer.current = origin;
    dragging.current = true;
    session.current = null;

    // 起始 frame 有一次异步读取；期间指针可能已经移动，读到后立即补算。
    void windowApi.readFrame().then((frame) => {
      if (!dragging.current) return;
      if (frame === null) {
        dragging.current = false;
        return;
      }
      session.current = { zone, start: frame, origin };
      track();
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    pointer.current = { x: event.screenX, y: event.screenY };
    track();
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    session.current = null;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (frameHandle.current !== 0) {
      window.cancelAnimationFrame(frameHandle.current);
      frameHandle.current = 0;
    }
    flush();
  };

  /** 捕获被系统抢走（IME/辅助功能/DOM 重建）：就地收尾，把已排程的帧落盘 */
  const onCaptureLost = (): void => {
    if (!dragging.current) return;
    dragging.current = false;
    session.current = null;
    pointer.current = null;
    if (frameHandle.current !== 0) {
      window.cancelAnimationFrame(frameHandle.current);
      frameHandle.current = 0;
    }
    flush();
  };

  if (!windowApi.native) return null;

  return (
    <div className={styles.chrome} aria-hidden="true">
      {RESIZE_ZONES.map((zone) => (
        <div
          key={zone}
          data-zone={zone}
          className={styles.zone}
          onPointerDown={(event) => {
            onPointerDown(zone, event);
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onCaptureLost}
        />
      ))}
    </div>
  );
};
