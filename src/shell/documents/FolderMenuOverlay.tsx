import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { readonlyText } from '../components/readonly-text.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import styles from './DocumentListPanel.module.css';

/** 文件夹右键菜单锚点：盖在文件夹行上，宽度与行一致 */
export interface FolderMenu {
  readonly path: string;
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly w: number;
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
const CONFIRM_HEIGHT = 168;
const EFFECTIVE_BOTTOM_MARGIN = 72;

/** 纵向定位：默认顶边对齐条目顶边；下方放不下时向上翻并夹在可视区内 */
const anchorY = (menu: FolderMenu, height: number): number => {
  const effectiveBottom = window.innerHeight - EFFECTIVE_BOTTOM_MARGIN;
  if (menu.top + height <= effectiveBottom) return menu.top;
  return Math.max(60, Math.min(menu.bottom - height, effectiveBottom - height));
};

const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (buttons.length === 0) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(index + delta + buttons.length) % buttons.length]?.focus();
};

/** 文件夹右键菜单：新建子文件夹 / 删除空文件夹（删除前原地二次确认） */
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

  useEscLayer('folder-menu', menu !== null);
  useEffect(() => {
    if (menu === null) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-folder-menu]') !== null) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop('folder-menu')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, onClose]);

  if (menu === null) return null;
  const name = menu.path.slice(menu.path.lastIndexOf('/') + 1);

  if (confirm) {
    return (
      <div
        className={styles.deleteConfirm}
        data-folder-menu
        style={{ left: menu.left, top: anchorY(menu, CONFIRM_HEIGHT), width: menu.w }}
        role="dialog"
        aria-label="删除文件夹确认"
      >
        <p className={styles.deleteText}>删除文件夹「{name}」？</p>
        <p className={styles.menuHint}>
          将移入系统回收站；系统废纸篓不可用时删除失败，文件夹保持原样。
        </p>
        <div className={styles.deleteActions}>
          <button type="button" className={styles.deleteYes} onClick={() => onDelete(menu.path)}>
            删除
          </button>
          <button type="button" className={styles.deleteNo} onClick={() => setConfirm(false)}>
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.contextMenu}
      data-folder-menu
      style={{ left: menu.left, top: anchorY(menu, MENU_HEIGHT), width: menu.w }}
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
    </div>
  );
};
