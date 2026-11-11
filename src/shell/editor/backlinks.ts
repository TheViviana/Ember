import {
  buildResolutionIndex,
  extractLinks,
  parseMarkdown,
  resolveLink,
  splitFrontmatter,
  type DocId,
  type LinkTarget,
  type VaultPath,
} from '#doc-model';

/**
 * 反向链接的前端临时实现。
 * 索引服务目前是 `createPendingIndexPort` 的占位实现（available=false，
 * index-service 会直接抛 `index_unavailable`），因此这里用全库正文 + doc-model
 * 的统一 Markdown 管线自行扫描，语义与未来索引一致（路径→文件名→标题→别名）。
 * 索引接入后应改为 `kernel.index.backlinks(docId)`，本模块可整体删除。
 */
export interface BacklinkDoc {
  readonly id: DocId;
  readonly title: string;
  readonly path: VaultPath;
  readonly aliases: readonly string[];
  readonly text: string;
}

export interface BacklinkHit {
  readonly docId: DocId;
  readonly title: string;
  readonly path: VaultPath;
  /** 引用所在行（原文件行号，已计入 frontmatter 偏移） */
  readonly line: number;
  /** 原始写法，如 `[[目标|别名]]` */
  readonly raw: string;
  readonly anchor: string | null;
  readonly embed: boolean;
}

export interface BacklinkGroup {
  readonly docId: DocId;
  readonly title: string;
  readonly path: VaultPath;
  readonly hits: readonly BacklinkHit[];
}

const targetOf = (doc: BacklinkDoc): LinkTarget => ({
  id: doc.id,
  path: doc.path,
  title: doc.title,
  aliases: doc.aliases,
});

const displayTitle = (doc: BacklinkDoc): string => (doc.title.trim().length === 0 ? '未命名' : doc.title);

/**
 * 收集指向 `targetId` 的引用，按来源文档分组。
 * 只解析正文（跳过 frontmatter），代码块/行内代码由 AST 提取层天然排除；
 * 文档引用自身不计入。
 */
export const collectBacklinks = (
  docs: readonly BacklinkDoc[],
  targetId: DocId,
): readonly BacklinkGroup[] => {
  const index = buildResolutionIndex(docs.map(targetOf));
  const groups: BacklinkGroup[] = [];

  for (const doc of docs) {
    if (doc.id === targetId) continue;
    const split = splitFrontmatter(doc.text);
    const bodyStartLine = split.bodyOffset === 0
      ? 1
      : doc.text.slice(0, split.bodyOffset).split('\n').length;
    const tree = parseMarkdown(split.body);
    const links = extractLinks(tree, { bodyOffset: split.bodyOffset, bodyStartLine });

    const hits: BacklinkHit[] = [];
    for (const link of links) {
      const resolved = resolveLink(link, index);
      if (resolved.targetId !== targetId) continue;
      hits.push({
        docId: doc.id,
        title: displayTitle(doc),
        path: doc.path,
        line: link.line,
        raw: link.raw,
        anchor: link.anchor,
        embed: link.embed,
      });
    }

    if (hits.length === 0) continue;
    hits.sort((left, right) => left.line - right.line);
    groups.push({
      docId: doc.id,
      title: displayTitle(doc),
      path: doc.path,
      hits,
    });
  }

  groups.sort(
    (left, right) =>
      left.title.localeCompare(right.title, 'zh-Hans-CN') ||
      String(left.path).localeCompare(String(right.path)),
  );
  return groups;
};

/** 引用总条数（同一文档多次引用分别计数） */
export const countBacklinks = (groups: readonly BacklinkGroup[]): number =>
  groups.reduce((sum, group) => sum + group.hits.length, 0);
