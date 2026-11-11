/**
 * 品牌类型：把结构性相同的字符串区分开，避免 DocId 与普通路径混用。
 * 仅存在于类型层，运行期就是 string，跨 IPC 零成本。
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };
