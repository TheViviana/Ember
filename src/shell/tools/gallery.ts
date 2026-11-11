/**
 * 图库的纯函数层：从正文扫描图片引用、建立"图片 → 引用文档"关系、按顶层目录筛选与搜索。
 * 不 import Tauri/React，便于用 node --test 直接跑。
 *
 * 注意：这里的引用扫描是前端临时方案（doc-model 的 AST links 只覆盖 wikilink，
 * 且索引服务仍是占位实现），规则刻意保守：先剔除代码块与行内代码，再只认
 * `![[x.png]]` 与 `![alt](x.png)` 两种本地图片写法，外链与 svg 一律忽略。
 */

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpeg', 'jpg', 'gif', 'webp', 'avif']);

/** 与 Rust media.rs 的白名单、上限保持一致 */
export const GALLERY_ACCEPT =
  '.png,.jpg,.jpeg,.gif,.webp,.avif,image/png,image/jpeg,image/gif,image/webp,image/avif';
export const MAX_GALLERY_ASSETS = 400;
export const MAX_GALLERY_BYTES = 20 * 1024 * 1024;
export const ROOT_DIR_LABEL = '根目录';

export interface GalleryAsset {
  readonly path: string;
  readonly name: string;
  readonly hash: string;
  readonly mime: string;
  readonly bytes: number;
}

export interface GalleryDoc {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly text: string;
}

export interface GalleryItem {
  readonly asset: GalleryAsset;
  readonly docs: readonly GalleryDoc[];
}

export type GalleryFilter = 'all' | 'unused' | `dir:${string}`;

export interface GalleryFilterOption {
  readonly value: GalleryFilter;
  readonly label: string;
  readonly count: number;
}

/** 去掉代码块与行内代码：这两处的 `![[` / `![` 不是引用 */
const stripNonContent = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');

/** 归一化引用目标：去尖括号、去锚点/查询串、去 ./ 与前导斜杠、解百分号编码 */
const normalizeRef = (raw: string): string => {
  let target = raw.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  const cut = target.search(/[?#]/);
  if (cut >= 0) target = target.slice(0, cut);
  target = target.replace(/^\.\/+/, '').replace(/^\/+/, '');
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
};

const isLocalImage = (target: string): boolean => {
  if (target === '' || target.startsWith('//')) return false;
  // http:、https:、data:、file: 等带 scheme 的都算外链，不进图库关系
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  const slash = target.lastIndexOf('/');
  const dot = target.lastIndexOf('.');
  if (dot <= slash || dot === target.length - 1) return false;
  return IMAGE_EXTENSIONS.has(target.slice(dot + 1).toLowerCase());
};

const baseName = (target: string): string => {
  const slash = target.lastIndexOf('/');
  return slash >= 0 ? target.slice(slash + 1) : target;
};

/** 扫描正文里的本地图片引用，保持出现顺序并去重 */
export const parseImageRefs = (text: string): readonly string[] => {
  const source = stripNonContent(text);
  const refs: string[] = [];
  const push = (raw: string): void => {
    const target = normalizeRef(raw);
    if (!isLocalImage(target) || refs.includes(target)) return;
    refs.push(target);
  };

  for (const match of source.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
    const inner = match[1];
    if (inner === undefined) continue;
    const targetPart = inner.split('|')[0] ?? '';
    push(targetPart.split('#')[0] ?? '');
  }

  const markdownImage = /!\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;
  for (const match of source.matchAll(markdownImage)) {
    const target = match[1];
    if (target !== undefined) push(target);
  }

  return refs;
};

/** 图片 → 引用它的文档；同一文档多次引用只记一次。路径与文件名两种写法都能命中。 */
export const buildUsages = (
  assets: readonly GalleryAsset[],
  docs: readonly GalleryDoc[],
): ReadonlyMap<string, readonly GalleryDoc[]> => {
  const byPath = new Map<string, GalleryAsset>();
  const byName = new Map<string, GalleryAsset>();
  for (const asset of assets) {
    byPath.set(asset.path.toLowerCase(), asset);
    byName.set(asset.name.toLowerCase(), asset);
  }

  const usages = new Map<string, GalleryDoc[]>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const ref of parseImageRefs(doc.text)) {
      const key = ref.toLowerCase();
      const asset = byPath.get(key) ?? byName.get(baseName(key));
      if (asset === undefined || seen.has(asset.path)) continue;
      seen.add(asset.path);
      const list = usages.get(asset.path) ?? [];
      list.push(doc);
      usages.set(asset.path, list);
    }
  }
  return usages;
};

export const galleryItems = (
  assets: readonly GalleryAsset[],
  docs: readonly GalleryDoc[],
): readonly GalleryItem[] => {
  const usages = buildUsages(assets, docs);
  return assets.map((asset) => ({ asset, docs: usages.get(asset.path) ?? [] }));
};

/** 顶层目录：无斜杠的文件归到根目录（空串） */
export const topLevelDir = (path: string): string => {
  const slash = path.indexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

/** 筛选选项：全部 → 各顶层目录 → 未引用。计数 = 命中的图片张数。 */
export const buildFilters = (items: readonly GalleryItem[]): readonly GalleryFilterOption[] => {
  const dirs = new Map<string, number>();
  let unused = 0;

  for (const item of items) {
    if (item.docs.length === 0) {
      unused += 1;
      continue;
    }
    const seen = new Set<string>();
    for (const doc of item.docs) {
      const dir = topLevelDir(doc.path);
      if (seen.has(dir)) continue;
      seen.add(dir);
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }

  const options: GalleryFilterOption[] = [{ value: 'all', label: '全部', count: items.length }];
  for (const dir of [...dirs.keys()].sort((left, right) => left.localeCompare(right))) {
    options.push({
      value: `dir:${dir}`,
      label: dir === '' ? ROOT_DIR_LABEL : dir,
      count: dirs.get(dir) ?? 0,
    });
  }
  if (unused > 0) options.push({ value: 'unused', label: '未引用', count: unused });
  return options;
};

export const isGalleryFilter = (value: string): value is GalleryFilter =>
  value === 'all' || value === 'unused' || value.startsWith('dir:');

/** 按目录与关键词过滤；关键词命中文件名（含 hash）或引用文档的标题/路径 */
export const filterGallery = (
  items: readonly GalleryItem[],
  filter: GalleryFilter,
  query: string,
): readonly GalleryItem[] => {
  const keyword = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter === 'unused') {
      if (item.docs.length > 0) return false;
    } else if (filter.startsWith('dir:')) {
      const dir = filter.slice('dir:'.length);
      if (!item.docs.some((doc) => topLevelDir(doc.path) === dir)) return false;
    }
    if (keyword === '') return true;
    if (item.asset.name.toLowerCase().includes(keyword)) return true;
    return item.docs.some(
      (doc) => doc.title.toLowerCase().includes(keyword) || doc.path.toLowerCase().includes(keyword),
    );
  });
};

/** 文件名是 64 位 hash，界面上只展示前 8 位 */
export const displayName = (name: string): string => {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  const stem = name.slice(0, dot);
  return `${stem.slice(0, 8)}${stem.length > 8 ? '…' : ''}.${name.slice(dot + 1)}`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};
