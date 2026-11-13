import { useEffect, useRef, useState, type ReactElement } from 'react';
import styles from './SplashOverlay.module.css';

/** 火焰阶段总时长：火花点燃 → 波纹 → 字标浮现，之后开始淡出（与 CSS 关键帧时序对齐） */
const ACTIVE_MS = 2000;
/** 淡出过渡时长，与 CSS 侧 --duration-slow 保持一致 */
const FADE_MS = 240;

const WORDMARK = 'EMBER';
/** 字标入场起点：波纹扩散中段开始逐字浮现 */
const LETTER_START_MS = 1150;
const LETTER_STAGGER_MS = 70;

type Props = {
  /** 淡出开始时回调：外壳同时播放主界面入场动画 */
  onReveal: () => void;
  /** 淡出结束后回调：卸载启动画面 */
  onDone: () => void;
};

/**
 * 开启动画「余烬点燃」：纯 CSS 关键帧，组件只负责时序编排与卸载。
 * 覆盖在主界面之上，淡出后露出已就绪的外壳。
 */
export const SplashOverlay = ({ onReveal, onDone }: Props): ReactElement => {
  const [closing, setClosing] = useState(false);
  // 回调走 ref：外壳的内联箭头函数每次渲染都是新引用，
  // 不能进 effect 依赖，否则计时器随外壳渲染反复重置，启动画面永远关不掉
  const onRevealRef = useRef(onReveal);
  const onDoneRef = useRef(onDone);
  onRevealRef.current = onReveal;
  onDoneRef.current = onDone;

  useEffect(() => {
    const revealTimer = window.setTimeout(() => {
      setClosing(true);
      onRevealRef.current();
    }, ACTIVE_MS);
    const doneTimer = window.setTimeout(() => onDoneRef.current(), ACTIVE_MS + FADE_MS);
    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  return (
    <div className={`${styles.overlay} ${closing ? styles.closing : ''}`} aria-hidden="true">
      <div className={styles.stage}>
        <div className={styles.emberWrap}>
          <div className={styles.ripple} />
          <div className={styles.flame} />
          <div className={styles.flameCore} />
          <div className={styles.ember} />
        </div>
        <div className={styles.wordmark}>
          {WORDMARK.split('').map((char, index) => (
            <span
              key={index}
              className={styles.letter}
              style={{ animationDelay: `${LETTER_START_MS + index * LETTER_STAGGER_MS}ms` }}
            >
              {char}
            </span>
          ))}
        </div>
        <p className={styles.status}>INITIALIZING KERNEL</p>
      </div>
    </div>
  );
};
