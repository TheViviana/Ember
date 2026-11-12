/**
 * 用户标题 → 可落盘文件名（不含扩展名）的唯一实现。
 *
 * 规则（三处调用点此前各自复制、略有分歧，现统一到这里）：
 * - 路径分隔符与所有控制字符替换为空格，连续空白折叠为单个空格；
 * - 去掉前导 `.`：否则会生成 `.foo.md` 这类被扫描当作隐藏文件跳过的文档；
 * - 空标题（或清完只剩空白/点）回落调用方给的 fallback；
 * - 按字符数截断到 maxLength。
 *
 * 长度上限与 fallback 文案由调用点显式传入，保持各入口原有的命名观感。
 */
export interface SafeFileNameOptions {
  /** 归一化后为空时使用的兜底文件名 */
  readonly fallback: string;
  /** 字符上限（不含扩展名） */
  readonly maxLength: number;
}

const UNSAFE_CHARS = '\\/:*?"<>|';

export const safeFileName = (title: string, options: SafeFileNameOptions): string => {
  const cleaned = [...title]
    .map((char) => (UNSAFE_CHARS.includes(char) || char.charCodeAt(0) < 32 ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    // 前导点连同夹在点之间的空白一并剥掉：`.a`、`..a`、`. . a` 都得到 `a`，
    // 否则会生成被扫描当作隐藏文件跳过文档
    .replace(/^[.\s]+/, '');
  const truncated = cleaned.slice(0, options.maxLength).trimEnd();
  return truncated.length === 0 ? options.fallback : truncated;
};
