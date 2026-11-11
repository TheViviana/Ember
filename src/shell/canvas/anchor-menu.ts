/**
 * 「添加文章…」的目录派生：只消费 docs.list() 的 DocMeta.path，
 * 不新增 VaultPort 方法，也不另开读盘路径。
 */

export interface AnchorDocInput {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface AnchorDoc {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

export interface AnchorFolder {
  readonly name: string;
  readonly path: string;
  readonly folders: readonly AnchorFolder[];
  readonly docs: readonly AnchorDoc[];
}

export interface AnchorListing {
  /** 当前层过滤后的子文件夹 */
  readonly folders: readonly AnchorFolder[];
  /** 当前层过滤后的文章 */
  readonly docs: readonly AnchorDoc[];
  /** 当前层（未过滤）是否既无子文件夹也无文章 */
  readonly empty: boolean;
}

const compareLabel = (a: { readonly name?: string; readonly title?: string }, b: { readonly name?: string; readonly title?: string }): number =>
  (a.name ?? a.title ?? '').localeCompare(b.name ?? b.title ?? '', 'zh-Hans-CN');

const splitPath = (path: string): readonly string[] =>
  path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

interface MutableFolder {
  name: string;
  path: string;
  folders: Map<string, MutableFolder>;
  docs: AnchorDoc[];
}

const createFolder = (name: string, path: string): MutableFolder => ({
  name,
  path,
  folders: new Map(),
  docs: [],
});

const freezeFolder = (folder: MutableFolder): AnchorFolder => ({
  name: folder.name,
  path: folder.path,
  folders: [...folder.folders.values()].map(freezeFolder).sort(compareLabel),
  docs: [...folder.docs].sort(compareLabel),
});

/** path 按 `/` 拆成目录树；目录顺序与文章标题均做稳定排序 */
export const buildAnchorTree = (docs: readonly AnchorDocInput[]): AnchorFolder => {
  const root = createFolder('', '');
  for (const doc of docs) {
    const segments = splitPath(doc.path);
    const fileName = segments[segments.length - 1] ?? doc.title;
    let cursor = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] ?? '';
      const path = segments.slice(0, index + 1).join('/');
      let child = cursor.folders.get(name);
      if (child === undefined) {
        child = createFolder(name, path);
        cursor.folders.set(name, child);
      }
      cursor = child;
    }
    cursor.docs.push({ id: doc.id, path: doc.path, title: doc.title.length > 0 ? doc.title : fileName });
  }
  return freezeFolder(root);
};

/** 按目录段下钻；路径不存在时返回 null */
export const folderAt = (
  root: AnchorFolder,
  segments: readonly string[],
): AnchorFolder | null => {
  let cursor = root;
  for (const segment of segments) {
    const next = cursor.folders.find((folder) => folder.name === segment);
    if (next === undefined) return null;
    cursor = next;
  }
  return cursor;
};

/** 当前层过滤：文件夹按名、文章按标题 / 完整 path，大小写不敏感 */
export const filterFolder = (folder: AnchorFolder, keyword: string): AnchorListing => {
  const needle = keyword.trim().toLowerCase();
  const empty = folder.folders.length === 0 && folder.docs.length === 0;
  if (needle.length === 0) {
    return { folders: folder.folders, docs: folder.docs, empty };
  }
  return {
    folders: folder.folders.filter((item) => item.name.toLowerCase().includes(needle)),
    docs: folder.docs.filter(
      (item) => item.title.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle),
    ),
    empty,
  };
};

export interface AnchorCrumb {
  readonly label: string;
  /** 0 = 根，n = 进入前 n 层 */
  readonly depth: number;
}

/** 面包屑：根 + 当前路径每一层 */
export const breadcrumbOf = (segments: readonly string[]): readonly AnchorCrumb[] => [
  { label: '全部文章', depth: 0 },
  ...segments.map((segment, index) => ({ label: segment, depth: index + 1 })),
];

/** 目录项展示名：去掉 .md 后缀，目录名原样 */
export const folderLabel = (folder: AnchorFolder): string =>
  folder.path.length === 0 ? '全部文章' : `${folder.name}/`;

export interface AnchorNav {
  readonly view: 'root' | 'browse' | 'docs';
  readonly segments: readonly string[];
  readonly keyword: string;
}

/** 空白松手才弹菜单：有命中目标（plan 能落地）时不弹 */
export const shouldOpenAnchorMenu = (
  targetNodeId: string | null,
  planExists: boolean,
): boolean => targetNodeId === null && !planExists;

/**
 * Esc 的逐级退回：先清过滤词，再退出文章列表 / 返回上一层目录 / 回到根菜单。
 * 返回 null 表示关闭菜单（根菜单再按 Esc），此时不应产生任何节点或连线。
 */
export const menuBack = (nav: AnchorNav): AnchorNav | null => {
  if (nav.keyword.length > 0) return { ...nav, keyword: '' };
  if (nav.view === 'docs') return { ...nav, view: 'browse' };
  if (nav.view === 'browse' && nav.segments.length > 0) {
    return { ...nav, segments: nav.segments.slice(0, -1) };
  }
  if (nav.view === 'browse') return { ...nav, view: 'root' };
  return null;
};
