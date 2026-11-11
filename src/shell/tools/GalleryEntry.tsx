import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import type { DocId } from '#doc-model';
import { listAssets, readAsset, saveAsset } from '../../data/tauri/asset-port.ts';
import { useMachineStore } from '../../data/stores/machine-store.ts';
import {
  FLOAT_ZONES,
  moveFloatFrame,
  resolveFloatResize,
  type FloatFrame,
  type FloatZone,
} from '../editor/float-layout.ts';
import {
  buildFilters,
  displayName,
  filterGallery,
  formatBytes,
  galleryItems,
  GALLERY_ACCEPT,
  isGalleryFilter,
  MAX_GALLERY_ASSETS,
  type GalleryDoc,
  type GalleryFilter,
  type GalleryItem,
} from './gallery.ts';
import {
  clampGalleryFrame,
  GALLERY_KEY,
  galleryBounds,
  galleryFrameFromMemory,
  type Viewport,
} from './gallery-window.ts';
import { useDocTexts } from '../docs/use-doc-texts.ts';
import { useKernel } from '../kernel-provider.tsx';
import { useFloatStore } from '../editor/float-store.ts';
import styles from './ToolEntry.module.css';
import galleryStyles from './GalleryEntry.module.css';

const GalleryIcon = (): ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="2.2" y="3" width="11.6" height="10" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="5.6" cy="6.2" r="1.1" stroke="currentColor" strokeWidth="1.1" />
    <path d="M3.2 11.4 6.5 8.4l2.2 2 1.8-1.6 2.3 2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

const errorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
};

/** WebView 里 File 的 type 可能为空，先按扩展名，再退回 file.type */
const mimeOf = (file: File): string => {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? file.type;
};

/** 分块转换，避免 20 MB 图片一次性展开参数把调用栈打爆 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

interface AssetImage {
  readonly dataUrl: string | null;
  readonly error: string | null;
  readonly loading: boolean;
}

/** 缩略图最长边：面板里的 128px 格子，256px 留一倍余量给 DPR */
const THUMB_MAX_EDGE = 256;

/**
 * 大图降采样成 ≤256px 的 PNG：react-query 缓存里驻留的是缩略图而不是整图 base64。
 * GIF 不降采样（会丢动画）；环境缺 OffscreenCanvas 或解码失败时回落原图。
 */
const downscaleThumbnail = async (mime: string, base64: string): Promise<string> => {
  const original = `data:${mime};base64,${base64}`;
  if (mime === 'image/gif') return original;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return original;
  }
  const blob = await (await fetch(original)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return original;
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * scale)),
      Math.max(1, Math.round(bitmap.height * scale)),
    );
    const context = canvas.getContext('2d');
    if (context === null) return original;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encoded = await canvas.convertToBlob({ type: 'image/png' });
    return `data:image/png;base64,${toBase64(new Uint8Array(await encoded.arrayBuffer()))}`;
  } finally {
    bitmap.close();
  }
};

const useAssetImage = (path: string, enabled: boolean): AssetImage => {
  const query = useQuery({
    queryKey: ['asset', 'thumb', path],
    queryFn: async () => {
      const asset = await readAsset(path);
      try {
        return { mime: asset.mime, data: await downscaleThumbnail(asset.mime, asset.data) };
      } catch {
        // 解码/降采样失败：回落原图，缩略图仍可显示
        return asset;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
  });
  return {
    dataUrl:
      query.data === undefined ? null : `data:${query.data.mime};base64,${query.data.data}`,
    error: query.error === null ? null : errorText(query.error),
    loading: enabled && query.isPending,
  };
};

interface GalleryTileProps {
  readonly item: GalleryItem;
  readonly onOpen: () => void;
}

/** 缩略图进入视野附近才读盘：400 张图不会在打开面板时全部走一次 IPC */
const GalleryTile = ({ item, onOpen }: GalleryTileProps): ReactElement => {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [near]);

  const image = useAssetImage(item.asset.path, near);
  const usage = item.docs.length === 0 ? '未引用' : `${item.docs.length} 篇引用`;

  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={galleryStyles.tile}
        title={item.asset.path}
        onClick={onOpen}
      >
        <span className={galleryStyles.thumb}>
          {image.dataUrl !== null ? (
            <img src={image.dataUrl} alt="" loading="lazy" />
          ) : (
            <span className={galleryStyles.thumbNote}>
              {image.error !== null ? '读取失败' : image.loading ? '加载中…' : ''}
            </span>
          )}
        </span>
        <span className={galleryStyles.tileText}>
          <span className={galleryStyles.tileName}>{displayName(item.asset.name)}</span>
          <span className={galleryStyles.tileSub}>
            {formatBytes(item.asset.bytes)} · {usage}
          </span>
        </span>
      </button>
    </li>
  );
};

interface LightboxProps {
  readonly item: GalleryItem;
  readonly onClose: () => void;
  readonly onOpenDoc: (doc: GalleryDoc) => void;
}

const Lightbox = ({ item, onClose, onOpenDoc }: LightboxProps): ReactElement => {
  const image = useAssetImage(item.asset.path, true);

  return (
    <div
      className={galleryStyles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={`查看图片 ${displayName(item.asset.name)}`}
    >
      <button
        type="button"
        className={galleryStyles.backdrop}
        aria-label="关闭大图"
        onClick={onClose}
      />
      <div className={galleryStyles.stage}>
        <header className={styles.head}>
          <span className={styles.title}>{displayName(item.asset.name)}</span>
          <button type="button" className={styles.close} aria-label="关闭大图" onClick={onClose}>
            ×
          </button>
        </header>
        <div className={galleryStyles.stageBody}>
          {image.dataUrl !== null ? (
            <img src={image.dataUrl} alt="" />
          ) : (
            <span className={galleryStyles.stageNote}>
              {image.error !== null ? `读取失败：${image.error}` : '加载中…'}
            </span>
          )}
        </div>
        <footer className={galleryStyles.stageFoot}>
          <span className={galleryStyles.stageMeta}>
            {formatBytes(item.asset.bytes)} · {item.asset.path}
          </span>
          {item.docs.length === 0 ? (
            <span className={galleryStyles.stageNote}>还没有文档引用这张图片</span>
          ) : (
            <span className={galleryStyles.uses}>
              引用：
              {item.docs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={galleryStyles.useLink}
                  onClick={() => {
                    onOpenDoc(doc);
                  }}
                >
                  {doc.title.trim().length === 0 ? '未命名' : doc.title}
                </button>
              ))}
            </span>
          )}
        </footer>
      </div>
    </div>
  );
};

export interface GalleryEntryProps {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onClose: () => void;
}

/** 拖窗或四角缩放：起点帧 + 按下时的指针位置 + 捕获的 pointerId（多输入源互不干扰） */
type Gesture = {
  readonly kind: 'move' | FloatZone;
  readonly start: FloatFrame;
  readonly x: number;
  readonly y: number;
  readonly pointerId: number;
};

const readViewport = (): Viewport => ({
  width: typeof window === 'undefined' ? 1280 : window.innerWidth,
  height: typeof window === 'undefined' ? 820 : window.innerHeight,
});

/**
 * 图库入口：图库面板自带导入按钮（asset_save 的唯一调用方），
 * 图片按 sha256 内容寻址存在库内 `media/`，正文引用关系由前端扫描建立（临时方案）。
 * 只提供按钮与浮层锚点；排在左下角哪一格由 ToolRail 的 flex 顺序决定。
 */
export const GalleryEntry = ({ open, onToggle, onClose }: GalleryEntryProps): ReactElement => {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<GalleryFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importFailed, setImportFailed] = useState(false);

  // 常驻浮窗：位置与尺寸沿用文章浮窗的两张既有表，不占 FLOAT_LIMIT 名额
  const savedPosition = useMachineStore((state) => state.floatPositions[GALLERY_KEY]);
  const savedSize = useMachineStore((state) => state.floatSizes[GALLERY_KEY]);
  const [viewport, setViewport] = useState<Viewport>(readViewport);
  const [frame, setFrame] = useState<FloatFrame>(() =>
    galleryFrameFromMemory(savedPosition, savedSize, readViewport()),
  );
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const frameRef = useRef(frame);
  const wasOpen = useRef(false);
  const latestMemory = useRef({ position: savedPosition, size: savedSize, viewport });

  useEffect(() => {
    latestMemory.current = { position: savedPosition, size: savedSize, viewport };
  }, [savedPosition, savedSize, viewport]);

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  // 打开时按记忆恢复一次；拖动/缩放写回记忆时不重置，避免和手势抢帧
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) return;
    const memory = latestMemory.current;
    setFrame(galleryFrameFromMemory(memory.position, memory.size, memory.viewport));
  }, [open]);

  useEffect(() => {
    const onResize = (): void => {
      setViewport(readViewport());
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // 窗口变窄时夹紧，保证不压住顶栏、状态栏、左下横排与右下 HUD
  useEffect(() => {
    setFrame((current) => clampGalleryFrame(current, viewport));
  }, [viewport]);

  // 手势期间只更新内存帧；松手才写一次机器状态。
  // move/up 都按 pointerId 过滤（第二输入源不叠加移动），捕获丢失时立即收尾
  useEffect(() => {
    if (gesture === null) return;
    const owned = (event: PointerEvent): boolean => event.pointerId === gesture.pointerId;
    const onMove = (event: PointerEvent): void => {
      if (!owned(event)) return;
      const deltaX = event.clientX - gesture.x;
      const deltaY = event.clientY - gesture.y;
      const next =
        gesture.kind === 'move'
          ? moveFloatFrame(gesture.start, deltaX, deltaY, {
              width: viewport.width,
              height: viewport.height,
            })
          : resolveFloatResize(gesture.kind, gesture.start, deltaX, deltaY, galleryBounds(viewport));
      setFrame(clampGalleryFrame(next, viewport));
    };
    const onUp = (event: PointerEvent): void => {
      if (!owned(event)) return;
      finishGesture();
    };
    const onLostCapture = (): void => {
      // 捕获被系统抢走（IME/辅助功能/DOM 重建）：手势就地收尾，避免「粘住」
      finishGesture();
    };
    const finishGesture = (): void => {
      const final = frameRef.current;
      const store = useMachineStore.getState();
      store.rememberFloatPosition(GALLERY_KEY, { left: final.left, top: final.top });
      store.rememberFloatSize(GALLERY_KEY, { width: final.width, height: final.height });
      setGesture(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('lostpointercapture', onLostCapture);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('lostpointercapture', onLostCapture);
    };
  }, [gesture, viewport]);

  const startGesture = (kind: 'move' | FloatZone, event: ReactPointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setGesture({ kind, start: frame, x: event.clientX, y: event.clientY, pointerId: event.pointerId });
  };

  const assetQuery = useQuery({ queryKey: ['assets', 'list'], queryFn: listAssets });
  const docTexts = useDocTexts(open);
  const docs = useMemo<readonly GalleryDoc[]>(
    () =>
      (docTexts.data ?? []).map((doc) => ({
        id: String(doc.id),
        title: doc.title,
        path: String(doc.path),
        text: doc.text,
      })),
    [docTexts.data],
  );

  const refetchAssets = assetQuery.refetch;
  useEffect(() => {
    if (!open) return;
    void refetchAssets();
  }, [open, refetchAssets]);

  const items = useMemo(() => galleryItems(assetQuery.data ?? [], docs), [assetQuery.data, docs]);
  const options = useMemo(() => buildFilters(items), [items]);
  const effectiveFilter: GalleryFilter = options.some((option) => option.value === filter)
    ? filter
    : 'all';
  const visible = useMemo(
    () => filterGallery(items, effectiveFilter, query),
    [items, effectiveFilter, query],
  );
  // 灯箱不随筛选关闭：筛选变化时仍显示当前选中的图片
  const selectedItem = items.find((item) => item.asset.path === selected) ?? null;

  const readonlyMode = kernel.env.readonlyMode;
  const count = assetQuery.data?.length ?? 0;
  const atLimit = count >= MAX_GALLERY_ASSETS;
  const importDisabled = readonlyMode || importing || atLimit;

  const importFiles = async (files: readonly File[]): Promise<void> => {
    setImporting(true);
    setImportNote(null);
    setImportFailed(false);
    let saved = 0;
    let deduped = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await saveAsset(toBase64(bytes), mimeOf(file));
        if (result.deduped) deduped += 1;
        else saved += 1;
      } catch (error) {
        failures.push(`${file.name}（${errorText(error)}）`);
      }
    }
    setImporting(false);
    setImportFailed(failures.length > 0);
    const parts: string[] = [];
    if (saved > 0) parts.push(`新存 ${saved} 张`);
    if (deduped > 0) parts.push(`${deduped} 张内容已存在，直接复用`);
    if (failures.length > 0) parts.push(`失败 ${failures.length} 张：${failures.join('；')}`);
    setImportNote(parts.length > 0 ? parts.join('；') : '没有可导入的图片');
    if (saved > 0) await queryClient.invalidateQueries({ queryKey: ['assets', 'list'] });
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (files.length === 0) return;
    void importFiles(files);
  };

  const openDoc = (doc: GalleryDoc): void => {
    setSelected(null);
    onClose();
    useFloatStore.getState().open(doc.id as DocId, null);
  };

  return (
    <div className={styles.slot}>
      <button
        type="button"
        className={styles.entry}
        aria-expanded={open}
        aria-label={`图库 ${assetQuery.isPending ? '' : count} 张图片`}
        title="库内图片与正文引用"
        onClick={onToggle}
      >
        <GalleryIcon />
        <span>图库</span>
        {assetQuery.isPending ? null : <span className={styles.badge}>{count}</span>}
      </button>

      {open
        ? createPortal(
            <section
              className={galleryStyles.window}
              style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
              role="dialog"
              aria-label="图库"
              data-dragging={gesture !== null}
            >
              <header
                className={galleryStyles.windowHead}
                onPointerDown={(event) => {
                  const target = event.target;
                  if (target instanceof Element && target.closest('button, input, select, a') !== null) {
                    return;
                  }
                  startGesture('move', event);
                }}
              >
                <h2 className={styles.title}>图库</h2>
                <span className={galleryStyles.headActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={importDisabled}
                    onClick={() => {
                      fileInput.current?.click();
                    }}
                  >
                    {importing ? '导入中…' : '导入图片'}
                  </button>
                  <button type="button" className={styles.close} aria-label="关闭图库" onClick={onClose}>
                    ×
                  </button>
                </span>
              </header>
              <input
                ref={fileInput}
                type="file"
                accept={GALLERY_ACCEPT}
                multiple
                hidden
                onChange={onPickFiles}
              />

              <div className={galleryStyles.toolbar}>
                <input
                  type="search"
                  className={galleryStyles.search}
                  value={query}
                  placeholder="搜索文件名或被引用文档"
                  aria-label="搜索图库"
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                  }}
                />
                <select
                  className={galleryStyles.select}
                  value={effectiveFilter}
                  aria-label="按顶层目录筛选"
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    if (isGalleryFilter(next)) setFilter(next);
                  }}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}（{option.count}）
                    </option>
                  ))}
                </select>
              </div>

              <p className={styles.note}>
                {readonlyMode ? '当前库为只读，只能查看。' : ''}
                PNG / JPEG / GIF / WebP / AVIF，单张 ≤ 20 MB，最多 400 张；同内容按 sha256 去重。
              </p>
              {importNote !== null ? (
                <p className={importFailed ? `${galleryStyles.status} ${galleryStyles.statusError}` : galleryStyles.status}>
                  {importNote}
                </p>
              ) : null}

              <div className={galleryStyles.body}>
                {assetQuery.error !== null ? (
                  <p className={styles.empty}>读取图库失败：{errorText(assetQuery.error)}</p>
                ) : null}
                {assetQuery.isPending ? <p className={styles.empty}>正在扫描图库…</p> : null}
                {!assetQuery.isPending && assetQuery.error === null && items.length === 0 ? (
                  <p className={styles.empty}>
                    {readonlyMode
                      ? '库内还没有图片。'
                      : '图库还是空的。点右上角「导入图片」把本地图片存进库内 media/。'}
                  </p>
                ) : null}
                {!assetQuery.isPending && items.length > 0 && visible.length === 0 ? (
                  <p className={styles.empty}>没有匹配的图片。</p>
                ) : null}
                {visible.length > 0 ? (
                  <ul className={galleryStyles.grid}>
                    {visible.map((item) => (
                      <GalleryTile
                        key={item.asset.path}
                        item={item}
                        onOpen={() => {
                          setSelected(item.asset.path);
                        }}
                      />
                    ))}
                  </ul>
                ) : null}
              </div>

              {selectedItem !== null ? (
                <Lightbox
                  item={selectedItem}
                  onClose={() => {
                    setSelected(null);
                  }}
                  onOpenDoc={openDoc}
                />
              ) : null}

              {FLOAT_ZONES.map((zone) => (
                <span
                  key={zone}
                  className={galleryStyles.handle}
                  data-zone={zone}
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    startGesture(zone, event);
                  }}
                />
              ))}
            </section>,
            document.body,
          )
        : null}
    </div>
  );
};
