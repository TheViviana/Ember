/**
 * 搜索分词：中文按词组（相邻二元组）切分，不依赖外部词典（vault-format §9 选项 C）。
 *
 * 规则：
 * - 拉丁/数字连续段 → 一个小写词；
 * - CJK 连续段 → 全部相邻二元组；长度为 1 的段保留单字；
 * - 其余字符视为分隔符。
 * 索引侧同时收录单字与二元组，保证单字查询也能命中；查询侧 CJK 段长度 ≥2 时
 * 只产生二元组（AND 语义下等价于词组匹配），长度 1 时退化为单字。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const WORD = /[a-zA-Z0-9]/;

const isCjk = (char: string): boolean => CJK.test(char);
const isWordChar = (char: string): boolean => WORD.test(char);

/** 段类型切分：把文本切成 (类型, 片段) 序列 */
const segments = (text: string): readonly { readonly kind: 'cjk' | 'word'; readonly value: string }[] => {
  const out: { kind: 'cjk' | 'word'; value: string }[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (isCjk(char)) {
      const start = index;
      while (index < text.length && isCjk(text[index] as string)) index += 1;
      out.push({ kind: 'cjk', value: text.slice(start, index) });
      continue;
    }
    if (isWordChar(char)) {
      const start = index;
      while (index < text.length && isWordChar(text[index] as string)) index += 1;
      out.push({ kind: 'word', value: text.slice(start, index).toLowerCase() });
      continue;
    }
    index += 1;
  }
  return out;
};

/** CJK 段的词组集合：全部相邻二元组 + 段长为 1 时的单字 */
const cjkTerms = (value: string, unigrams: boolean): readonly string[] => {
  if (value.length === 1) return [value];
  const terms: string[] = [];
  if (unigrams) {
    for (const char of value) terms.push(char);
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    terms.push(value.slice(i, i + 2));
  }
  return terms;
};

/**
 * 索引侧分词：单字 + 二元组 + 拉丁词。
 * 返回去重后的词集合（调用方直接放进 Set）。
 */
export const tokenizeForIndex = (text: string): readonly string[] => {
  const terms = new Set<string>();
  for (const segment of segments(text)) {
    if (segment.kind === 'word') {
      if (segment.value.length > 0) terms.add(segment.value);
      continue;
    }
    for (const term of cjkTerms(segment.value, true)) terms.add(term);
  }
  return [...terms];
};

/**
 * 查询侧分词：CJK 段只取二元组（长度 1 保留单字），拉丁词同索引侧。
 * 空查询返回空数组（调用方按「匹配一切」处理）。
 */
export const tokenizeForQuery = (text: string): readonly string[] => {
  const terms: string[] = [];
  for (const segment of segments(text)) {
    if (segment.kind === 'word') {
      if (segment.value.length > 0) terms.push(segment.value);
      continue;
    }
    for (const term of cjkTerms(segment.value, false)) terms.push(term);
  }
  return terms;
};
