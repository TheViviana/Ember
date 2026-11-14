import type { DocMeta } from '../../kernel/types.ts';

/**
 * 文档路径的树形视图（纯函数，不依赖 React / 内核）。
 * 磁盘上 `notes/<子目录>/<文件>.md` 按 `/` 切段成树；文件夹优先 + 自然序（`2` 在 `10` 前）。
 * 查询非空时面板回退扁平平铺结果，不走这里。
 */

export type DocTreeEntry =
  | {
      readonly kind: 'folder';
      readonly name: string;
      readonly path: string;
      readonly children: readonly DocTreeEntry[];
    }
  | { readonly kind: 'doc'; readonly name: string; readonly meta: DocMeta };

/** 展开后的可见行：文件夹行与文档行共用一份索引，便于复用哨兵分批渲染 */
export type DocTreeRow =
  | { readonly kind: 'folder'; readonly name: string; readonly path: string; readonly depth: number }
  | { readonly kind: 'doc'; readonly name: string; readonly depth: number; readonly meta: DocMeta };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 自然字母序：数字段按数值比较，`2` 排在 `10` 前 */
export const compareNatural = (left: string, right: string): number => collator.compare(left, right);

/** 文档所在目录；库根文档返回空串 */
export const parentDirOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

/** 文件名（最后一个路径段） */
export const baseNameOf = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
};

/** 目录 + 文件名 → 路径；空目录即库根 */
export const joinDirPath = (dir: string, fileName: string): string =>
  dir.length === 0 ? fileName : `${dir}/${fileName}`;

interface FolderBuilder {
  readonly name: string;
  readonly path: string;
  readonly folders: Map<string, FolderBuilder>;
  readonly docs: DocMeta[];
}

const createBuilder = (name: string, path: string): FolderBuilder => ({
  name,
  path,
  folders: new Map(),
  docs: [],
});

const toEntries = (folder: FolderBuilder): readonly DocTreeEntry[] => {
  const folders = [...folder.folders.values()]
    .sort((left, right) => compareNatural(left.name, right.name))
    .map<DocTreeEntry>((child) => ({
      kind: 'folder',
      name: child.name,
      path: child.path,
      children: toEntries(child),
    }));
  const docs = [...folder.docs]
    .sort((left, right) => compareNatural(left.title, right.title))
    .map<DocTreeEntry>((meta) => ({ kind: 'doc', name: meta.title, meta }));
  // 文件夹优先：先列全部子目录，再列本层文档
  return [...folders, ...docs];
};

/** 文档清单 → 树。路径为空或只有文件名的条目落在根层 */
export const buildTree = (documents: readonly DocMeta[]): readonly DocTreeEntry[] => {
  const root = createBuilder('', '');
  for (const meta of documents) {
    const segments = String(meta.path).split('/');
    const fileName = segments[segments.length - 1] ?? '';
    if (fileName.length === 0) continue;
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      if (segment.length === 0) continue;
      const path = cursor.path.length === 0 ? segment : `${cursor.path}/${segment}`;
      let child = cursor.folders.get(segment);
      if (child === undefined) {
        child = createBuilder(segment, path);
        cursor.folders.set(segment, child);
      }
      cursor = child;
    }
    cursor.docs.push(meta);
  }
  return toEntries(root);
};

/** 全部文件夹路径：用于过滤已失效的展开记忆 */
export const collectFolderPaths = (entries: readonly DocTreeEntry[]): readonly string[] => {
  const paths: string[] = [];
  const walk = (list: readonly DocTreeEntry[]): void => {
    for (const entry of list) {
      if (entry.kind !== 'folder') continue;
      paths.push(entry.path);
      walk(entry.children);
    }
  };
  walk(entries);
  return paths;
};

/** 按展开状态压平成可见行（折叠的文件夹只保留自己那一行） */
export const flattenTree = (
  entries: readonly DocTreeEntry[],
  isExpanded: (path: string) => boolean,
): readonly DocTreeRow[] => {
  const rows: DocTreeRow[] = [];
  const walk = (list: readonly DocTreeEntry[], depth: number): void => {
    for (const entry of list) {
      if (entry.kind === 'folder') {
        rows.push({ kind: 'folder', name: entry.name, path: entry.path, depth });
        if (isExpanded(entry.path)) walk(entry.children, depth + 1);
      } else {
        rows.push({ kind: 'doc', name: entry.name, depth, meta: entry.meta });
      }
    }
  };
  walk(entries, 0);
  return rows;
};
