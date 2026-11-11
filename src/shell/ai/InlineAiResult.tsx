import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { placeSubmenu } from '../canvas/menu-placement.ts';
import type { InlineRun } from './use-inline-ai.ts';
import styles from './InlineAiResult.module.css';

interface InlineAiResultProps {
  readonly run: InlineRun;
  readonly onStop: () => void;
  readonly onDiscard: () => void;
  readonly onApply: () => void;
  readonly onUndo: () => void;
  readonly onClose: () => void;
}

/** 选区与内联块之间的视觉间隙，与选区菜单一致 */
const SELECTION_GAP = 6;

/**
 * 选区 AI 的内联结果块：紧贴选区下方流式产出，字号小于正文。
 * 定位复用 placeSubmenu，放不下时向左翻 / 上翻，始终留在浮窗内。
 */
export const InlineAiResult = ({
  run,
  onStop,
  onDiscard,
  onApply,
  onUndo,
  onClose,
}: InlineAiResultProps): ReactElement => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
  /** 替换完成后收成贴底撤销条：不参与选区定位，也就不可能压住正文 */
  const docked = run.phase === 'replaced';

  useLayoutEffect(() => {
    if (docked) return undefined;
    const element = ref.current;
    const parent = element?.parentElement;
    if (element === null || parent === null || parent === undefined) return undefined;
    const place = (): void => {
      const baseY = run.anchor.top + run.anchor.height + SELECTION_GAP;
      const placed = placeSubmenu({
        container: { width: parent.clientWidth, height: parent.clientHeight },
        level: { left: run.anchor.left, top: baseY, width: run.anchor.width, height: 0 },
        anchor: { top: baseY, bottom: baseY },
        submenu: { width: element.offsetWidth, height: element.offsetHeight },
      });
      setPlacement((current) =>
        current !== null && current.left === placed.left && current.top === placed.top
          ? current
          : { left: placed.left, top: placed.top },
      );
    };
    place();
    // 流式内容变高会改变上翻位置，跟随重新夹取
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [docked, run.anchor]);

  // 捕获阶段监听的浮层同样参与仲裁：设置/命令面板覆盖其上时让位
  const layerId = useId();
  useEscLayer(`inline-ai${layerId}`, true);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop(`inline-ai${layerId}`)) return;
      // 先消费 Esc，避免浮窗顺手退出专注
      event.preventDefault();
      event.stopPropagation();
      if (run.phase === 'streaming') onStop();
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [layerId, onClose, onStop, run.phase]);

  const style: CSSProperties | undefined = docked
    ? undefined
    : placement === null
      ? { visibility: 'hidden' }
      : { left: placement.left, top: placement.top, visibility: 'visible' };
  /** 改写类只能替换选区，说明类只能插到选区之后 */
  const applyLabel = run.apply === 'insert' ? '插入' : '替换';

  return (
    <div
      ref={ref}
      className={docked ? `${styles.card} ${styles.bar}` : styles.card}
      style={style}
      role="dialog"
      aria-label={`${run.label}结果`}
      data-inline-ai={docked ? 'bar' : ''}
      data-canvas-overlay=""
    >
      <div className={styles.head}>
        <span className={styles.label}>{run.label}</span>
        {run.phase === 'streaming' ? <span className={styles.status}>生成中…</span> : null}
        {run.phase === 'replaced' ? (
          <span className={styles.status}>{run.notice}</span>
        ) : null}
      </div>

      {run.phase === 'streaming' || run.phase === 'ready' ? (
        <div className={styles.text} data-inline-ai-body="">
          {run.text}
          {run.phase === 'streaming' ? <span className={styles.caret}>…</span> : null}
        </div>
      ) : null}

      {run.error === null ? null : <p className={styles.error}>{run.error}</p>}

      <div className={styles.footer}>
        {run.phase === 'streaming' ? (
          <button type="button" className={styles.action} onClick={onStop}>
            停止
          </button>
        ) : null}
        {run.phase === 'ready' ? (
          <>
            <button
              type="button"
              className={`${styles.action} ${styles.primary}`}
              disabled={run.busy}
              title={run.apply === 'insert' ? '插入到选区之后' : '替换选中文本'}
              onClick={onApply}
            >
              {run.busy ? `${applyLabel}中…` : applyLabel}
            </button>
            <button type="button" className={styles.action} disabled={run.busy} onClick={onDiscard}>
              丢弃
            </button>
          </>
        ) : null}
        {run.phase === 'replaced' ? (
          <>
            {run.undoText === null ? null : (
              <button
                type="button"
                className={`${styles.action} ${styles.primary}`}
                disabled={run.busy}
                onClick={onUndo}
              >
                {run.undoText}
              </button>
            )}
            <button type="button" className={styles.action} onClick={onClose}>
              关闭
            </button>
          </>
        ) : null}
        {run.phase === 'error' ? (
          <button type="button" className={styles.action} onClick={onClose}>
            关闭
          </button>
        ) : null}
      </div>
    </div>
  );
};
