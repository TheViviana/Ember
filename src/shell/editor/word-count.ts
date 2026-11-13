/**
 * 字数统计：CJK 字符（含日文假名与韩文）每字计 1，其余按空白分词、含字母或数字的词计 1。
 * 与阅读时长的口径一致（reading-time.ts），空正文（纯空白/纯标点）返回 null 不展示。
 */

const CJK_CHAR = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export interface WordCount {
  /** CJK 字符数 */
  readonly chars: number;
  /** 非 CJK 词数（按空白分词） */
  readonly words: number;
  /** 状态栏展示总数：CJK 字 + 非 CJK 词 */
  readonly total: number;
}

export const countWords = (text: string): WordCount | null => {
  let chars = 0;
  const rest: string[] = [];
  // 按码点遍历：CJK 扩展区（代理对）也只算一个字
  for (const char of text) {
    if (CJK_CHAR.test(char)) chars += 1;
    else rest.push(char);
  }
  const words = rest
    .join('')
    .split(/\s+/)
    .filter((token) => WORD_CHAR.test(token)).length;
  if (chars === 0 && words === 0) return null;
  return { chars, words, total: chars + words };
};
