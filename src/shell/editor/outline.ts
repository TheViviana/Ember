/**
 * 编辑器大纲的纯函数：从 Markdown 正文提取标题，并按滚动位置定位当前标题。
 * 只处理 ATX 标题（`#` 开头），并跳过围栏代码块里的伪标题；
 * 正文不含 frontmatter（由 splitFrontmatter 在打开时剥离）。
 */

export interface OutlineHeading {
  /** 1–6，对应 `#` 到 `######` */
  readonly level: number;
  /** 去掉结尾闭合 # 之后的标题文本，可能为空字符串 */
  readonly text: string;
  /** 1 基行号，用于跳转 */
  readonly line: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;

/** 提取标题；代码块（``` / ~~~，可带信息串）里的行一律忽略。 */
export const collectOutline = (source: string): readonly OutlineHeading[] => {
  const lines = source.split(/\r?\n/);
  const headings: OutlineHeading[] = [];
  let fenceChar: string | null = null;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    const marker = fence?.[1] ?? '';
    const info = fence?.[2] ?? '';

    if (fenceChar !== null) {
      // 闭合围栏：同字符、长度不短于开启围栏，且后面只有空白
      if (marker !== '' && marker[0] === fenceChar && marker.length >= fenceLength && info.trim() === '') {
        fenceChar = null;
      }
      continue;
    }

    if (marker !== '') {
      fenceChar = marker[0] ?? null;
      fenceLength = marker.length;
      continue;
    }

    const match = ATX.exec(line);
    if (match === null) continue;
    const raw = (match[2] ?? '').replace(CLOSING_HASHES, '').trim();
    headings.push({ level: (match[1] ?? '').length, text: raw, line: index + 1 });
  }

  return headings;
};

/**
 * 当前滚动位置对应的标题下标：取最后一个起始行不晚于 topLine 的标题。
 * 视口在任何标题之前时返回 -1。
 */
export const activeOutlineIndex = (
  headings: readonly OutlineHeading[],
  topLine: number,
): number => {
  let low = 0;
  let high = headings.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const heading = headings[mid];
    if (heading === undefined) break;
    if (heading.line <= topLine) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};
