import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { placeSubmenu } from '../canvas/menu-placement.ts';
import { AI_ACTIONS, type AiActionId } from './actions.ts';
import { readonlyText } from '../components/readonly-text.ts';
import styles from './SelectionAiMenu.module.css';

export interface SelectionAnchor {
  /** 相对浮窗面板左上角 */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface SelectionAiMenuProps {
  readonly anchor: SelectionAnchor;
  readonly disabled: boolean;
  /** 只读原因；与状态栏同一份文案，避免这里回退成笼统「只读模式」 */
  readonly readonlyReason: string | null;
  readonly onPick: (id: AiActionId) => void;
  readonly onClose: () => void;
}

/** 选区与菜单之间的视觉间隙 */
const SELECTION_GAP = 6;

/**
 * 文章编辑器选中文本后浮出的六项操作。
 * 定位复用画布子菜单的 placeSubmenu：贴选区、右侧放不下向左翻、下方放不下上翻、始终留在浮窗内。
 */
export const SelectionAiMenu = ({
  anchor,
  disabled,
  readonlyReason,
  onPick,
  onClose,
}: SelectionAiMenuProps): ReactElement => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    if (element === null || parent === null || parent === undefined) return;
    const baseY = anchor.top + anchor.height + SELECTION_GAP;
    const placed = placeSubmenu({
      container: { width: parent.clientWidth, height: parent.clientHeight },
      level: { left: anchor.left, top: baseY, width: anchor.width, height: 0 },
      anchor: { top: baseY, bottom: baseY },
      submenu: { width: element.offsetWidth, height: element.offsetHeight },
    });
    setPlacement({ left: placed.left, top: placed.top });
  }, [anchor]);

  // 捕获阶段监听的浮层同样参与仲裁：设置/命令面板覆盖其上时让位
  const layerId = useId();
  useEscLayer(`selection-ai${layerId}`, true);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && ref.current?.contains(event.target) === true) return;
      onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop(`selection-ai${layerId}`)) return;
      event.preventDefault();
      onClose();
    };
    // 右键菜单优先：选区菜单不覆盖它
    const onContextMenu = (): void => {
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [layerId, onClose]);

  const style: CSSProperties =
    placement === null
      ? { visibility: 'hidden' }
      : { left: placement.left, top: placement.top, visibility: 'visible' };

  return (
    <div
      ref={ref}
      className={styles.menu}
      style={style}
      role="menu"
      aria-label="AI 文章操作"
      data-canvas-overlay=""
      onPointerDown={(event) => {
        // 保住编辑器里的选区与焦点，点击后还能读到选中文本
        event.preventDefault();
      }}
    >
      {AI_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={disabled}
          title={disabled ? `${readonlyText(readonlyReason)}，无法使用 AI 操作` : action.label}
          onClick={() => {
            onPick(action.id);
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};
