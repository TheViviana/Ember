import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type { DocMeta } from '../../kernel/types.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import {
  breadcrumbOf,
  buildAnchorTree,
  filterFolder,
  folderAt,
  folderLabel,
  menuBack,
  type AnchorDoc,
} from './anchor-menu.ts';
import { cssVars } from './css-vars.ts';
import styles from './AnchorMenu.module.css';

export interface AnchorMenuProps {
  /** 画布内坐标（相对 .canvas 左上角），即引线松手位置 */
  readonly x: number;
  readonly y: number;
  readonly docs: readonly DocMeta[];
  /**
   * anchor = 引线拖到空白（根菜单含新建节点/文章）；
   * insert = 空白右键「从库添加已有文章」，直接进入目录下钻，不提供建节点入口。
   */
  readonly purpose?: 'anchor' | 'insert';
  readonly onNote: () => void;
  readonly onPickDoc: (doc: AnchorDoc) => void;
  readonly onNewArticle: () => void;
  readonly onClose: () => void;
}

type View = 'root' | 'browse' | 'docs';

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly onSelect: () => void;
}

const directoryOf = (path: string): string => {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  return segments.length <= 1 ? '库根目录' : segments.slice(0, -1).join('/');
};

export const AnchorMenu = ({
  x,
  y,
  docs,
  purpose = 'anchor',
  onNote,
  onPickDoc,
  onNewArticle,
  onClose,
}: AnchorMenuProps): ReactElement => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x, y });
  const [view, setView] = useState<View>(purpose === 'insert' ? 'browse' : 'root');
  const [segments, setSegments] = useState<readonly string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [active, setActive] = useState(0);

  const tree = useMemo(() => buildAnchorTree(docs), [docs]);
  const folder = useMemo(() => folderAt(tree, segments) ?? tree, [tree, segments]);
  const listing = useMemo(() => filterFolder(folder, keyword), [folder, keyword]);

  const entries = useMemo<readonly Entry[]>(() => {
    if (view === 'root') {
      return [
        { id: 'note', label: '创建空节点', hint: '便签', onSelect: onNote },
        {
          id: 'docs',
          label: '添加文章…',
          hint: '从库中选择',
          onSelect: () => {
            setView('browse');
            setKeyword('');
          },
        },
        { id: 'article', label: '新建文章', hint: '落盘并关联', onSelect: onNewArticle },
      ];
    }

    const docEntries = listing.docs.map((doc) => ({
      id: `doc:${doc.id}`,
      label: doc.title,
      hint: directoryOf(doc.path),
      onSelect: () => onPickDoc(doc),
    }));

    if (view === 'docs' || folder.folders.length === 0) return docEntries;

    const folderEntries = listing.folders.map((item) => ({
      id: `folder:${item.path}`,
      label: folderLabel(item),
      hint: `${item.folders.length + item.docs.length} 项`,
      onSelect: () => {
        setSegments(item.path.split('/').filter((segment) => segment.length > 0));
        setKeyword('');
        setView('browse');
      },
    }));
    return [
      ...folderEntries,
      ...(folder.docs.length === 0
        ? []
        : [
            {
              id: 'docs-here',
              label: '本层文章',
              hint: `${folder.docs.length} 篇`,
              onSelect: () => {
                setView('docs');
              },
            },
          ]),
    ];
  }, [folder, listing.docs, listing.folders, onNewArticle, onNote, onPickDoc, view]);

  useEffect(() => {
    setActive(0);
  }, [view, segments, keyword]);

  useLayoutEffect(() => {
    const element = rootRef.current;
    const parent = element?.offsetParent;
    if (element === null || !(parent instanceof HTMLElement)) {
      setPosition({ x, y });
      return;
    }
    const maxX = Math.max(8, parent.clientWidth - element.offsetWidth - 8);
    const maxY = Math.max(8, parent.clientHeight - element.offsetHeight - 8);
    setPosition({ x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) });
  }, [x, y, view, entries.length]);

  useEffect(() => {
    rootRef.current?.focus();
  }, [view, segments]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      onClose();
    };
    const onBlur = (): void => {
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  const goBack = (): void => {
    const next = menuBack({ view, segments, keyword });
    if (next === null) {
      onClose();
      return;
    }
    // insert 模式没有根菜单：退到「全部文章」再按 Esc 直接关闭
    if (purpose === 'insert' && next.view === 'root') {
      onClose();
      return;
    }
    setKeyword(next.keyword);
    setSegments(next.segments);
    setView(next.view);
  };

  useEscLayer('anchor-menu', true);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // IME 组合态按 Esc 是取消组合，不是关闭菜单
      if (event.nativeEvent.isComposing) return;
      // 统一仲裁：更晚打开的浮层持有 Esc 时本层让位；自己是栈顶时就地消费、不冒泡
      if (!isEscTop('anchor-menu')) return;
      event.preventDefault();
      event.stopPropagation();
      goBack();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 组合态方向键用于候选词翻页，不移动菜单选中项
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (entries.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActive((previous) => (previous + delta + entries.length) % entries.length);
      return;
    }
    if (event.key === 'Enter') {
      // 中文输入法确认候选词的那次 Enter 不应该选中条目
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      entries[active]?.onSelect();
    }
  };

  const crumbs = breadcrumbOf(segments);
  const emptyMessage = listing.empty ? '此文件夹为空' : entries.length === 0 ? '无匹配结果' : null;

  return (
    <div
      ref={rootRef}
      className={styles.menu}
      data-canvas-overlay=""
      role="menu"
      aria-label={purpose === 'insert' ? '从库添加文章' : '创建节点'}
      tabIndex={-1}
      style={cssVars({ '--anchor-menu-x': `${position.x}px`, '--anchor-menu-y': `${position.y}px` })}
      onKeyDown={onKeyDown}
    >
      {view === 'root' ? (
        <p className={styles.header}>引线终点</p>
      ) : (
        <>
          {purpose === 'insert' ? <p className={styles.header}>从库添加已有文章</p> : null}
          <nav className={styles.crumbs} aria-label="文章目录">
            {crumbs.map((crumb) => (
              <button
                key={`${crumb.depth}-${crumb.label}`}
                type="button"
                className={styles.crumb}
                onClick={() => {
                  setSegments(segments.slice(0, crumb.depth));
                  setKeyword('');
                  setView('browse');
                }}
              >
                {crumb.label}
              </button>
            ))}
          </nav>
          <input
            className={styles.search}
            value={keyword}
            placeholder="过滤当前层…"
            aria-label="过滤文章"
            onChange={(event) => {
              setKeyword(event.target.value);
            }}
          />
        </>
      )}

      {emptyMessage === null ? null : <p className={styles.empty}>{emptyMessage}</p>}

      {entries.map((entry, index) => (
        <div
          key={entry.id}
          className={[styles.item, index === active ? styles.active : '']
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join(' ')}
          role="menuitem"
          onPointerEnter={() => {
            setActive(index);
          }}
          onClick={entry.onSelect}
        >
          <span className={styles.label}>{entry.label}</span>
          {entry.hint === undefined ? null : <span className={styles.hint}>{entry.hint}</span>}
        </div>
      ))}
    </div>
  );
};
