import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { CanvasBookmark } from '#canvas-engine';
import type { CanvasId, DocId, VaultPath } from '#doc-model';
import type { CommandDescriptor } from '../../kernel/types.ts';
import { isEscTop, useEscLayer } from '../esc-arbiter.ts';
import { useFocusTrap } from '../use-focus-trap.ts';
import { useKernel } from '../kernel-provider.tsx';
import { requestCanvasView } from '../canvas/canvas-view-signal.ts';
import type { CanvasLibrary } from '../canvas/use-canvas-library.ts';
import { paletteWindow } from '../components/list-window.ts';
import { editorArgsFor, filterCommands, scopeLabel } from './palette.ts';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  readonly commands: readonly CommandDescriptor[];
  readonly activeDocId: string | null;
  /** 画布库导航：画布 / 书签 / 在画布中显示 */
  readonly library: CanvasLibrary;
  /** 文档结果：打开浮窗；line 非空时滚动到命中行并高亮 */
  readonly onOpenDoc: (docId: DocId, line: number | null) => void;
  readonly onClose: () => void;
}

type SearchRow =
  | { readonly kind: 'doc'; readonly id: string; readonly title: string; readonly path: string; readonly snippet: string; readonly line: number | null }
  | { readonly kind: 'node'; readonly docId: string; readonly title: string; readonly canvasId: string; readonly canvasTitle: string; readonly nodeId: string }
  | { readonly kind: 'canvas'; readonly id: string; readonly title: string; readonly nodeCount: number }
  | { readonly kind: 'bookmark'; readonly canvasId: string; readonly canvasTitle: string; readonly bookmark: CanvasBookmark }
  | { readonly kind: 'command'; readonly command: CommandDescriptor };

const GROUP_LABEL: Record<SearchRow['kind'], string> = {
  doc: '文档',
  node: '画布节点',
  canvas: '画布',
  bookmark: '书签',
  command: '命令',
};

const rowKey = (row: SearchRow): string => {
  switch (row.kind) {
    case 'doc':
      return `doc:${row.id}`;
    case 'node':
      return `node:${row.nodeId}`;
    case 'canvas':
      return `canvas:${row.id}`;
    case 'bookmark':
      return `bookmark:${row.canvasId}:${row.bookmark.id}`;
    case 'command':
      return `command:${String(row.command.id)}`;
  }
};

const RECENCY_CHOICES = [
  { id: 'all', label: '全部时间' },
  { id: 'day', label: '今天' },
  { id: 'week', label: '本周' },
] as const;

type RecencyId = (typeof RECENCY_CHOICES)[number]['id'];

const recencyCutoff = (id: RecencyId): number => {
  if (id === 'all') return 0;
  const now = Date.now();
  return id === 'day' ? now - 24 * 3600 * 1000 : now - 7 * 24 * 3600 * 1000;
};

/**
 * ⌘K 统一搜索：一个入口找所有。
 * 分组结果：文档（索引） / 画布节点 / 画布 / 书签 / 命令；
 * 筛选：标签、所在画布、路径前缀、最近修改；
 * 结果动作：打开浮窗、飞到画布（含节点高亮）、进入画布、跳书签、执行命令。
 */
export const CommandPalette = ({
  commands,
  activeDocId,
  library,
  onOpenDoc,
  onClose,
}: CommandPaletteProps): ReactElement => {
  const kernel = useKernel();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
  const [canvasFilter, setCanvasFilter] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [recency, setRecency] = useState<RecencyId>('all');
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEscLayer('palette', true);
  // 必须在下面聚焦输入框之前调用：trap 要在焦点被移走前记住打开前的焦点元素
  useFocusTrap(dialogRef);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 查询防抖：索引搜索与画布定位都不便宜，150ms 足够跟手
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(query);
    }, 150);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const docHits = useQuery({
    queryKey: ['index', 'search', debounced, selectedTags.join('|'), pathPrefix, recency],
    queryFn: () =>
      kernel.index.search({
        text: debounced,
        limit: 8,
        ...(selectedTags.length > 0 ? { tags: selectedTags } : {}),
        ...(pathPrefix.trim().length > 0 ? { pathPrefix: pathPrefix.trim() as VaultPath } : {}),
      }),
  });
  const bookmarks = useQuery({
    queryKey: ['canvas', 'bookmarks'],
    queryFn: () => kernel.canvas.bookmarks(),
    enabled: debounced.trim().length > 0,
  });

  // 最近修改过滤需要 updated 时间：从文档清单取（搜索命中本身不带时间）
  const updatedByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const meta of documents.data ?? []) map.set(String(meta.path), meta.updated);
    return map;
  }, [documents.data]);

  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const meta of documents.data ?? []) {
      for (const tag of meta.tags) tags.add(tag);
    }
    return [...tags].slice(0, 6).sort((left, right) => left.localeCompare(right));
  }, [documents.data]);

  const rows = useMemo<readonly SearchRow[]>(() => {
    const keyword = debounced.trim().toLowerCase();
    const result: SearchRow[] = [];

    const cutoff = recencyCutoff(recency);
    // 文档清单未就绪时时间戳缺失会让「今天/本周」形同虚设：清单未载入前不做最近过滤
    const recencyReady = recency === 'all' || documents.isPending === false;
    const passesRecency = (path: string): boolean => {
      if (!recencyReady) return true;
      const updated = updatedByPath.get(path) ?? '';
      if (updated === '') return false;
      const at = Date.parse(updated);
      if (Number.isNaN(at)) return true;
      return at >= cutoff;
    };
    for (const hit of docHits.data?.hits ?? []) {
      if (!passesRecency(String(hit.path))) continue;
      result.push({
        kind: 'doc',
        id: String(hit.id),
        title: hit.title,
        path: String(hit.path),
        snippet: hit.snippet,
        line: hit.line,
      });
    }

    const canvases = library.canvases.filter(
      (canvas) => keyword.length === 0 || canvas.title.toLowerCase().includes(keyword),
    );
    for (const canvas of canvases.slice(0, 4)) {
      result.push({
        kind: 'canvas',
        id: String(canvas.id),
        title: canvas.title,
        nodeCount: canvas.nodeCount,
      });
    }

    for (const entry of bookmarks.data ?? []) {
      if (keyword.length === 0 || entry.bookmark.name.toLowerCase().includes(keyword)) {
        result.push({
          kind: 'bookmark',
          canvasId: String(entry.canvasId),
          canvasTitle: entry.canvasTitle,
          bookmark: entry.bookmark,
        });
      }
    }

    return result;
  }, [docHits.data, library.canvases, bookmarks.data, debounced, recency, updatedByPath, documents.isPending]);

  // 画布节点行单独异步补齐（locateDoc 是全画布扫描，只对前 2 个命中做）
  const [nodeRows, setNodeRows] = useState<readonly SearchRow[]>([]);
  const topDocIds = useMemo(
    () => (docHits.data?.hits ?? []).slice(0, 2).map((hit) => String(hit.id)),
    [docHits.data],
  );
  useEffect(() => {
    if (debounced.trim().length === 0) {
      setNodeRows([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const collected: SearchRow[] = [];
      for (const docId of topDocIds) {
        const locations = await kernel.canvas.locateDoc(docId as DocId);
        for (const location of locations.slice(0, 2)) {
          const title = docHits.data?.hits.find((hit) => String(hit.id) === docId)?.title ?? docId;
          collected.push({
            kind: 'node',
            docId,
            title,
            canvasId: String(location.canvasId),
            canvasTitle: location.canvasTitle,
            nodeId: location.nodeId,
          });
        }
      }
      if (!cancelled) setNodeRows(collected);
    })();
    return () => {
      cancelled = true;
    };
  }, [kernel, topDocIds, debounced, docHits.data]);

  const commandRows = useMemo<readonly SearchRow[]>(
    () =>
      filterCommands(commands, debounced).map((command) => ({
        kind: 'command' as const,
        command,
      })),
    [commands, debounced],
  );

  const visible = useMemo(() => {
    let all = [...nodeRows, ...rows, ...commandRows];
    if (canvasFilter !== '') {
      all = all.filter((row) => {
        if (row.kind === 'canvas') return row.id === canvasFilter;
        if (row.kind === 'bookmark') return row.canvasId === canvasFilter;
        if (row.kind === 'node') return row.canvasId === canvasFilter;
        return true;
      });
    }
    // 去重：同一 key 只保留一行（节点行在前，动作更直达）
    const seen = new Set<string>();
    return all.filter((row) => {
      const key = rowKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [nodeRows, rows, commandRows, canvasFilter]);

  const activeIndex = visible.length === 0 ? 0 : Math.min(index, visible.length - 1);
  const windowRange = useMemo(
    () => paletteWindow(visible.length, activeIndex),
    [visible.length, activeIndex],
  );

  useEffect(() => {
    itemRefs.current.get(activeIndex)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const labelOf = (row: SearchRow): { title: string; meta: string } => {
    switch (row.kind) {
      case 'doc':
        return {
          title: row.title,
          meta: row.line !== null ? `第 ${row.line} 行 · ${row.snippet}` : row.path,
        };
      case 'node':
        return { title: `${row.title}`, meta: `在画布「${row.canvasTitle}」中显示` };
      case 'canvas':
        return { title: row.title, meta: `画布 · ${row.nodeCount} 个节点` };
      case 'bookmark':
        return { title: row.bookmark.name, meta: `书签 · ${row.canvasTitle}` };
      case 'command':
        return { title: row.command.title, meta: scopeLabel(row.command.scope) };
    }
  };

  const activate = async (row: SearchRow): Promise<void> => {
    switch (row.kind) {
      case 'doc': {
        onOpenDoc(row.id as DocId, row.line);
        onClose();
        return;
      }
      case 'node': {
        library.openCanvas(row.canvasId as CanvasId);
        // 先切换画布，再请求飞到节点并高亮：目标画布挂载后消费挂起请求
        requestCanvasView({ highlightNodeId: row.nodeId });
        onClose();
        return;
      }
      case 'canvas': {
        library.openCanvas(row.id as CanvasId);
        onClose();
        return;
      }
      case 'bookmark': {
        library.openCanvas(row.canvasId as CanvasId);
        requestCanvasView({
          viewport: row.bookmark.viewport,
          filters: row.bookmark.filters,
        });
        onClose();
        return;
      }
      case 'command': {
        if (running) return;
        const args =
          row.command.scope === 'editor' ? editorArgsFor(activeDocId as DocId | null) : undefined;
        if (row.command.scope === 'editor' && args === null) {
          setError('先打开一篇文档，再执行这条命令');
          return;
        }
        setRunning(true);
        setError(null);
        const result = await kernel.commands.execute(row.command.id, args ?? undefined);
        setRunning(false);
        if (result.ok) {
          onClose();
          return;
        }
        setError(result.error ?? '命令执行失败');
      }
    }
  };

  // Esc 统一仲裁走 window 级：聚焦在列表按钮上时输入框的 onKeyDown 收不到
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (!isEscTop('palette')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (visible.length > 0) setIndex((activeIndex + 1) % visible.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (visible.length > 0) setIndex((activeIndex + visible.length - 1) % visible.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = visible[activeIndex];
      if (row !== undefined) void activate(row);
    }
  };

  let lastKind: SearchRow['kind'] | null = null;

  return (
    <div
      className={styles.scrim}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="统一搜索"
      >
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          placeholder="搜索文档、画布、书签、命令…"
          aria-label="统一搜索"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setIndex(0);
            setError(null);
          }}
          onKeyDown={onKeyDown}
        />

        <div className={styles.filters} data-canvas-overlay="search-filters">
          <div className={styles.filterChips}>
            {availableTags.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`${styles.filterChip} ${selectedTags.includes(tag) ? styles.filterChipActive : ''}`}
                onClick={() => {
                  setSelectedTags((current) =>
                    current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
                  );
                  setIndex(0);
                }}
              >
                #{tag}
              </button>
            ))}
          </div>
          <select
            className={styles.filterSelect}
            aria-label="按画布筛选"
            value={canvasFilter}
            onChange={(event) => {
              setCanvasFilter(event.currentTarget.value);
              setIndex(0);
            }}
          >
            <option value="">全部画布</option>
            {library.canvases.map((canvas) => (
              <option key={String(canvas.id)} value={String(canvas.id)}>
                {canvas.title}
              </option>
            ))}
          </select>
          <select
            className={styles.filterSelect}
            aria-label="按最近修改筛选"
            value={recency}
            onChange={(event) => {
              setRecency(event.currentTarget.value as RecencyId);
              setIndex(0);
            }}
          >
            {RECENCY_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
          <input
            className={styles.filterInput}
            placeholder="路径前缀…"
            aria-label="按路径筛选"
            value={pathPrefix}
            onChange={(event) => {
              setPathPrefix(event.currentTarget.value);
              setIndex(0);
            }}
          />
        </div>

        {visible.length === 0 ? (
          <p className={styles.empty}>没有匹配的结果</p>
        ) : (
          <ul className={styles.list} id="command-palette-list" role="listbox" aria-label="搜索结果">
            {visible.slice(windowRange.start, windowRange.end).map((row, offset) => {
              const position = windowRange.start + offset;
              const key = rowKey(row);
              const label = labelOf(row);
              const showGroup = row.kind !== lastKind;
              lastKind = row.kind;
              return (
                <li key={key}>
                  {showGroup ? <p className={styles.group}>{GROUP_LABEL[row.kind]}</p> : null}
                  <button
                    ref={(node) => {
                      if (node === null) itemRefs.current.delete(position);
                      else itemRefs.current.set(position, node);
                    }}
                    type="button"
                    role="option"
                    aria-selected={position === activeIndex}
                    className={position === activeIndex ? `${styles.item} ${styles.itemActive}` : styles.item}
                    onMouseEnter={() => {
                      setIndex(position);
                    }}
                    onClick={() => {
                      void activate(row);
                    }}
                  >
                    <span className={styles.itemTitle}>{label.title}</span>
                    <span className={`${styles.itemMeta} ${row.kind === 'doc' ? styles.itemSnippet : ''}`}>
                      {row.kind === 'doc' && row.snippet.length > 0 ? row.snippet : label.meta}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error !== null ? <p className={styles.error}>{error}</p> : null}
        <footer className={styles.foot}>↑↓ 选择 · Enter 到达 · Esc 关闭 · ⌘K 开关面板</footer>
      </div>
    </div>
  );
};
