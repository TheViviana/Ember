import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CanvasBookmark, CanvasFilters } from '#canvas-engine';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useImportStore } from '../import/import-store.ts';
import { EMPTY_FILTERS, NODE_KINDS, useCanvasViewStore } from '../canvas/canvas-view-store.ts';
import styles from './ShellMenu.module.css';

export interface ShellMenuProps {
  readonly onOpenDocuments: () => void;
  readonly onOpenSearch: () => void;
  readonly aiOpen: boolean;
  readonly onToggleAi: () => void;
  readonly onOpenSettings: () => void;
}

const LAYER_ID = 'shell-menu';

/**
 * 顶栏左侧菜单（总览之前）：把文档/搜索/AI/设置、导入入口与画布视图动作收进一个下拉，
 * 让顶栏两侧只剩状态与画布导航，画布上方不再压一条悬浮工具条。
 */
export const ShellMenu = ({
  onOpenDocuments,
  onOpenSearch,
  aiOpen,
  onToggleAi,
  onOpenSettings,
}: ShellMenuProps): ReactElement => {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'filter' | 'bookmarks' | null>(null);
  const [keyword, setKeyword] = useState('');
  const [bookmarkName, setBookmarkName] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actions = useCanvasViewStore((state) => state.actions);

  useEscLayer(LAYER_ID, open);

  useEffect(() => {
    if (!open) {
      setSection(null);
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isEscTop(LAYER_ID)) {
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

  const close = (): void => {
    setOpen(false);
  };

  const run = (action: () => void) => () => {
    close();
    action();
  };

  const toggleFilter = (): void => {
    if (section === 'filter') {
      setSection(null);
      return;
    }
    setKeyword(actions?.filters.text ?? '');
    setSection('filter');
  };

  const filters: CanvasFilters = actions?.filters ?? EMPTY_FILTERS;
  const filterCount =
    filters.tags.length + filters.kinds.length + (filters.text.trim().length > 0 ? 1 : 0);

  const toggleKind = (kind: string): void => {
    if (actions === null) return;
    const kinds = filters.kinds.includes(kind)
      ? filters.kinds.filter((item) => item !== kind)
      : [...filters.kinds, kind];
    actions.setFilters({ ...filters, kinds });
  };

  const toggleTag = (tag: string): void => {
    if (actions === null) return;
    const tags = filters.tags.includes(tag)
      ? filters.tags.filter((item) => item !== tag)
      : [...filters.tags, tag];
    actions.setFilters({ ...filters, tags });
  };

  const applyKeyword = (): void => {
    if (actions === null) return;
    actions.setFilters({ ...filters, text: keyword.trim() });
  };

  const saveBookmark = (): void => {
    if (actions === null) return;
    const name = bookmarkName.trim();
    if (name.length === 0) return;
    actions.saveBookmark(name);
    setBookmarkName('');
  };

  const jumpBookmark = (bookmark: CanvasBookmark): void => {
    if (actions === null) return;
    actions.jumpBookmark(bookmark);
    close();
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        title="菜单：文档 / 搜索 / 导入 / 画布视图"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">☰</span>
      </button>

      {open ? (
        <div className={styles.panel} role="menu" aria-label="应用菜单">
          <p className={styles.sectionLabel}>工作区</p>
          <button type="button" className={styles.item} onClick={run(onOpenDocuments)}>
            <span className={styles.icon} aria-hidden="true">
              ◇
            </span>
            文档
          </button>
          <button type="button" className={styles.item} onClick={run(onOpenSearch)}>
            <span className={styles.icon} aria-hidden="true">
              ⌕
            </span>
            搜索
            <span className={styles.kbd}>⌘K</span>
          </button>
          <button
            type="button"
            className={`${styles.item} ${aiOpen ? styles.itemActive : ''}`}
            aria-pressed={aiOpen}
            onClick={run(onToggleAi)}
          >
            <span className={styles.icon} aria-hidden="true">
              ✦
            </span>
            AI 助手
          </button>
          <button type="button" className={styles.item} onClick={run(onOpenSettings)}>
            <span className={styles.icon} aria-hidden="true">
              ⚙
            </span>
            设置
          </button>

          <p className={styles.sectionLabel}>导入</p>
          <button
            type="button"
            className={styles.item}
            onClick={run(() => {
              useImportStore.getState().request('folder');
            })}
          >
            <span className={styles.icon} aria-hidden="true">
              ⇲
            </span>
            导入知识库（文件夹）
          </button>
          <button
            type="button"
            className={styles.item}
            onClick={run(() => {
              useImportStore.getState().request('files');
            })}
          >
            <span className={styles.icon} aria-hidden="true">
              ⇩
            </span>
            导入文章（Markdown）
          </button>

          {actions === null ? null : (
            <>
              <p className={styles.sectionLabel}>画布视图</p>
              <button
                type="button"
                className={`${styles.item} ${actions.recentEditsOpen ? styles.itemActive : ''}`}
                aria-pressed={actions.recentEditsOpen}
                onClick={() => {
                  actions.toggleRecentEdits();
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  ⏱
                </span>
                最近编辑
              </button>
              <button
                type="button"
                className={`${styles.item} ${actions.historyOpen ? styles.itemActive : ''}`}
                aria-pressed={actions.historyOpen}
                onClick={() => {
                  actions.toggleHistory();
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  ◷
                </span>
                历史版本
              </button>
              <button type="button" className={styles.item} onClick={run(actions.fitView)}>
                <span className={styles.icon} aria-hidden="true">
                  ⤢
                </span>
                适应内容
              </button>
              <button type="button" className={styles.item} onClick={run(actions.resetView)}>
                <span className={styles.icon} aria-hidden="true">
                  ↺
                </span>
                重置视图
              </button>

              <button
                type="button"
                className={`${styles.item} ${filterCount > 0 ? styles.itemActive : ''}`}
                aria-expanded={section === 'filter'}
                onClick={toggleFilter}
              >
                <span className={styles.icon} aria-hidden="true">
                  ◫
                </span>
                过滤
                {filterCount > 0 ? <span className={styles.kbd}>{filterCount}</span> : null}
              </button>
              {section === 'filter' ? (
                <div className={styles.subPanel}>
                  <div className={styles.fieldRow}>
                    <input
                      className={styles.input}
                      placeholder="关键词过滤…"
                      value={keyword}
                      onChange={(event) => {
                        setKeyword(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          applyKeyword();
                        }
                      }}
                    />
                    <button type="button" className={styles.smallButton} onClick={applyKeyword}>
                      应用
                    </button>
                  </div>

                  <p className={styles.fieldLabel}>类型</p>
                  <div className={styles.chips}>
                    {NODE_KINDS.map((kind) => (
                      <button
                        key={kind.id}
                        type="button"
                        className={`${styles.chip} ${filters.kinds.includes(kind.id) ? styles.chipActive : ''}`}
                        onClick={() => {
                          toggleKind(kind.id);
                        }}
                      >
                        {kind.label}
                      </button>
                    ))}
                  </div>

                  <p className={styles.fieldLabel}>标签</p>
                  {actions.availableTags.length === 0 ? (
                    <p className={styles.fieldEmpty}>画布上还没有标签</p>
                  ) : (
                    <div className={styles.chips}>
                      {actions.availableTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className={`${styles.chip} ${filters.tags.includes(tag) ? styles.chipActive : ''}`}
                          onClick={() => {
                            toggleTag(tag);
                          }}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className={styles.modeRow}>
                    <button
                      type="button"
                      className={`${styles.chip} ${filters.mode === 'dim' ? styles.chipActive : ''}`}
                      onClick={() => {
                        actions.setFilters({ ...filters, mode: 'dim' });
                      }}
                    >
                      高亮
                    </button>
                    <button
                      type="button"
                      className={`${styles.chip} ${filters.mode === 'hide' ? styles.chipActive : ''}`}
                      onClick={() => {
                        actions.setFilters({ ...filters, mode: 'hide' });
                      }}
                    >
                      隐藏
                    </button>
                    <span className={styles.spacer} />
                    {filterCount > 0 ? (
                      <button
                        type="button"
                        className={styles.smallButton}
                        onClick={() => {
                          setKeyword('');
                          actions.setFilters(EMPTY_FILTERS);
                        }}
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <button
                type="button"
                className={styles.item}
                aria-expanded={section === 'bookmarks'}
                onClick={() => {
                  setSection((current) => (current === 'bookmarks' ? null : 'bookmarks'));
                }}
              >
                <span className={styles.icon} aria-hidden="true">
                  ☆
                </span>
                书签
                {actions.bookmarks.length > 0 ? (
                  <span className={styles.kbd}>{actions.bookmarks.length}</span>
                ) : null}
              </button>
              {section === 'bookmarks' ? (
                <div className={styles.subPanel}>
                  <div className={styles.fieldRow}>
                    <input
                      className={styles.input}
                      placeholder="保存当前视图为书签…"
                      value={bookmarkName}
                      onChange={(event) => {
                        setBookmarkName(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          saveBookmark();
                        }
                      }}
                    />
                    <button type="button" className={styles.smallButton} onClick={saveBookmark}>
                      保存
                    </button>
                  </div>
                  {actions.bookmarks.length === 0 ? (
                    <p className={styles.fieldEmpty}>还没有书签</p>
                  ) : (
                    <ul className={styles.bookmarkList}>
                      {actions.bookmarks.map((bookmark) => (
                        <li key={bookmark.id} className={styles.bookmarkRow}>
                          <button
                            type="button"
                            className={styles.bookmarkName}
                            onClick={() => {
                              jumpBookmark(bookmark);
                            }}
                          >
                            {bookmark.name}
                          </button>
                          <button
                            type="button"
                            className={styles.bookmarkDelete}
                            aria-label={`删除书签 ${bookmark.name}`}
                            onClick={() => {
                              actions.deleteBookmark(bookmark.id);
                            }}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
};
