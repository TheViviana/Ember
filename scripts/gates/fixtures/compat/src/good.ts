// 注释里提到 array.toSorted() 与 Object.groupBy() 不算真的使用
/* 块注释里的 URL.parse() 同样不算 */
export const note = '文案里出现 arr.toSorted() 与 Object.groupBy() 也只是一段字符串';

export const template = (count: number): string => `共 ${count} 条，避免 arr.toSorted() 这样的文案`;

export const union = (left: string[], right: string[]): string[] => [...new Set([...left, ...right])];
