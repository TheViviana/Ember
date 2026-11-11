import type { CanvasNode } from '#canvas-engine';

/** 未闭合的标签也按字符串处理：数字、null 一律丢弃 */
const toStrings = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) result.push(trimmed);
    }
  }
  return result;
};

/** note 取 node.meta.tags，doc 取文档自身的 tags；组节点不显示标签 */
export const resolveNodeTags = (
  kind: CanvasNode['kind'],
  meta: CanvasNode['meta'],
  docTags: readonly string[] | undefined,
): readonly string[] => {
  if (kind === 'doc') return toStrings(docTags);
  if (kind === 'note') return toStrings(meta.tags);
  return [];
};
