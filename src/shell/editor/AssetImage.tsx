import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { resolveArticleImage, type ImageResolution } from '../../data/tauri/asset-port.ts';
import styles from './AssetImage.module.css';

export interface AssetImageProps {
  readonly src: string;
  readonly alt: string;
  /** 文章在库内的相对路径；解析基准，历史预览等场景可为空 */
  readonly documentPath?: string | null;
}

/** 外链不进入本地解析，也不在运行时联网 */
const isExternalReference = (reference: string): boolean => {
  if (reference.slice(0, 2) === '//') return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(reference);
};

type MissingReason = Extract<ImageResolution, { status: 'missing' }>['reason'];

const REASON_TEXT: Readonly<Record<MissingReason, string>> = {
  notFound: '文件不在库内',
  outsideVault: '路径越出库范围',
  unsupportedType: '不是支持的图片格式',
  tooLarge: '图片超过 20MB 读取上限',
  unreadable: '文件无法读取',
  external: '外链图片不在库内',
};

/**
 * 阅读态内嵌图片：按文章路径解析（文章目录 → 文章目录/images → 库根），
 * 命中后由 Rust 侧读字节并以 base64 拼 data: 交给 <img>。
 * 不用 blob: —— 当前 CSP 的 img-src 只放行 'self' 与 data:；
 * 解析不到时显示含原始引用与原因的占位，绝不静默空白、也不联网。
 */
export const AssetImage = ({ src, alt, documentPath = null }: AssetImageProps): ReactElement => {
  const reference = src.trim();
  const external = isExternalReference(reference);
  const query = useQuery({
    queryKey: ['asset', 'resolve', documentPath ?? '', reference],
    queryFn: () => resolveArticleImage(documentPath ?? '', reference),
    enabled: !external && reference !== '',
    staleTime: 5 * 60_000,
    retry: false,
  });

  const missing = (reason: string): ReactElement => (
    <span className={styles.fallback} title={reference} role="note">
      图片未找到：{reference}（{reason}）
    </span>
  );

  if (external) return missing(REASON_TEXT.external);
  if (reference === '') return <span className={styles.fallback}>{alt}</span>;
  if (query.isError) return missing(REASON_TEXT.unreadable);
  if (query.data === undefined) return <span className={styles.fallback}>{alt}</span>;
  if (query.data.status === 'missing') return missing(REASON_TEXT[query.data.reason]);

  return (
    <img
      className={styles.image}
      src={`data:${query.data.mime};base64,${query.data.data}`}
      alt={alt}
      title={query.data.path}
      loading="lazy"
    />
  );
};
