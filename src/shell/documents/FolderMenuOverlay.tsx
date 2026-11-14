import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { placeDocMenu, type DocMenuPlacement } from './doc-menu-placement.ts';
import styles from './DocumentListPanel.module.css';

/** 文件夹右键菜单锚点：被右键文件夹行的 getBoundingClientRect（视口坐标） */
export interface FolderMenu {
  readonly path: string;
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly w: number;
  /** 确认框里展示的代价：该目录下的文章数与子文件夹数 */
  readonly docs: number;
  readonly dirs: number;
}

export interface FolderMenuOverlayProps {
  readonly menu: FolderMenu | null;
  readonly onClose: () => void;
  readonly onCreateChild: (path: string) => void;
  readonly onDelete: (path: string) => void;
  readonly readonlyMode: boolean;
  readonly readonlyReason: string | null;
}

const MENU_HEIGHT = 84;
const CONFIRM_HEIGHT = 208;

/** 视口定位：宽度继承文件夹行，靠近四边时翻转或夹住不出界 */
const place = (menu: FolderMenu, height: number): DocMenuPlacement =>
  placeDocMenu(
    { left: menu.left, top: menu.top, bottom: menu.bottom, width: menu.w },
    height,
    { width: window.innerWidth, height: window.innerHeight },
  );

const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (buttons.length === 0) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(index + delta + buttons.length) % buttons.length]?.focus();
};

/**
 * 文件夹右键菜单：新建子文件夹 / 删除空文件夹（删除前原地二次确认）。
 * 与文章菜单同源：面板的 overflow 与 backdrop-filter 会裁掉内部 fixed 浮层，
 * 所以 portal 到 body 上按视口定位，只跟随被右键的那一行。
 */
export const FolderMenuOverlay = ({
  menu,
  onClose,
  onCreateChild,
  onDelete,
  readonlyMode,
  readonlyReason,
}: FolderMenuOverlayProps): ReactElement | null => {
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setConfirm(false);
  }, [menu]);

  const closeAll = useCallback((): void => {
    setConfirm(false);
    onClose();
  }, [onClose]);

  useEscLayer('folder-menu', menu !== null);

  useEffect(() => {
    if (menu === null) return undefined;
    const insideMenu = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest('[data-doc-menu]') !== null;
    const onPointerDown = (event: PointerEvent): void => {
      if (insideMenu(event.target)) return;
      closeAll();
    };
    // 列表滚动时浮层会脱离所在行，直接收起
    const onScroll = (event: Event): void => {
      if (insideMenu(event.target)) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop('folder-menu')) return;
      event.preventDefault();
      closeAll();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, closeAll]);

  if (menu === null) return null;
  const name = menu.path.slice(menu.path.lastIndexOf('/') + 1);
  const box = place(menu, confirm ? CONFIRM_HEIGHT : MENU_HEIGHT);

  if (confirm) {
    return createPortal(
      <div
        className={styles.deleteConfirm}
        data-doc-menu=""
        data-canvas-overlay="doc-menu"
        style={{ left: box.left, top: box.top, width: box.width }}
        role="dialog"
        aria-label="删除文件夹确认"
      >
        <p className={styles.deleteText}>删除文件夹「{name}」？</p>
        <p className={styles.menuHint}>
          其中 {menu.docs} 篇文章、{menu.dirs} 个子文件夹将整体移入系统废纸篓。
        </p>
        <p className={styles.menuHint}>
          此操作不可撤销；系统废纸篓不可用时删除失败，文件夹保持原样。
        </p>
        <div className={styles.deleteActions}>
          <button type="button" className={styles.deleteYes} onClick={() => onDelete(menu.path)}>
            删除
          </button>
          <button type="button" className={styles.deleteNo} onClick={() => setConfirm(false)}>
            取消
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className={styles.contextMenu}
      data-doc-menu=""
      data-canvas-overlay="doc-menu"
      style={{ left: box.left, top: box.top, width: box.width }}
      role="menu"
      onKeyDown={onMenuKeyDown}
    >
      <button
        type="button"
        role="menuitem"
        className={styles.menuItem}
        disabled={readonlyMode}
        onClick={() => onCreateChild(menu.path)}
      >
        在此新建子文件夹
      </button>
      <button
        type="button"
        role="menuitem"
        className={`${styles.menuItem} ${styles.menuDanger}`}
        disabled={readonlyMode}
        onClick={() => setConfirm(true)}
      >
        删除文件夹…
      </button>
      {readonlyMode ? <p className={styles.menuHint}>{readonlyText(readonlyReason)}</p> : null}
    </div>,
    document.body,
  );
};
