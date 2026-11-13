import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import type { AssetEntry } from '../../data/tauri/asset-port.ts';
import { listAssets, saveAsset } from '../../data/tauri/asset-port.ts';
import type { CanvasId, DocId } from '#doc-model';
import { toErrorText } from '../../kernel/errors.ts';
import { useKernel } from '../kernel-provider.tsx';
import { useFloatStore } from '../editor/float-store.ts';
import { requestCanvasView } from '../canvas/canvas-view-signal.ts';
import type { CanvasLibrary } from '../canvas/use-canvas-library.ts';
import { useAssetImage, useNearViewport } from './asset-thumbnail.ts';
import styles from './AttachmentPanel.module.css';

export interface AttachmentPanelProps {
  readonly library: CanvasLibrary;
  readonly onClose: () => void;
}



interface UsageInfo {
  readonly docRefs: readonly { readonly srcId: string; readonly line: number; readonly raw: string }[];
  readonly canvasRefs: readonly { readonly canvasId: string; readonly canvasTitle: string; readonly nodeId: string }[];
}

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'unreferenced', label: '未引用' },
  { id: 'byCanvas', label: '按画布' },
  { id: 'byDir', label: '按目录' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

const ACCEPTED = '.png,.jpg,.jpeg,.gif,.webp,.avif';
/** 与 src-tauri/src/vault/media.rs::MAX_ASSET_BYTES 同步；Rust 常量为权威 */
const MAX_ASSET_MB = 20;

/**
 * 附件面板（替代独立图库窗口）：全部 / 未引用 / 按画布 / 按目录筛选 + 搜索 +
 * 被引用位置（索引反查文档引用、画布定位图片节点）。资产库仍由 Rust 侧
 * 内容去重（sha256），面板只是查找与引用视图。
 */
export const AttachmentPanel = ({ library, onClose }: AttachmentPanelProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const documents = useQuery({ queryKey: ['docs', 'list'], queryFn: () => kernel.docs.list() });
  const [filter, setFilter] = useState<FilterId>('all');
  const [canvasFilter, setCanvasFilter] = useState('');
  const [dirFilter, setDirFilter] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<{
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null>(null);

  const assets = useQuery({ queryKey: ['assets', 'list'], queryFn: () => listAssets() });

  // 文档引用：一次把全部资产的原始键反查完（索引内存查询，便宜）
  // 文档/索引变化时让引用统计重算（正文后台构建完成、编辑嵌入都会改变计数）
  useEffect(() => {
    const a = kernel.events.on('doc:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['attachments'] });
    });
    const b = kernel.events.on('index:updated', () => {
      void queryClient.invalidateQueries({ queryKey: ['attachments'] });
    });
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [kernel, queryClient]);

  const docUsage = useQuery({
    queryKey: ['attachments', 'doc-usage', assets.data?.length ?? 0],
    queryFn: async () => {
      const map = new Map<string, UsageInfo['docRefs']>();
      for (const asset of assets.data ?? []) {
        const records = await kernel.index.referencesByRaw(asset.name);
        map.set(
          asset.path,
          records.map((record) => ({
            srcId: String(record.srcId),
            line: record.line,
            raw: record.raw,
          })),
        );
      }
      return map;
    },
    enabled: assets.data !== undefined,
  });

  // 画布引用：只在选择「按画布」或展开某行时按需全扫（canvas 定位是全画布扫描）
  const canvasUsage = useQuery({
    queryKey: ['attachments', 'canvas-usage', assets.data?.length ?? 0],
    queryFn: async () => {
      const map = new Map<string, UsageInfo['canvasRefs']>();
      for (const asset of assets.data ?? []) {
        const locations = await kernel.canvas.locateAsset(asset.path);
        map.set(
          asset.path,
          locations.map((location) => ({
            canvasId: String(location.canvasId),
            canvasTitle: location.canvasTitle,
            nodeId: location.nodeId,
          })),
        );
      }
      return map;
    },
    enabled:
      assets.data !== undefined &&
      (filter === 'byCanvas' || filter === 'unreferenced' || expanded !== null),
  });

  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const asset of assets.data ?? []) {
      const at = asset.path.lastIndexOf('/');
      if (at > 0) set.add(asset.path.slice(0, at));
    }
    return [...set].sort();
  }, [assets.data]);

  const keyword = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const all = assets.data ?? [];
    return all.filter((asset) => {
      if (keyword.length > 0 && !asset.name.toLowerCase().includes(keyword)) return false;
      if (filter === 'unreferenced') {
        const docs = docUsage.data?.get(asset.path) ?? [];
        const canvases = canvasUsage.data?.get(asset.path) ?? [];
        return docs.length === 0 && canvases.length === 0;
      }
      if (filter === 'byCanvas' && canvasFilter !== '') {
        const canvases = canvasUsage.data?.get(asset.path) ?? [];
        return canvases.some((ref) => ref.canvasId === canvasFilter);
      }
      if (filter === 'byDir' && dirFilter !== '') {
        const at = asset.path.lastIndexOf('/');
        return at > 0 && asset.path.slice(0, at) === dirFilter;
      }
      return true;
    });
  }, [assets.data, keyword, filter, canvasFilter, dirFilter, docUsage.data, canvasUsage.data]);

  const importFiles = async (files: readonly File[]): Promise<void> => {
    setImporting(true);
    setNotice(null);
    let saved = 0;
    let deduped = 0;
    let failed = 0;
    for (const file of files) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => reject(new Error('读取文件失败'));
          reader.readAsDataURL(file);
        });
        const marker = 'base64,';
        const at = dataUrl.indexOf(marker);
        if (at < 0) throw new Error('不是可用的 data URL');
        const result = await saveAsset(dataUrl.slice(at + marker.length), file.type);
        saved += 1;
        if (result.deduped) deduped += 1;
      } catch {
        failed += 1;
      }
    }
    setImporting(false);
    setNotice(
      failed === 0
        ? `已导入 ${saved} 张${deduped > 0 ? `（${deduped} 张与库内重复，直接复用）` : ''}`
        : `${saved} 张成功，${failed} 张失败（格式或大小不符合限制：单张 ≤${String(MAX_ASSET_MB)}MB，png/jpeg/gif/webp/avif）`,
    );
    void kernel.log.info('附件导入完成', { saved, deduped, failed });
  };

  const titleOfDoc = (srcId: string): string => {
    const meta = (documents.data ?? []).find((item) => String(item.id) === srcId);
    return meta === undefined || meta.title.trim().length === 0 ? '未命名' : meta.title;
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('button, label, input, select') !== null) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    event.preventDefault();
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    setFrame({ left: start.left, top: start.top, width: start.width, height: start.height });
    const onMove = (moveEvent: PointerEvent): void => {
      setFrame({
        left: Math.max(8, Math.min(start.left + moveEvent.clientX - start.x, window.innerWidth - start.width - 8)),
        top: Math.max(8, Math.min(start.top + moveEvent.clientY - start.y, window.innerHeight - start.height - 8)),
        width: start.width,
        height: start.height,
      });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    setFrame({ left: start.left, top: start.top, width: start.width, height: start.height });
    const onMove = (moveEvent: PointerEvent): void => {
      const width = Math.min(
        Math.max(start.width - (moveEvent.clientX - start.x), 320),
        window.innerWidth - start.left - 8,
      );
      const height = Math.min(
        Math.max(start.height + (moveEvent.clientY - start.y), 240),
        window.innerHeight - start.top - 8,
      );
      setFrame({ left: start.left, top: start.top, width, height });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={styles.root}
      ref={rootRef}
      style={
        frame === null
          ? undefined
          : {
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
              right: 'auto',
              bottom: 'auto',
            }
      }
      data-canvas-overlay="attachments"
    >
      <header className={styles.header} onPointerDown={beginDrag} title="拖动移动面板">
        <span className={styles.headerIcon}>◧</span>
        <span className={styles.headerTitle}>附件</span>
        <span className={styles.headerCount}>{filtered.length}</span>
        <label className={styles.importButton}>
          {importing ? '导入中…' : '导入图片'}
          <input
            type="file"
            accept={ACCEPTED}
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void importFiles(files);
            }}
          />
        </label>
        <button type="button" className={styles.close} onClick={onClose} title="关闭">
          ✕
        </button>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.filterChips}>
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.chip} ${filter === item.id ? styles.chipActive : ''}`}
              onClick={() => {
                setFilter(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {filter === 'byCanvas' ? (
          <select
            className={styles.select}
            aria-label="选择画布"
            value={canvasFilter}
            onChange={(event) => {
              setCanvasFilter(event.currentTarget.value);
            }}
          >
            <option value="">全部画布</option>
            {library.canvases.map((canvas) => (
              <option key={String(canvas.id)} value={String(canvas.id)}>
                {canvas.title}
              </option>
            ))}
          </select>
        ) : null}
        {filter === 'byDir' ? (
          <select
            className={styles.select}
            aria-label="选择目录"
            value={dirFilter}
            onChange={(event) => {
              setDirFilter(event.currentTarget.value);
            }}
          >
            <option value="">全部目录</option>
            {dirs.map((dir) => (
              <option key={dir} value={dir}>
                {dir}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className={styles.search}
          placeholder="按文件名搜索…"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
        />
      </div>

      {notice === null ? null : <p className={styles.notice}>{notice}</p>}
      {assets.isPending ? <p className={styles.note}>正在读取附件库…</p> : null}
      {assets.isError ? (
        <p className={styles.error}>{toErrorText(assets.error)}</p>
      ) : null}
      {!assets.isPending && assets.isError === false && filtered.length === 0 ? (
        <p className={styles.note}>没有匹配的附件。拖一张图片进画布，或点「导入图片」。</p>
      ) : null}

      <div className={styles.grid}>
        {filtered.map((asset) => (
          <AssetCard
            key={asset.path}
            asset={asset}
            expanded={expanded === asset.path}
            docRefs={docUsage.data?.get(asset.path) ?? []}
            canvasRefs={canvasUsage.data?.get(asset.path) ?? []}
            usageLoading={docUsage.isPending || (expanded !== null && canvasUsage.isPending)}
            onToggle={() => {
              setExpanded((current) => (current === asset.path ? null : asset.path));
            }}
            titleOfDoc={titleOfDoc}
            onOpenDoc={(srcId) => {
              useFloatStore.getState().open(srcId as DocId, null);
              onClose();
            }}
            onOpenCanvas={(canvasId, nodeId) => {
              library.openCanvas(canvasId as CanvasId);
              requestCanvasView({ highlightNodeId: nodeId });
              onClose();
            }}
          />
        ))}
      </div>

      <div
        className={styles.resizeHandle}
        role="separator"
        aria-label="拖动调整附件面板尺寸"
        title="拖动调整尺寸"
        onPointerDown={beginResize}
      />
    </div>
  );
};

interface AssetCardProps {
  readonly asset: AssetEntry;
  readonly expanded: boolean;
  readonly docRefs: readonly { readonly srcId: string; readonly line: number; readonly raw: string }[];
  readonly canvasRefs: readonly { readonly canvasId: string; readonly canvasTitle: string; readonly nodeId: string }[];
  readonly usageLoading: boolean;
  readonly titleOfDoc: (srcId: string) => string;
  readonly onToggle: () => void;
  readonly onOpenDoc: (srcId: string) => void;
  readonly onOpenCanvas: (canvasId: string, nodeId: string) => void;
}

const AssetCard = ({
  asset,
  expanded,
  docRefs,
  canvasRefs,
  usageLoading,
  titleOfDoc,
  onToggle,
  onOpenDoc,
  onOpenCanvas,
}: AssetCardProps): ReactElement => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(cardRef);
  const image = useAssetImage(asset.path, near);

  return (
    <div className={styles.card} ref={cardRef}>
      <button
        type="button"
        className={styles.thumbButton}
        title={expanded ? '收起引用位置' : '查看被引用位置'}
        onClick={onToggle}
      >
        {image.dataUrl !== null ? (
          <img className={styles.thumb} src={image.dataUrl} alt={asset.name} draggable={false} />
        ) : (
          <span className={styles.thumbPlaceholder}>{image.loading ? '…' : '图'}</span>
        )}
      </button>
      <p className={styles.name} title={asset.path}>
        {asset.name}
      </p>
      <p className={styles.meta}>
        {usageLoading
          ? '统计中…'
          : `${docRefs.length} 篇文档 · ${canvasRefs.length} 张画布引用`}
      </p>
      {expanded ? (
        <div className={styles.usages}>
          {docRefs.length === 0 && canvasRefs.length === 0 ? (
            <p className={styles.usageEmpty}>还没有任何引用</p>
          ) : null}
          {docRefs.map((ref) => (
            <button
              key={`${ref.srcId}-${ref.line}`}
              type="button"
              className={styles.usageRow}
              title={ref.raw}
              onClick={() => {
                onOpenDoc(ref.srcId);
              }}
            >
              文档：{titleOfDoc(ref.srcId)}
            </button>
          ))}
          {canvasRefs.map((ref) => (
            <button
              key={`${ref.canvasId}-${ref.nodeId}`}
              type="button"
              className={styles.usageRow}
              onClick={() => {
                onOpenCanvas(ref.canvasId, ref.nodeId);
              }}
            >
              画布：{ref.canvasTitle}（飞到图片节点）
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
