/**
 * 跨文档查找替换的纯函数层：字面量匹配（可忽略大小写）、逐文档替换计划。
 * 只处理 frontmatter 之后的正文，绝不触碰元数据；替换是整段重写正文，
 * 落盘走 docs.update + base revision（他人先改时按冲突跳过，不覆盖）。
 */

export interface ReplaceSourceDoc {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  /** frontmatter 之后的正文 */
  readonly body: string;
}

export interface ReplaceOccurrence {
  /** 正文内偏移（JS string 索引） */
  readonly from: number;
  readonly to: number;
  /** 命中所在 1 基行号 */
  readonly line: number;
  /** 命中行文本（截断到 120 字符，供预览） */
  readonly lineText: string;
}

export interface ReplacePlanItem {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly occurrences: readonly ReplaceOccurrence[];
  readonly newBody: string;
}

export interface ReplacePlan {
  readonly items: readonly ReplacePlanItem[];
  readonly totalOccurrences: number;
}

/** 找出正文中所有字面量命中；query 为空或正文不含时返回空数组 */
export const findOccurrences = (
  body: string,
  query: string,
  ignoreCase: boolean,
): ReplaceOccurrence[] => {
  if (query.length === 0) return [];
  const haystack = ignoreCase ? body.toLowerCase() : body;
  const needle = ignoreCase ? query.toLowerCase() : query;
  const occurrences: ReplaceOccurrence[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const line = body.slice(0, at).split('\n').length;
    const lineStart = body.lastIndexOf('\n', at - 1) + 1;
    const lineEnd = body.indexOf('\n', at);
    const lineText = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).slice(0, 120);
    occurrences.push({ from: at, to: at + query.length, line, lineText });
    from = at + needle.length;
  }
  return occurrences;
};

/** 倒序应用替换：偏移从后往前不动前面 */
const applyOccurrences = (body: string, occurrences: readonly ReplaceOccurrence[], replacement: string): string => {
  let result = body;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    if (occurrence === undefined) continue;
    result = result.slice(0, occurrence.from) + replacement + result.slice(occurrence.to);
  }
  return result;
};

export const planReplace = (
  docs: readonly ReplaceSourceDoc[],
  query: string,
  replacement: string,
  ignoreCase: boolean,
): ReplacePlan => {
  const items: ReplacePlanItem[] = [];
  let total = 0;
  for (const doc of docs) {
    const occurrences = findOccurrences(doc.body, query, ignoreCase);
    if (occurrences.length === 0) continue;
    total += occurrences.length;
    items.push({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      occurrences,
      newBody: applyOccurrences(doc.body, occurrences, replacement),
    });
  }
  return { items, totalOccurrences: total };
};
