import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CanvasId } from '#doc-model';
import { useEscLayer, isEscTop } from '../esc-arbiter.ts';
import { readonlyText } from '../components/readonly-text.ts';
import type { CanvasLibrary } from './use-canvas-library.ts';
import styles from './CanvasSwitcher.module.css';

export interface CanvasSwitcherProps {
  readonly library: CanvasLibrary;
  /** 只读会话：新建画布会失败，入口直接禁用并给出原因 */
  readonly readonlyMode: boolean;
  readonly readonlyReason: string | null;
}

/** 当前画布标题 */
const titleOf = (library: CanvasLibrary): string => {
  if (library.location.kind === 'overview') return '总览';
  const id = library.location.id;
  const found = library.canvases.find((item) => String(item.id) === String(id));
  return found?.title ?? '画布';
};

/** 顶栏当前画布胶囊 + 画布列表浮层 + 面包屑 */
export const CanvasSwitcher = ({
  library,
  readonlyMode,
  readonlyReason,
}: CanvasSwitcherProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [renaming, setRenaming] = useState<CanvasId | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEscLayer('canvas-switcher', open);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isEscTop('canvas-switcher')) {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const currentId = library.location.kind === 'canvas' ? library.location.id : null;

  const submitNew = (): void => {
    const title = newTitle.trim();
    if (title.length === 0) return;
    setNewTitle('');
    void library.createCanvas(title);
  };

  const submitRename = (): void => {
    const target = renaming;
    const value = renameValue.trim();
    setRenaming(null);
    if (target === null || value.length === 0) return;
    void library.renameCanvas(target, value);
  };

  const crumbs = library.stack.map((item, index) => ({
    index,
    label:
      item.kind === 'overview'
        ? '总览'
        : (library.canvases.find((canvas) => String(canvas.id) === String(item.id))?.title ?? '画布'),
    current: index === library.stack.length - 1,
  }));

  const recentRows = library.recentCanvasIds
    .map((id) => library.canvases.find((canvas) => String(canvas.id) === id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .slice(0, 5);

  return (
    <div className={styles.root} ref={rootRef} data-canvas-overlay="switcher">
      <nav className={styles.crumbs} aria-label="画布路径">
        {crumbs.map((crumb) => (
          <button
            key={`${crumb.index}-${crumb.label}`}
            type="button"
            className={`${styles.crumb} ${crumb.current ? styles.crumbCurrent : ''}`}
            onClick={() => {
              library.jumpTo(crumb.index);
            }}
          >
            {crumb.label}
            {crumb.current ? null : <span className={styles.crumbSep}>/</span>}
          </button>
        ))}
      </nav>

      <button
        type="button"
        className={styles.pill}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span className={styles.pillIcon} aria-hidden="true">
          ▦
        </span>
        <span className={styles.pillTitle}>{titleOf(library)}</span>
        <span className={styles.pillChevron} aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div className={styles.popover} role="menu" aria-label="画布列表">
          <button
            type="button"
            className={`${styles.row} ${library.location.kind === 'overview' ? styles.rowCurrent : ''}`}
            onClick={() => {
              library.showOverview();
              setOpen(false);
            }}
          >
            <span className={styles.rowTitle}>总览</span>
            <span className={styles.rowMeta}>全部空间</span>
          </button>

          {recentRows.length > 0 ? (
            <>
              <p className={styles.groupLabel}>最近访问</p>
              {recentRows.map((canvas) => (
                <Row
                  key={`recent-${String(canvas.id)}`}
                  canvas={canvas}
                  current={currentId !== null && String(currentId) === String(canvas.id)}
                  home={library.homeCanvasId === String(canvas.id)}
                  renaming={String(renaming) === String(canvas.id)}
                  renameValue={renameValue}
                  onRenameValue={setRenameValue}
                  onStartRename={() => {
                    setRenaming(canvas.id);
                    setRenameValue(canvas.title);
                  }}
                  onSubmitRename={submitRename}
                  onCancelRename={() => {
                    setRenaming(null);
                  }}
                  onOpen={() => {
                    library.openCanvas(canvas.id);
                    setOpen(false);
                  }}
                  onPin={() => {
                    void library.pinHome(
                      library.homeCanvasId === String(canvas.id) ? null : canvas.id,
                    );
                  }}
                  onDuplicate={() => {
                    void library.duplicateCanvas(canvas.id);
                  }}
                  onRemove={() => {
                    void library.removeCanvas(canvas.id);
                    setOpen(false);
                  }}
                />
              ))}
            </>
          ) : null}

          <p className={styles.groupLabel}>全部画布</p>
          {library.canvases.length === 0 ? (
            <p className={styles.empty}>
              {readonlyMode ? `${readonlyText(readonlyReason)}，不能新建画布` : '还没有画布，先新建一张'}
            </p>
          ) : (
            library.canvases.map((canvas) => (
              <Row
                key={String(canvas.id)}
                canvas={canvas}
                current={currentId !== null && String(currentId) === String(canvas.id)}
                home={library.homeCanvasId === String(canvas.id)}
                renaming={String(renaming) === String(canvas.id)}
                renameValue={renameValue}
                onRenameValue={setRenameValue}
                onStartRename={() => {
                  setRenaming(canvas.id);
                  setRenameValue(canvas.title);
                }}
                onSubmitRename={submitRename}
                onCancelRename={() => {
                  setRenaming(null);
                }}
                onOpen={() => {
                  library.openCanvas(canvas.id);
                  setOpen(false);
                }}
                onPin={() => {
                  void library.pinHome(library.homeCanvasId === String(canvas.id) ? null : canvas.id);
                }}
                onDuplicate={() => {
                  void library.duplicateCanvas(canvas.id);
                }}
                onRemove={() => {
                  void library.removeCanvas(canvas.id);
                  setOpen(false);
                }}
              />
            ))
          )}

          <div className={styles.newRow}>
            <input
              className={styles.newInput}
              placeholder={readonlyMode ? '只读模式，不能新建画布' : '新画布名称…'}
              value={newTitle}
              disabled={readonlyMode}
              onChange={(event) => {
                setNewTitle(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submitNew();
                }
              }}
            />
            <button
              type="button"
              className={styles.newButton}
              disabled={readonlyMode}
              title={readonlyMode ? readonlyText(readonlyReason) : '新建画布'}
              onClick={submitNew}
            >
              新建
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

interface RowProps {
  readonly canvas: { readonly id: CanvasId; readonly title: string; readonly nodeCount: number };
  readonly current: boolean;
  readonly home: boolean;
  readonly renaming: boolean;
  readonly renameValue: string;
  readonly onRenameValue: (value: string) => void;
  readonly onStartRename: () => void;
  readonly onSubmitRename: () => void;
  readonly onCancelRename: () => void;
  readonly onOpen: () => void;
  readonly onPin: () => void;
  readonly onDuplicate: () => void;
  readonly onRemove: () => void;
}

const Row = ({
  canvas,
  current,
  home,
  renaming,
  renameValue,
  onRenameValue,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  onOpen,
  onPin,
  onDuplicate,
  onRemove,
}: RowProps): ReactElement => {
  if (renaming) {
    return (
      <div className={styles.row} data-canvas-overlay="rename">
        <input
          className={styles.renameInput}
          value={renameValue}
          autoFocus
          onChange={(event) => {
            onRenameValue(event.target.value);
          }}
          onBlur={onSubmitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmitRename();
            }
            if (event.key === 'Escape') {
              // 只取消重命名，不冒泡到浮层的「Esc 关闭列表」
              event.preventDefault();
              event.stopPropagation();
              onCancelRename();
            }
          }}
        />
      </div>
    );
  }
  return (
    <div className={`${styles.row} ${current ? styles.rowCurrent : ''}`}>
      <button
        type="button"
        className={styles.rowMain}
        onDoubleClick={onStartRename}
        onClick={onOpen}
        title="单击进入 · 双击重命名"
      >
        <span className={styles.rowTitle}>{canvas.title}</span>
        <span className={styles.rowMeta}>{canvas.nodeCount} 节点</span>
      </button>
      <span className={styles.rowActions} data-row-canvas={String(canvas.id)}>
        <button
          type="button"
          className={`${styles.iconButton} ${home ? styles.iconButtonActive : ''}`}
          title={home ? '取消主页固定' : '固定为主页'}
          onClick={onPin}
        >
          {home ? '★' : '☆'}
        </button>
        <button type="button" className={styles.iconButton} title="复制画布" onClick={onDuplicate}>
          复制
        </button>
        <button type="button" className={styles.iconButtonDanger} title="删除画布（进系统回收站）" onClick={onRemove}>
          删除
        </button>
      </span>
    </div>
  );
};
