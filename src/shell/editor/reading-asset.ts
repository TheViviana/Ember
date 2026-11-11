/**
 * 阅读态图片地址解析：只认本地资产库里的 `media/...`。
 * Markdown 里出现 http(s)、data、file 等外链一律不读盘，也不在运行时联网。
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MEDIA_PREFIX = 'media/';

/** Markdown 图片 src → 资产库相对路径；不是本地资产时返回 null */
export const localAssetPath = (src: string): string | null => {
  const trimmed = src.trim();
  if (trimmed.length === 0) return null;
  // 任何带协议（http:、data:、blob:、file:…）或协议相对地址都拒绝
  if (SCHEME.test(trimmed) || trimmed.startsWith('//')) return null;

  let path = trimmed;
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/^\/+/, '');

  if (!path.startsWith(MEDIA_PREFIX) || path.length <= MEDIA_PREFIX.length) return null;
  // 目录穿越：AssetImage 只读 media/，逐段检查避免 `media/../secret`
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return null;

  return path;
};
