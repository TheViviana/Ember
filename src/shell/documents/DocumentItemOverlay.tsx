import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import { useEscLayer, isEscTop } from '../esc-arbiter.ts';
import { readonlyText } from '../components/readonly-text.ts';
import { parentDirOf } from './doc-tree.ts';
import styles from './DocumentListPanel.module.css';

/** 菜单 / 删除确认的锚点：直接盖在条目矩形上，宽度与条目一致 */
export interface ItemOverlay {
  readonly docId: string;
  readonly path: string;
  readonly title: string;
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly w: number;
}

export interface DocumentItemOverlayProps {
  readonly menu: ItemOverlay | null;
  readonly onCloseMenu: () => void;
  readonly onOpenItem: (item: ItemOverlay) => void;
  readonly onLocate: (item: ItemOverlay) => void;
  readonly onDuplicate: (item: ItemOverlay) => void;
  readonly onCopyPath: (path: string) => void;
  readonly onDelete: (item: ItemOverlay) => void;
  readonly deleting: boolean;
  readonly moveDirs: readonly string[];
  readonly onMoveDoc: (docId: string, fromPath: string, targetDir: string) => void;
  readonly readonlyMode: boolean;
  readonly readonlyReason: string | null;
}

const MENU_HEIGHT = 212;
const MOVE_HEIGHT = 260;
const CONFIRM_HEIGHT = 148;
const EFFECTIVE_BOTTOM_MARGIN = 72;

/** 纵向定位：默认顶边对齐条目顶边；下方放不下时向上翻并夹在可视区内 */
const anchorY = (overlay: ItemOverlay, height: number): number => {
  const effectiveBottom = window.innerHeight - EFFECTIVE_BOTTOM_MARGIN;
  if (overlay.top + height <= effectiveBottom) return overlay.top;
  const flipped = overlay.bottom - height;
  return Math.max(60, Math.min(flipped, effectiveBottom - height));
};

/** 菜单内上下键移动焦点（两个视图共用；按钮本身保持 Tab 可达） */
const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  if (buttons.length === 0) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const delta = event.key === 'ArrowDown' ? 1 : -1;
  const next = (index + delta + buttons.length) % buttons.length;
  buttons[next]?.focus();
};

/**
 * 文档条的右键操作菜单与删除确认。
 * 「移动到…」在本组件内切换为目录列表；删除确认原地替换菜单，锚点与宽度不变。
 */
export const DocumentItemOverlay = ({
  menu,
  onCloseMenu,
  onOpenItem,
  onLocate,
  onDuplicate,
  onCopyPath,
  onDelete,
  deleting,
  moveDirs,
  onMoveDoc,
  readonlyMode,
  readonlyReason,
}: DocumentItemOverlayProps): ReactElement | null => {
  const [mode, setMode] = useState<'actions' | 'move'>('actions');
  const [confirm, setConfirm] = useState<ItemOverlay | null>(null);

  useEffect(() => {
    setMode('actions');
  }, [menu]);

  useEscLayer('doc-list-menu', menu !== null || confirm !== null);
  useEffect(() => {
    if (menu === null) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-doc-menu]') !== null) return;
      onCloseMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isEscTop('doc-list-menu')) return;
      event.preventDefault();
      onCloseMenu();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu, onCloseMenu]);

  const closeMenu = (): void => {
    onCloseMenu();
  };

  const confirmNode =
    confirm === null ? null : (
      <div
        className={styles.deleteConfirm}
        role="alertdialog"
        aria-label="确认删除文档"
        style={{
          left: confirm.left,
          top: anchorY(confirm, CONFIRM_HEIGHT),
          width: confirm.w,
        }}
      >
        <p className={styles.deleteText}>
          删除《{confirm.title}》？文件优先移入系统回收站；系统回收站不可用时落入库内回收目录
          （.workbench/trash），30 天后自动清除。
        </p>
        <div className={styles.deleteActions}>
          <button
            type="button"
            className={styles.deleteYes}
            disabled={deleting}
            onClick={() => {
              const item = confirm;
              setConfirm(null);
              onDelete(item);
            }}
          >
            {deleting ? '删除中…' : '删除'}
          </button>
          <button
            type="button"
            className={styles.deleteNo}
            onClick={() => {
              setConfirm(null);
            }}
          >
            取消
          </button>
        </div>
      </div>
    );

  if (menu === null) return confirmNode;

  return (
    <>
      {confirmNode}
      <div
        className={styles.contextMenu}
        data-doc-menu=""
        role="menu"
        aria-label={`文档操作：${menu.title}`}
        style={{
          left: menu.left,
          top: anchorY(menu, mode === 'move' ? MOVE_HEIGHT : MENU_HEIGHT),
          width: menu.w,
        }}
        onKeyDown={onMenuKeyDown}
      >
        {mode === 'move' ? (
          <>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setMode('actions');
              }}
            >
              ← 返回
            </button>
            <p className={styles.menuHint}>移动到（当前：{parentDirOf(menu.path) || '库根'}）</p>
            <div className={styles.menuScroll}>
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onMoveDoc(menu.docId, menu.path, '');
                }}
              >
                库根
              </button>
              {moveDirs.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    onMoveDoc(menu.docId, menu.path, dir);
                  }}
                >
                  {dir}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                closeMenu();
                onOpenItem(menu);
              }}
            >
              打开浮窗
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                closeMenu();
                onLocate(menu);
              }}
            >
              在画布中定位
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                setMode('move');
              }}
            >
              移动到…
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                closeMenu();
                onDuplicate(menu);
              }}
            >
              创建副本
            </button>
            <button
              type="button"
              className={styles.menuItem}
              role="menuitem"
              onClick={() => {
                closeMenu();
                onCopyPath(menu.path);
              }}
            >
              复制路径
            </button>
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuDanger}`}
              role="menuitem"
              disabled={readonlyMode}
              title={
                readonlyMode
                  ? readonlyText(readonlyReason)
                  : '优先移入系统回收站；不可用时落入库内回收目录（30 天后清除）'
              }
              onClick={() => {
                // 确认条原地替换菜单：位置、宽度都继承条目锚点，视线不跳动
                setConfirm(menu);
                closeMenu();
              }}
            >
              删除…
            </button>
          </>
        )}
      </div>
    </>
  );
};
