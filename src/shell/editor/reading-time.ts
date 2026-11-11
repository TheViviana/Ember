/**
 * 阅读时长估算：CJK 字符按 300 字/分钟，其余文本按空白分词、200 词/分钟。
 * 结果向上取整且最少 1 分钟；空正文（或纯空白/纯标点）返回 null。
 */

export const CJK_PER_MINUTE = 300;
export const WORDS_PER_MINUTE = 200;

const CJK_CHAR = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

export const estimateReadingMinutes = (text: string): number | null => {
  let cjk = 0;
  const rest: string[] = [];
  // 按码点遍历：CJK 扩展区（代理对）也只算一个字
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else rest.push(char);
  }

  // 非 CJK 部分按空白分词；纯标点 token 不算词
  const words = rest
    .join('')
    .split(/\s+/)
    .filter((token) => WORD_CHAR.test(token)).length;

  if (cjk === 0 && words === 0) return null;
  return Math.max(1, Math.ceil(cjk / CJK_PER_MINUTE + words / WORDS_PER_MINUTE));
};
