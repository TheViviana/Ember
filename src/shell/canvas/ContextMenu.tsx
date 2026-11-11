import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { cssVars } from './css-vars.ts';
import { placeSubmenu, type SubmenuPlacement } from './menu-placement.ts';
import type { CanvasMenuItem } from './menu-model.ts';
import styles from './ContextMenu.module.css';

export interface ContextMenuProps {
  readonly items: readonly CanvasMenuItem[];
  /** 画布内坐标（相对 .canvas 左上角） */
  readonly x: number;
  readonly y: number;
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

export interface LabelPromptProps {
  readonly x: number;
  readonly y: number;
  readonly value: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
}

const isActionable = (item: CanvasMenuItem): boolean =>
  item.children === undefined || item.children.length === 0;

const keyOf = (item: CanvasMenuItem): string => item.id;

/** 菜单/浮层贴边时向内夹紧，避免超出画布可视区 */
const clampToParent = (
  element: HTMLElement | null,
  x: number,
  y: number,
): { x: number; y: number } => {
  const parent = element?.offsetParent;
  if (element === null || !(parent instanceof HTMLElement)) return { x, y };
  const maxX = Math.max(8, parent.clientWidth - element.offsetWidth - 8);
  const maxY = Math.max(8, parent.clientHeight - element.offsetHeight - 8);
  return { x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) };
};

const itemClass = (active: boolean, danger: boolean): string =>
  [styles.item, active ? styles.active : '', danger ? styles.danger : '']
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');

interface MenuLevelProps {
  readonly items: readonly CanvasMenuItem[];
  /** 画布可视区元素：所有层级共用同一个边界 */
  readonly container: HTMLElement | null;
  readonly onSelect: (id: string) => void;
  readonly isRoot: boolean;
  readonly levelRef: RefObject<HTMLDivElement | null>;
  /** 子菜单：作为定位参照的父菜单层 */
  readonly parentRef?: RefObject<HTMLDivElement | null>;
  /** 子菜单：鼠标/点击所在的菜单项 */
  readonly anchorEl?: HTMLElement | null;
  readonly rootStyle?: CSSProperties;
}

/**
 * 单层菜单。递归渲染子菜单，每层都以自己的父层为参照重新计算贴边位置，
 * 因此多级下钻与第一级行为一致，不会越出画布。
 */
const MenuLevel = ({
  items,
  container,
  onSelect,
  isRoot,
  levelRef,
  parentRef,
  anchorEl = null,
  rootStyle,
}: MenuLevelProps): ReactElement => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<SubmenuPlacement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const actionable = useMemo(() => items.filter(isActionable), [items]);
  const openItem = items.find((item) => item.id === openId);

  useLayoutEffect(() => {
    if (isRoot) return;
    const level = levelRef.current;
    const parent = parentRef?.current;
    if (level === null || parent === undefined || parent === null || anchorEl === null) return;
    if (container === null) return;
    const containerRect = container.getBoundingClientRect();
    const levelRect = parent.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const selfRect = level.getBoundingClientRect();
    setPlacement(
      placeSubmenu({
        container: { width: container.clientWidth, height: container.clientHeight },
        level: {
          left: levelRect.left - containerRect.left,
          top: levelRect.top - containerRect.top,
          width: levelRect.width,
          height: levelRect.height,
        },
        anchor: {
          top: anchorRect.top - containerRect.top,
          bottom: anchorRect.bottom - containerRect.top,
        },
        submenu: { width: selfRect.width, height: selfRect.height },
      }),
    );
  }, [anchorEl, container, isRoot, items, levelRef, parentRef]);

  const move = (direction: 1 | -1): void => {
    if (actionable.length === 0) return;
    const index = actionable.findIndex((item) => keyOf(item) === activeId);
    const next = index < 0 ? 0 : (index + direction + actionable.length) % actionable.length;
    const item = actionable[next];
    if (item !== undefined) {
      setActiveId(keyOf(item));
      setOpenId(null);
      setOpenAnchor(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // IME 组合态的按键属于输入法选词，不驱动菜单
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = actionable.find((candidate) => keyOf(candidate) === activeId);
      if (item !== undefined) onSelect(item.id);
    }
  };

  const submenuStyle: CSSProperties = isRoot
    ? (rootStyle ?? {})
    : placement === null
      ? { visibility: 'hidden' }
      : {
          top: `${placement.relativeTop}px`,
          left: placement.side === 'right' ? `${placement.horizontalOffset}px` : 'auto',
          right: placement.side === 'left' ? `${placement.horizontalOffset}px` : 'auto',
          maxHeight: `${placement.maxHeight}px`,
          overflowY: 'auto',
          visibility: 'visible',
        };

  const openSubmenu = (item: CanvasMenuItem): void => {
    setActiveId(item.id);
    setOpenId(item.id);
    setOpenAnchor(itemRefs.current.get(item.id) ?? null);
  };

  return (
    <div
      ref={levelRef}
      className={isRoot ? styles.menu : styles.submenu}
      data-canvas-overlay={isRoot ? '' : undefined}
      role="menu"
      aria-label={isRoot ? '画布菜单' : '子菜单'}
      tabIndex={isRoot ? -1 : undefined}
      style={submenuStyle}
      onKeyDown={isRoot ? onKeyDown : undefined}
    >
      {items.map((item, index) => {
        const hasChildren = item.children !== undefined && item.children.length > 0;
        return (
          <div key={item.id} className={styles.group}>
            {item.separatorBefore === true && index > 0 ? <div className={styles.separator} role="separator" /> : null}
            <div
              ref={(element) => {
                if (element === null) itemRefs.current.delete(item.id);
                else itemRefs.current.set(item.id, element);
              }}
              className={itemClass(activeId === item.id, item.danger === true)}
              role="menuitem"
              aria-haspopup={hasChildren ? 'menu' : undefined}
              onPointerEnter={() => {
                if (hasChildren) {
                  openSubmenu(item);
                  return;
                }
                setActiveId(item.id);
                setOpenId(null);
                setOpenAnchor(null);
              }}
              onClick={() => {
                if (hasChildren) {
                  openSubmenu(item);
                  return;
                }
                onSelect(item.id);
              }}
            >
              <span className={styles.check}>{item.checked === true ? '✓' : ''}</span>
              <span className={styles.label}>{item.label}</span>
              {hasChildren ? <span className={styles.arrow}>›</span> : null}
              {item.shortcut === undefined ? null : <span className={styles.shortcut}>{item.shortcut}</span>}
            </div>
          </div>
        );
      })}
      {openItem === undefined || openItem.children === undefined || openItem.children.length === 0 ? null : (
        <SubmenuLevel
          key={openItem.id}
          items={openItem.children}
          container={container}
          onSelect={onSelect}
          parentRef={levelRef}
          anchorEl={openAnchor}
        />
      )}
    </div>
  );
};

interface SubmenuLevelProps {
  readonly items: readonly CanvasMenuItem[];
  readonly container: HTMLElement | null;
  readonly onSelect: (id: string) => void;
  readonly parentRef: RefObject<HTMLDivElement | null>;
  readonly anchorEl: HTMLElement | null;
}

/** 每个子菜单层各持有一个独立 ref，供更深一层定位使用 */
const SubmenuLevel = ({
  items,
  container,
  onSelect,
  parentRef,
  anchorEl,
}: SubmenuLevelProps): ReactElement => {
  const levelRef = useRef<HTMLDivElement | null>(null);
  return (
    <MenuLevel
      items={items}
      container={container}
      onSelect={onSelect}
      isRoot={false}
      levelRef={levelRef}
      parentRef={parentRef}
      anchorEl={anchorEl}
    />
  );
};

export const ContextMenu = ({ items, x, y, onSelect, onClose }: ContextMenuProps): ReactElement => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = rootRef.current;
    setPosition(clampToParent(element, x, y));
    const parent = element?.offsetParent;
    setContainer(parent instanceof HTMLElement ? parent : null);
  }, [x, y, items]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  useEscLayer('canvas-menu', true);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 统一仲裁：更晚打开的浮层（设置/命令面板/专注浮窗）持有 Esc
      if (!isEscTop('canvas-menu')) return;
      event.preventDefault();
      onClose();
    };
    const onBlur = (): void => {
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  return (
    <MenuLevel
      items={items}
      container={container}
      onSelect={onSelect}
      isRoot
      levelRef={rootRef}
      rootStyle={cssVars({ '--menu-x': `${position.x}px`, '--menu-y': `${position.y}px` })}
    />
  );
};

/** 连线标签输入浮层：Enter / 确定提交，Esc / 点击外部取消 */
export const LabelPrompt = ({
  x,
  y,
  value,
  onSubmit,
  onCancel,
}: LabelPromptProps): ReactElement => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState(value);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    setPosition(clampToParent(rootRef.current, x, y));
  }, [x, y]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      onCancel();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onCancel]);

  return (
    <div
      ref={rootRef}
      className={styles.prompt}
      data-canvas-overlay=""
      style={cssVars({ '--menu-x': `${position.x}px`, '--menu-y': `${position.y}px` })}
      onKeyDown={(event) => {
        // IME 组合态的 Enter/Esc 是选词操作，不提交标签
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          // 提示浮层自己消费 Esc，不冒泡到菜单的关闭监听
          event.stopPropagation();
          onCancel();
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit(text);
        }
      }}
    >
      <input
        ref={inputRef}
        className={styles.input}
        value={text}
        placeholder="连线标签（留空清除）"
        aria-label="连线标签"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <button type="button" className={styles.confirm} onClick={() => onSubmit(text)}>
        确定
      </button>
    </div>
  );
};
