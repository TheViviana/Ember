import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { OutlineHeading } from './outline.ts';
import styles from './OutlinePanel.module.css';

export interface OutlinePanelProps {
  readonly headings: readonly OutlineHeading[];
  /** 当前滚动位置对应的标题下标；-1 表示还在第一个标题之前 */
  readonly activeIndex: number;
  readonly onJump: (line: number) => void;
}

const TIP_ID = 'outline-dot-tip';
/** 提示框与点列容器的上下安全边距（与 --space-xs 一致） */
const TIP_SAFE_PX = 4;

const LEVEL_NAME = ['', '一级标题', '二级标题', '三级标题', '四级标题', '五级标题', '六级标题'] as const;

const levelNameOf = (level: number): string => LEVEL_NAME[level] ?? '标题';

const labelOf = (heading: OutlineHeading): string =>
  heading.text.length === 0 ? '未命名标题' : heading.text;

/**
 * 编辑器大纲：贴在内容区右缘的一列点。
 * - 所有点同径同列，层级不改变位置或直径；层级信息放在悬停提示的首行；
 * - 当前视口位置用同直径的空心环表示，只靠描边与实心点区分；
 * - 轨道最多占可用列高的 62.5%，超出只在轨道内部滚动，绝不满列铺开；
 * - 悬停/键盘聚焦时在点列左侧浮出完整标题（可折行，不截断）；
 * - 滚轮只翻点列，不滚正文也不冒泡到画布；
 * - 没有标题时整列不渲染。
 */
export const OutlinePanel = ({
  headings,
  activeIndex,
  onJump,
}: OutlinePanelProps): ReactElement | null => {
  const [hovered, setHovered] = useState<number | null>(null);
  const [tipTop, setTipTop] = useState(0);
  const dockRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  const placeTip = (dot: HTMLButtonElement): void => {
    const dock = dockRef.current;
    if (dock === null) return;
    const dockRect = dock.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    setTipTop(dotRect.top - dockRect.top + dotRect.height / 2);
  };

  // 提示框渲染后按自身高度夹紧，保证不越出浮窗内容区
  useLayoutEffect(() => {
    if (hovered === null) return;
    const dock = dockRef.current;
    const tip = tipRef.current;
    if (dock === null || tip === null) return;
    const half = tip.offsetHeight / 2;
    const min = half + TIP_SAFE_PX;
    const max = dock.clientHeight - half - TIP_SAFE_PX;
    setTipTop((value) => Math.min(Math.max(value, min), Math.max(min, max)));
  }, [hovered, headings]);

  // 滚轮只翻点列：在点列这一层截住，事件不再冒到画布触发缩放。
  // 手动折算 deltaMode 后滚 scrollTop——原生滚轮在本窗口会被祖先的缩放监听干扰。
  // 注意：不要给滚动容器加 mask 或渐变覆盖层，WebKit 会拒绝滚动，点也会被盖到看不见。
  useEffect(() => {
    const node = trackRef.current;
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      // deltaMode 1 = 行，2 = 页；统一折算成像素
      const step =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * node.clientHeight
            : event.deltaY;
      node.scrollTop += step;
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
    };
  }, [headings.length]);

  if (headings.length === 0) return null;

  const hoveredHeading = hovered === null ? null : (headings[hovered] ?? null);

  const showTip = (index: number, dot: HTMLButtonElement): void => {
    placeTip(dot);
    setHovered(index);
  };

  const hideTip = (): void => {
    setHovered(null);
  };

  return (
    <nav className={styles.dock} aria-label="大纲" ref={dockRef}>
      <div
        className={styles.track}
        ref={trackRef}
        onScroll={() => {
          // 点列滚动后指针下的点已换人，旧提示必须撤掉，避免指错标题
          if (hovered !== null) setHovered(null);
        }}
      >
        {headings.map((heading, index) => {
          const label = labelOf(heading);
          const levelName = levelNameOf(heading.level);
          return (
            <button
              key={`${heading.line}-${index}`}
              type="button"
              className={styles.dotButton}
              data-level={heading.level}
              data-active={index === activeIndex ? 'true' : 'false'}
              data-dot-index={index}
              aria-label={`${levelName}：${label}`}
              aria-current={index === activeIndex ? 'true' : undefined}
              aria-describedby={hovered === index ? TIP_ID : undefined}
              onPointerEnter={(event) => {
                showTip(index, event.currentTarget);
              }}
              onPointerLeave={hideTip}
              onFocus={(event) => {
                // 只有键盘聚焦（:focus-visible）才弹提示，鼠标点击后移开不残留
                if (event.currentTarget.matches(':focus-visible')) {
                  showTip(index, event.currentTarget);
                }
              }}
              onBlur={hideTip}
              onClick={() => {
                onJump(heading.line);
              }}
            >
              <span className={styles.dot} />
            </button>
          );
        })}
      </div>

      {hoveredHeading === null ? null : (
        <div
          id={TIP_ID}
          role="tooltip"
          className={styles.tip}
          ref={tipRef}
          style={{ top: `${tipTop}px` }}
        >
          <span className={styles.tipMeta}>{levelNameOf(hoveredHeading.level)}</span>
          <span>{labelOf(hoveredHeading)}</span>
        </div>
      )}
    </nav>
  );
};
