import { useQuery } from '@tanstack/react-query';
import { useRef, useState, useEffect, type RefObject } from 'react';
import { readAsset } from '../../data/tauri/asset-port.ts';
import { toErrorText } from '../../kernel/errors.ts';

/**
 * 资产缩略图与懒加载（附件面板与画布图片节点共用）。
 * 从旧图库窗口迁出：读取走 asset_read，缓存里驻留降采样后的缩略图而不是整图 base64。
 */

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

export interface AssetImage {
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

export const useAssetImage = (path: string, enabled: boolean): AssetImage => {
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
    error: query.error === null ? null : toErrorText(query.error),
    loading: enabled && query.isPending,
  };
};

/** 元素进入视野附近（含画布节点）才读盘：几十张图不等于打开即全量 IPC */
export const useNearViewport = (ref: RefObject<Element | null>, margin = '240px'): boolean => {
  const [near, setNear] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: margin },
    );
    observer.observe(node);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [ref, near, margin]);

  return near;
};
