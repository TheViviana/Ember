import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { readAsset } from '../../data/tauri/asset-port.ts';
import { localAssetPath } from './reading-asset.ts';
import styles from './AssetImage.module.css';

export interface AssetImageProps {
  readonly src: string;
  readonly alt: string;
}

/**
 * 阅读态内嵌图片：走既有 asset_read 读 `media/`，base64 拼 data: 交给 <img>。
 * 不用 blob: —— 当前 CSP 的 img-src 只放行 'self' 与 data:；
 * 外链 / 读取失败一律回退 alt 文本，绝不在运行时联网。
 */
export const AssetImage = ({ src, alt }: AssetImageProps): ReactElement => {
  const path = localAssetPath(src);
  const query = useQuery({
    queryKey: ['asset', 'read', path ?? ''],
    queryFn: () => readAsset(path ?? ''),
    enabled: path !== null,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const data = path === null ? undefined : query.data;
  if (data === undefined) return <span className={styles.fallback}>{alt}</span>;

  return (
    <img
      className={styles.image}
      src={`data:${data.mime};base64,${data.data}`}
      alt={alt}
      loading="lazy"
    />
  );
};
